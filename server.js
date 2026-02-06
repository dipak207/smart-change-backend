const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
console.log("🔥 SERVER VERSION: DISPENSED_COUNT ENABLED");

console.log("SUPABASE_URL =", process.env.SUPABASE_URL);

const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());

// Razorpay webhook needs RAW body
app.use("/razorpay-webhook", bodyParser.raw({ type: "application/json" }));

// Normal routes
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const RAZORPAY_WEBHOOK_SECRET =
    process.env.RAZORPAY_WEBHOOK_SECRET || "test_secret";

// Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------- ROUTES ----------------

app.get("/", (req, res) => {
    res.send("Smart Change Backend + Supabase Running ✅");
});

// ESP32 calls this
// Return oldest payment captured but not dispensed
app.get("/latest-payment", async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("transactions")
            .select("*")
            .in("status", ["captured", "dispensing"]) // important
            .eq("dispensed", false)
            .order("created_at", { ascending: true })
            .limit(1);

        if (error) throw error;

        if (!data || data.length === 0) {
            return res.json({ paid: false, amount: 0, txnid: null, dispensed_count: 0, status: null });
        }

        const txn = data[0];

        res.json({
            paid: true,
            amount: txn.amount,
            txnid: txn.txnid,
            dispensed_count: txn.dispensed_count,
            status: txn.status
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Lock transaction when dispensing starts
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

// Update progress after each coin
app.post("/update-progress", async (req, res) => {
    try {
        const { txnid, dispensed_count } = req.body;

        if (!txnid) return res.status(400).json({ error: "txnid required" });
        if (dispensed_count === undefined) return res.status(400).json({ error: "dispensed_count required" });

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

// Mark transaction failed (jam, empty)
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

        res.json({ ok: true, message: "Marked failed", data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.post("/mark-used", async (req, res) => {
    try {
        const { txnid } = req.body;

        if (!txnid) {
            return res.status(400).json({ error: "txnid required" });
        }

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

// Debug route (fake payment)
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

// Razorpay webhook
app.post("/razorpay-webhook", async (req, res) => {
    try {
        const signature = req.headers["x-razorpay-signature"];
        const body = req.body;

        const expectedSignature = crypto
            .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
            .update(body)
            .digest("hex");

        if (signature !== expectedSignature) {
            console.log("❌ Invalid webhook signature!");
            return res.status(400).send("Invalid signature");
        }

        const event = JSON.parse(body.toString());
        console.log("✅ Webhook received:", event.event);

        if (event.event === "payment.captured") {
            const payment = event.payload.payment.entity;
            const amountRs = payment.amount / 100;

            const txnid = payment.id;

            // Insert into DB (ignore duplicates)
            const { data, error } = await supabase
                .from("transactions")
                .insert([
                    {
                        txnid,
                        amount: amountRs,
                        status: "captured",
                        dispensed: false,
                    },
                ])
                .select();

            if (error) {
                // If duplicate txnid comes, ignore it
                if (error.code === "23505") {
                    console.log("⚠️ Duplicate txnid, already stored:", txnid);
                } else {
                    throw error;
                }
            } else {
                console.log("💰 Payment saved to DB:", data);
            }
        }

        res.json({ status: "ok" });
    } catch (err) {
        console.log("Webhook error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ---------------- START ----------------
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
