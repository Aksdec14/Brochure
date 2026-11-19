// npm install express resend dotenv
// .env -> RESEND_API_KEY=re_xxx   FROM_EMAIL="Brochures <noreply@yourdomain.com>"
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { Resend } = require("resend");

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // index.html goes in /public

// Brochure files live in /brochures (NOT public) so they can't be downloaded without verifying
const BROCHURES = {
  "product-catalog": "product-catalog.pdf",
  "pricing-guide": "pricing-guide.pdf",
  "company-profile": "company-profile.pdf",
};

const otps = new Map();     // email -> { hash, expires, attempts, lastSent }
const sessions = new Map(); // token -> { email, expires }
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

app.post("/api/send-otp", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email." });

  const prev = otps.get(email);
  if (prev && Date.now() - prev.lastSent < 60_000)
    return res.status(429).json({ error: "Please wait a minute before requesting another code." });

  const code = crypto.randomInt(100000, 1000000).toString();
  otps.set(email, { hash: hash(code), expires: Date.now() + 10 * 60_000, attempts: 0, lastSent: Date.now() });

  const { error } = await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to: email,
    subject: `Your verification code: ${code}`,
    html: `<div style="font-family:sans-serif;max-width:420px">
      <h2>Verify your email</h2>
      <p>Use this code to download our brochures:</p>
      <p style="font-size:32px;letter-spacing:8px;font-weight:bold">${code}</p>
      <p style="color:#666">It expires in 10 minutes. If you didn't request this, ignore this email.</p></div>`,
  });
  if (error) { console.error(error); return res.status(500).json({ error: "Could not send email." }); }
  res.json({ ok: true });
});

app.post("/api/verify-otp", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const code = String(req.body.code || "").trim();
  const rec = otps.get(email);
  if (!rec || Date.now() > rec.expires) return res.status(400).json({ error: "Code expired. Request a new one." });
  if (rec.attempts >= 5) { otps.delete(email); return res.status(429).json({ error: "Too many attempts. Request a new code." }); }
  rec.attempts++;
  if (hash(code) !== rec.hash) return res.status(400).json({ error: "Incorrect code." });

  otps.delete(email);
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { email, expires: Date.now() + 24 * 3600_000 });
  console.log("Verified lead:", email); // save to your DB / CRM here
  res.json({ ok: true, token });
});

app.get("/api/download/:id", (req, res) => {
  const s = sessions.get(req.query.token);
  if (!s || Date.now() > s.expires) return res.status(401).send("Please verify your email first.");
  const file = BROCHURES[req.params.id];
  if (!file) return res.status(404).send("Not found");
  res.download(path.join(__dirname, "brochures", file));
});

const PORT = process.env.PORT || 3000; // Hostinger provides PORT
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
