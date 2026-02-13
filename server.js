const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

console.log("🔥 SERVER VERSION: RAZORPAY PAYMENT LINK + WEBHOOK + SUPABASE (FINAL)");

const app = express();
app.use(cors());

// Webhook needs RAW body (VERY IMPORTANT)
app.use("/pay", bodyParser.raw({ type: "application/json" }));

// Normal JSON routes
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ---------- ENV ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RZP_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

console.log("SUPABASE_URL =", SUPABASE_URL ? "✅ OK" : "❌ MISSING");
console.log("SUPABASE_SERVICE_ROLE_KEY =", SUPABASE_SERVICE_ROLE_KEY ? "✅ OK" : "❌ MISSING");
console.log("RZP_KEY_ID =", RZP_KEY_ID ? "✅ OK" : "❌ MISSING");
console.log("RZP_KEY_SECRET =", RZP_KEY_SECRET ? "✅ OK" : "❌ MISSING");
console.log("RZP_WEBHOOK_SECRET =", RZP_WEBHOOK_SECRET ? "✅ OK" : "❌ MISSING");

// ---------- Supabase ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------- Razorpay ----------
const razorpay = new Razorpay({
    key_id: RZP_KEY_ID,
    key_secret: RZP_KEY_SECRET,
});

// ---------------- ROUTES ----------------

app.get("/", (req, res) => {
    res.send("Smart Change Backend Running ✅ (Razorpay + Supabase)");
});

/**
 * Create Payment Link (ESP32 will call this)
 * Example:
 *   GET /create-payment-link?amount=10
 */
app.get("/create-payment-link", async (req, res) => {
    try {
        const amount = parseInt(req.query.amount);

        console.log("\n==============================");
        console.log("📌 /create-payment-link called");
        console.log("Amount =", amount);
        console.log("==============================");

        if (isNaN(amount) || amount < 10 || amount > 101) {
            return res.status(400).json({
                ok: false,
                error: "Invalid amount. Allowed: 10 to 101",
            });
        }

        // Razorpay expects paise
        const paymentLink = await razorpay.paymentLink.create({
            amount: amount * 100,
            currency: "INR",
            description: `Coin Dispenser Payment ₹${amount}`,
            expire_by: Math.floor(Date.now() / 1000) + 10 * 60, // 10 mins expiry
            notes: {
                machine: "coin_dispenser",
            },
        });

        console.log("✅ Payment link created");
        console.log("plink_id:", paymentLink.id);
        console.log("short_url:", paymentLink.short_url);

        // Save to Supabase
        const txnid = paymentLink.id;

        // IMPORTANT: use UPSERT to avoid duplicate errors
        const { data, error } = await supabase
            .from("transactions")
            .upsert(
                [
                    {
                        txnid: txnid,
                        amount: amount,
                        status: "created",
                        dispensed: false,
                        dispensed_count: 0,
                        payment_link_id: paymentLink.id,
                        short_url: paymentLink.short_url,
                    },
                ],
                { onConflict: "txnid" }
            )
            .select();

        if (error) {
            console.log("❌ Supabase upsert error:", error.message);
            return res.status(500).json({ ok: false, error: error.message });
        }

        console.log("✅ Saved in Supabase row:", data);

        res.json({
            ok: true,
            txnid: txnid,
            amount: amount,
            short_url: paymentLink.short_url,
        });
    } catch (err) {
        console.log("❌ create-payment-link error RAW =", err);
        console.log("❌ typeof err =", typeof err);
        console.log("❌ err?.message =", err?.message);
        console.log("❌ err?.error =", err?.error);
        console.log("❌ err?.response?.data =", err?.response?.data);

        return res.status(500).json({
            ok: false,
            message: err?.message || "Unknown error",
            raw: err || null,
            response: err?.response?.data || null,
        });
    }

});

/**
 * ESP32 polls this
 * Return oldest transaction which is captured/dispensing but not dispensed
 */
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
            dispensed_count: txn.dispensed_count,
            status: txn.status,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * ESP32 calls when it starts dispensing
 */
app.post("/start-dispense", async (req, res) => {
    try {
        const { txnid } = req.body;
        if (!txnid) return res.status(400).json({ error: "txnid required" });

        console.log("▶️ start-dispense txnid:", txnid);

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

/**
 * ESP32 calls after each verified coin
 */
app.post("/update-progress", async (req, res) => {
    try {
        const { txnid, dispensed_count } = req.body;

        if (!txnid) return res.status(400).json({ error: "txnid required" });
        if (dispensed_count === undefined)
            return res.status(400).json({ error: "dispensed_count required" });

        console.log("📌 update-progress:", txnid, "count=", dispensed_count);

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

/**
 * ESP32 calls when all coins dispensed successfully
 */
app.post("/mark-used", async (req, res) => {
    try {
        const { txnid } = req.body;
        if (!txnid) return res.status(400).json({ error: "txnid required" });

        console.log("✅ mark-used txnid:", txnid);

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

/**
 * ESP32 calls if jam/empty/error
 */
app.post("/mark-failed", async (req, res) => {
    try {
        const { txnid } = req.body;
        if (!txnid) return res.status(400).json({ error: "txnid required" });

        console.log("❌ mark-failed txnid:", txnid);

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

// ---------------- WEBHOOK (/pay) ----------------
app.post("/pay", async (req, res) => {
    try {
        console.log("\n==============================");
        console.log("📩 WEBHOOK RECEIVED /pay");
        console.log("==============================");

        const signature = req.headers["x-razorpay-signature"];
        const body = req.body;

        if (!signature) {
            console.log("❌ No signature header");
            return res.status(400).send("No signature");
        }

        // Verify signature
        const expected = crypto
            .createHmac("sha256", RZP_WEBHOOK_SECRET)
            .update(body)
            .digest("hex");

        if (signature !== expected) {
            console.log("❌ Invalid signature!");
            return res.status(400).send("Invalid signature");
        }

        const event = JSON.parse(body.toString());
        console.log("✅ Verified webhook event:", event.event);

        // ---------------- payment_link.paid ----------------
        if (event.event === "payment_link.paid") {
            const plink = event.payload.payment_link.entity;
            const payment = event.payload.payment.entity;

            const txnid = plink.id;
            const amountRs = plink.amount / 100;
            const paymentId = payment.id;

            console.log("💰 PAYMENT SUCCESS");
            console.log("txnid:", txnid);
            console.log("amountRs:", amountRs);
            console.log("paymentId:", paymentId);

            const { data, error } = await supabase
                .from("transactions")
                .update({
                    status: "captured",
                    amount: amountRs,
                    payment_id: paymentId,
                })
                .eq("txnid", txnid)
                .select();

            if (error) throw error;

            console.log("✅ DB updated:", data);
        }

        // ---------------- payment_link.expired ----------------
        if (event.event === "payment_link.expired") {
            const plink = event.payload.payment_link.entity;
            const txnid = plink.id;

            console.log("⌛ Payment link expired:", txnid);

            await supabase
                .from("transactions")
                .update({ status: "expired" })
                .eq("txnid", txnid);
        }

        // ---------------- payment_link.cancelled ----------------
        if (event.event === "payment_link.cancelled") {
            const plink = event.payload.payment_link.entity;
            const txnid = plink.id;

            console.log("🚫 Payment link cancelled:", txnid);

            await supabase
                .from("transactions")
                .update({ status: "cancelled" })
                .eq("txnid", txnid);
        }

        return res.json({ ok: true });
    } catch (err) {
        console.log("Webhook error:", err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ---------------- START ----------------
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
