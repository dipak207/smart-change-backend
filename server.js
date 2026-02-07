const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

console.log("🔥 SERVER VERSION: CASHFREE + SUPABASE + DISPENSE FLOW");

const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());

// Cashfree webhook (raw)
app.use("/cashfree-webhook", bodyParser.raw({ type: "application/json" }));

// Normal JSON routes
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// Supabase client
if (!process.env.SUPABASE_URL) {
    console.log("❌ SUPABASE_URL missing in env!");
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("❌ SUPABASE_SERVICE_ROLE_KEY missing in env!");
}

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------- HOME ----------------
app.get("/", (req, res) => {
    res.send("Smart Change Backend + Supabase + Cashfree Running ✅");
});

// ---------------- ESP32: GET LATEST PAYMENT ----------------
// Returns oldest txn which is captured/dispensing but not dispensed
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

        res.json({
            paid: true,
            amount: txn.amount,
            txnid: txn.txnid,
            dispensed_count: txn.dispensed_count || 0,
            status: txn.status,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------- ESP32: START DISPENSE (LOCK) ----------------
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

        res.json({ ok: true, message: "Dispensing started", data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------- ESP32: UPDATE PROGRESS ----------------
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

        res.json({ ok: true, message: "Progress updated", data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------- ESP32: MARK DISPENSED ----------------
app.post("/mark-used", async (req, res) => {
    try {
        const { txnid } = req.body;

        if (!txnid) return res.status(400).json({ error: "txnid required" });

        const { data, error } = await supabase
            .from("transactions")
            .update({ dispensed: true, status: "dispensed" })
            .eq("txnid", txnid)
            .select();

        if (error) throw error;

        res.json({ ok: true, message: "Marked dispensed ✅", data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------- ESP32: MARK FAILED ----------------
app.post("/mark-failed", async (req, res) => {
    try {
        const { txnid } = req.body;

        if (!txnid) return res.status(400).json({ error: "txnid required" });

        const { data, error } = await supabase
            .from("transactions")
            .update({ status: "failed" })
            .eq("txnid", txnid)
            .select();

        if (error) throw error;

        res.json({ ok: true, message: "Marked failed ❌", data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------- DEBUG: INSERT FAKE PAYMENT ----------------
app.get("/fakepay", async (req, res) => {
    try {
        const txnid = "FAKE_" + Date.now();
        const amount = 10;

        const { data, error } = await supabase
            .from("transactions")
            .insert([
                {
                    txnid,
                    amount,
                    status: "captured",
                    dispensed: false,
                    dispensed_count: 0,
                    provider: "fake",
                    order_id: null,
                },
            ])
            .select();

        if (error) throw error;

        res.json({
            ok: true,
            message: "Fake payment inserted into Supabase ✅",
            txnid,
            amount,
            row: data,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ======================================================
// CASHFREE WEBHOOK (NO SECRET CHECK - TEST ONLY)
// ======================================================
app.post("/cashfree-webhook", async (req, res) => {
    try {
        const event = JSON.parse(req.body.toString());

        console.log("✅ Cashfree webhook received:", event.type);

        const type = event.type;
        const data = event.data;

        if (!data || !data.payment) {
            return res.status(400).json({ error: "Invalid payload" });
        }

        const cf_payment_id = String(data.payment.cf_payment_id);
        const payment_status = data.payment.payment_status;
        const amount = Number(data.payment.payment_amount);
        const order_id = data.order?.order_id || null;

        let status = "unknown";

        if (type === "PAYMENT_SUCCESS_WEBHOOK" && payment_status === "SUCCESS") {
            status = "captured";
        } else if (type === "PAYMENT_FAILED_WEBHOOK") {
            status = "failed";
        } else if (type === "PAYMENT_USER_DROPPED_WEBHOOK") {
            status = "dropped";
        } else {
            status = "unknown";
        }

        const { error } = await supabase.from("transactions").upsert(
            [
                {
                    txnid: cf_payment_id,
                    amount,
                    status,
                    dispensed: false,
                    dispensed_count: 0,
                    provider: "cashfree",
                    order_id,
                },
            ],
            { onConflict: "txnid" }
        );

        if (error) throw error;

        console.log("💾 Saved txn:", cf_payment_id, status, amount);

        res.json({ ok: true });
    } catch (err) {
        console.log("❌ Cashfree webhook error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ---------------- START SERVER ----------------
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
