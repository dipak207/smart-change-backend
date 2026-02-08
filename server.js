const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json()); // express.json() is built-in, no need for body-parser separately

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Cashfree Config (Sandbox/Test Mode)
const CF_URL = "https://sandbox.cashfree.com/pg/orders";
const CF_HEADERS = {
    // FIX: Match these to your .env variable names
    "x-client-id": process.env.CASHFREE_CLIENT_ID,
    "x-client-secret": process.env.CASHFREE_CLIENT_SECRET,
    "x-api-version": "2023-08-01",
    "Content-Type": "application/json"
};

// Helper: validate allowed amount
function isValidAmount(amount) {
    return Number.isInteger(amount) && amount >= 10 && amount <= 101;
}

app.get("/", (req, res) => res.send("Coin Machine Backend Active ✅"));

// ---------------------------------------------
// INITIATE PAYMENT
// ---------------------------------------------
app.post("/create-order", async (req, res) => {
    try {
        const { amount } = req.body;
        if (!isValidAmount(amount)) return res.status(400).json({ error: "Amount must be 10-101" });

        const orderId = "ORD_" + Date.now();
        const response = await axios.post(CF_URL, {
            order_id: orderId,
            order_amount: amount,
            order_currency: "INR",
            customer_details: {
                customer_id: "customer_1",
                customer_phone: "9999999999"
            },
            order_meta: {
                // Ensure this matches your actual Render URL
                notify_url: "https://smart-change-backend.onrender.com/cashfree-webhook"
            }
        }, { headers: CF_HEADERS });

        res.json({ success: true, payment_link: response.data.payment_link, order_id: orderId });
    } catch (err) {
        console.error("Order Error:", err.response?.data || err.message);
        res.status(500).json({ error: "Cashfree Order Failed" });
    }
});

// ---------------------------------------------
// CASHFREE WEBHOOK (Fixed for Dashboard Test)
// ---------------------------------------------
app.post("/cashfree-webhook", async (req, res) => {
    // STEP 1: Respond to Cashfree immediately to prevent "Endpoint not responding" error
    res.status(200).send("OK");

    // STEP 2: Process the payload after sending the response
    const { type, data } = req.body;

    // Handle the dashboard test (which doesn't have data.order)
    if (!data || !data.order) {
        console.log("Received a Test/Empty webhook from Cashfree dashboard.");
        return;
    }

    if (type === "PAYMENT_SUCCESS_WEBHOOK") {
        const txnid = data.order.order_id;
        const amount = Math.round(Number(data.order.order_amount));

        const { error } = await supabase.from("transactions").upsert({
            txnid,
            amount,
            status: "captured",
            dispensed: false,
            dispensed_count: 0,
            provider: "cashfree"
        }, { onConflict: 'txnid' });

        if (error) console.error("Supabase Error:", error.message);
        else console.log(`✅ Payment Success for ${txnid}. Amount: ${amount}`);
    }
});

// ---------------------------------------------
// ESP32 POLLING & UPDATES
// ---------------------------------------------
app.get("/latest-payment", async (req, res) => {
    const { data, error } = await supabase
        .from("transactions")
        .select("*")
        .in("status", ["captured", "dispensing"])
        .eq("dispensed", false)
        .order("created_at", { ascending: true })
        .limit(1);

    if (error || !data.length) return res.json({ paid: false });
    const txn = data[0];
    res.json({ paid: true, amount: txn.amount, txnid: txn.txnid, dispensed_count: txn.dispensed_count || 0 });
});

app.post("/update-progress", async (req, res) => {
    const { txnid, dispensed_count } = req.body;
    await supabase.from("transactions").update({ dispensed_count, status: 'dispensing' }).eq('txnid', txnid);
    res.json({ success: true });
});

app.post("/mark-used", async (req, res) => {
    const { txnid } = req.body;
    await supabase.from("transactions").update({ status: "dispensed", dispensed: true }).eq("txnid", txnid);
    res.json({ success: true });
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Standalone Backend Online"));