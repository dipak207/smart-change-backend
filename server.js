const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());

// Cashfree webhook will send JSON
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log("🔥 SERVER VERSION: CASHFREE + AMOUNT 10-101 + RESUME");

// ---------------------------------------------
// Helper: validate allowed amount
// ---------------------------------------------
function isValidAmount(amount) {
    return Number.isInteger(amount) && amount >= 10 && amount <= 101;
}

// ---------------------------------------------
// ROUTE: health
// ---------------------------------------------
app.get("/", (req, res) => {
    res.send("Smart Change Backend (Cashfree + Supabase) Running ✅");
});

// ---------------------------------------------
// ROUTE: ESP32 polling endpoint
// Returns OLDEST transaction not dispensed
// captured OR dispensing
// ---------------------------------------------
app.get("/latest-payment", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("transactions")
            .select("*")
            .in("status", ["captured", "dispensing"])
            .eq("dispensed", false)
            .order("created_at", { ascending: true })
            .limit(1);

        if (error) throw error;

        if (!data || data.length === 0) {
            return res.json({
                paid: false,
                amount: 0,
                txnid: null,
                dispensed_count: 0,
                status: null,
            });
        }

        const txn = data[0];

        return res.json({
            paid: true,
            amount: txn.amount,
            txnid: txn.txnid,
            dispensed_count: txn.dispensed_count || 0,
            status: txn.status,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------
// ROUTE: ESP32 starts dispensing (LOCK)
// ---------------------------------------------
app.post("/start-dispense", async (req, res) => {
    try {
        const { txnid } = req.body;
        if (!txnid) return res.status(400).json({ error: "txnid required" });

        const { data, error } = await supabase
            .from("transactions")
            .update({ status: "dispensing" })
            .eq("txnid", txnid)
            .select();

        if (error) throw error;

        return res.json({ ok: true, message: "Dispensing started", data });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------
// ROUTE: ESP32 updates progress after each coin
// ---------------------------------------------
app.post("/update-progress", async (req, res) => {
    try {
        const { txnid, dispensed_count } = req.body;

        if (!txnid) return res.status(400).json({ error: "txnid required" });
        if (dispensed_count === undefined)
            return res.status(400).json({ error: "dispensed_count required" });

        const { data, error } = await supabase
            .from("transactions")
            .update({ dispensed_count })
            .eq("txnid", txnid)
            .select();

        if (error) throw error;

        return res.json({ ok: true, message: "Progress updated", data });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------
// ROUTE: ESP32 marks as DISPENSED (SUCCESS)
// ---------------------------------------------
app.post("/mark-used", async (req, res) => {
    try {
        const { txnid } = req.body;
        if (!txnid) return res.status(400).json({ error: "txnid required" });

        const { data, error } = await supabase
            .from("transactions")
            .update({
                dispensed: true,
                status: "dispensed",
            })
            .eq("txnid", txnid)
            .select();

        if (error) throw error;

        return res.json({ ok: true, message: "Marked dispensed ✅", data });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------
// ROUTE: ESP32 marks as FAILED (JAM / EMPTY)
// ---------------------------------------------
app.post("/mark-failed", async (req, res) => {
    try {
        const { txnid } = req.body;
        if (!txnid) return res.status(400).json({ error: "txnid required" });

        const { data, error } = await supabase
            .from("transactions")
            .update({
                status: "failed",
            })
            .eq("txnid", txnid)
            .select();

        if (error) throw error;

        return res.json({ ok: true, message: "Marked failed ❌", data });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ============================================================
// DEBUG ROUTE: create fake transaction (10 to 101)
// Example:
// /fakepay?amount=25
// ============================================================
app.get("/fakepay", async (req, res) => {
    try {
        const amount = parseInt(req.query.amount || "10");

        if (!isValidAmount(amount)) {
            return res.status(400).json({
                ok: false,
                error: "Amount must be between 10 and 101",
            });
        }

        const txnid = "FAKE_" + Date.now();

        const { data, error } = await supabase.from("transactions").insert([
            {
                txnid,
                amount,
                status: "captured",
                dispensed: false,
                dispensed_count: 0,
                provider: "fake",
            },
        ]);

        if (error) throw error;

        return res.json({
            ok: true,
            message: "Fake payment inserted ✅",
            txnid,
            amount,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ============================================================
// CASHFREE WEBHOOK (NO SECRET VERIFICATION)
// Handles 3 events:
// 1) success payment
// 2) failed payment
// 3) user dropped payment
// ============================================================
app.post("/cashfree-webhook", async (req, res) => {
    try {
        const payload = req.body;

        const eventType = payload?.type || "UNKNOWN";
        const data = payload?.data;

        if (!data || !data.order) {
            return res.status(400).json({ error: "Invalid webhook payload" });
        }

        const orderId = data.order.order_id || null;
        const orderAmount = Math.round(Number(data.order.order_amount || 0));

        const cfPaymentId = data.payment?.cf_payment_id || null;
        const paymentStatus = data.payment?.payment_status || null;

        // txnid rule:
        // Use order_id as unique txnid (best)
        // because webhook always has order_id
        const txnid = orderId;

        console.log("📩 Cashfree Webhook:", eventType, "orderId:", orderId);

        // ---------------------------------------
        // EVENT: PAYMENT SUCCESS
        // ---------------------------------------
        if (eventType === "PAYMENT_SUCCESS_WEBHOOK") {
            if (!isValidAmount(orderAmount)) {
                console.log("⚠️ Invalid amount ignored:", orderAmount);
                return res.json({ ok: true, ignored: true });
            }

            // Insert into DB if not exists
            // If exists, update status back to captured
            const { data: existing } = await supabase
                .from("transactions")
                .select("*")
                .eq("txnid", txnid)
                .limit(1);

            if (existing && existing.length > 0) {
                // Update existing
                const { error } = await supabase
                    .from("transactions")
                    .update({
                        amount: orderAmount,
                        status: "captured",
                        dispensed: false,
                        provider: "cashfree",
                        order_id: orderId,
                        event_type: eventType,
                        payment_status: paymentStatus,
                        cf_payment_id: cfPaymentId,
                    })
                    .eq("txnid", txnid);

                if (error) throw error;

                console.log("🔁 Updated existing transaction:", txnid);
            } else {
                // Insert new
                const { error } = await supabase.from("transactions").insert([
                    {
                        txnid,
                        amount: orderAmount,
                        status: "captured",
                        dispensed: false,
                        dispensed_count: 0,
                        provider: "cashfree",
                        order_id: orderId,
                        event_type: eventType,
                        payment_status: paymentStatus,
                        cf_payment_id: cfPaymentId,
                    },
                ]);

                if (error) throw error;

                console.log("✅ Inserted new transaction:", txnid);
            }
        }

        // ---------------------------------------
        // EVENT: PAYMENT FAILED
        // ---------------------------------------
        if (eventType === "PAYMENT_FAILED_WEBHOOK") {
            const { error } = await supabase
                .from("transactions")
                .update({
                    status: "failed",
                    provider: "cashfree",
                    order_id: orderId,
                    event_type: eventType,
                    payment_status: paymentStatus,
                    cf_payment_id: cfPaymentId,
                })
                .eq("txnid", txnid);

            // If row doesn't exist, ignore
            if (error) console.log("⚠️ Failed update error:", error.message);

            console.log("❌ Marked failed:", txnid);
        }

        // ---------------------------------------
        // EVENT: USER DROPPED PAYMENT
        // ---------------------------------------
        if (eventType === "PAYMENT_USER_DROPPED_WEBHOOK") {
            const { error } = await supabase
                .from("transactions")
                .update({
                    status: "dropped",
                    provider: "cashfree",
                    order_id: orderId,
                    event_type: eventType,
                    payment_status: paymentStatus,
                    cf_payment_id: cfPaymentId,
                })
                .eq("txnid", txnid);

            if (error) console.log("⚠️ Dropped update error:", error.message);

            console.log("🚫 User dropped payment:", txnid);
        }

        return res.json({ ok: true });
    } catch (err) {
        console.log("Webhook error:", err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------
// START SERVER
// ---------------------------------------------
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
