const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. Debug: Log Environment Variable Status (DO NOT LOG ACTUAL KEYS)
console.log("--- SYSTEM STARTUP ---");
console.log("Supabase URL Configured:", !!process.env.SUPABASE_URL);
console.log("Cashfree ID Configured:", !!process.env.CASHFREE_CLIENT_ID);
console.log("-----------------------");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CF_URL = "https://sandbox.cashfree.com/pg/orders";
const CF_HEADERS = {
    "x-client-id": process.env.CASHFREE_CLIENT_ID,
    "x-client-secret": process.env.CASHFREE_CLIENT_SECRET,
    "x-api-version": "2023-08-01",
    "Content-Type": "application/json"
};

function isValidAmount(amount) {
    return Number.isInteger(amount) && amount >= 10 && amount <= 101;
}

app.get("/", (req, res) => res.send("Coin Machine Backend Active ✅"));

// ---------------------------------------------
// INITIATE PAYMENT (Debugged)
// ---------------------------------------------
app.post("/create-order", async (req, res) => {
    const { amount } = req.body;
    console.log(`[CREATE-ORDER] Request received for amount: ${amount}`);

    if (!isValidAmount(amount)) {
        console.warn("[CREATE-ORDER] Invalid amount rejected.");
        return res.status(400).json({ error: "Amount must be 10-101" });
    }

    try {
        const orderId = "ORD_" + Date.now();
        console.log(`[CREATE-ORDER] Attempting Cashfree order: ${orderId}`);

        const response = await axios.post(CF_URL, {
            order_id: orderId,
            order_amount: amount,
            order_currency: "INR",
            customer_details: {
                customer_id: "customer_1",
                customer_phone: "9999999999"
            },
            order_meta: {
                notify_url: "https://smart-change-backend.onrender.com/cashfree-webhook"
            }
        }, { headers: CF_HEADERS });

        console.log("[CREATE-ORDER] Success! Link generated.");
        res.json({ success: true, payment_link: response.data.payment_link, order_id: orderId });

    } catch (err) {
        // Detailed Debugging for Cashfree Errors
        const errorData = err.response?.data || err.message;
        console.error("[CREATE-ORDER] FAILED:", JSON.stringify(errorData, null, 2));

        res.status(500).json({
            error: "Cashfree Order Failed",
            debug_info: errorData // This sends the real error back to Postman
        });
    }
});

// ---------------------------------------------
// WEBHOOK (Debugged)
// ---------------------------------------------
app.post("/cashfree-webhook", async (req, res) => {
    console.log("[WEBHOOK] Signal received from Cashfree.");
    res.status(200).send("OK"); // Respond immediately

    const { type, data } = req.body;
    console.log(`[WEBHOOK] Event Type: ${type}`);

    if (!data || !data.order) {
        console.log("[WEBHOOK] Test or malformed payload detected. Skipping DB update.");
        return;
    }

    if (type === "PAYMENT_SUCCESS_WEBHOOK") {
        const txnid = data.order.order_id;
        const amount = Math.round(Number(data.order.order_amount));

        console.log(`[WEBHOOK] Payment Verified for ${txnid}. Updating Supabase...`);

        const { error } = await supabase.from("transactions").upsert({
            txnid,
            amount,
            status: "captured",
            dispensed: false,
            dispensed_count: 0,
            provider: "cashfree"
        }, { onConflict: 'txnid' });

        if (error) {
            console.error("[WEBHOOK] Supabase Error:", error.message);
        } else {
            console.log(`[WEBHOOK] Database updated successfully for ${txnid}.`);
        }
    }
});

// ---------------------------------------------
// POLLING (Debugged)
// ---------------------------------------------
app.get("/latest-payment", async (req, res) => {
    console.log("[POLLING] Checking for pending payments...");

    const { data, error } = await supabase
        .from("transactions")
        .select("*")
        .in("status", ["captured", "dispensing"])
        .eq("dispensed", false)
        .order("created_at", { ascending: true })
        .limit(1);

    if (error) {
        console.error("[POLLING] DB Error:", error.message);
        return res.status(500).json({ error: error.message });
    }

    if (!data.length) {
        return res.json({ paid: false });
    }

    console.log(`[POLLING] Found active payment: ${data[0].txnid}`);
    res.json({ paid: true, ...data[0] });
});

app.listen(process.env.PORT || 3000, () => {
    console.log("🚀 Server is live and debugging is ACTIVE");
});