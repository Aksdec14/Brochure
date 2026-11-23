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

// Logo is embedded in the email itself (inline attachment), so it shows without any public URL
const LOGO = require("fs").readFileSync(path.join(__dirname, "public", "logo.png")).toString("base64");
function emailTemplate(code) {
  const digits = code.split("").map((d) =>
    `<td style="padding:0 4px"><div style="width:44px;height:54px;line-height:54px;text-align:center;font-size:26px;font-weight:700;color:#16161A;background:#ffffff;border:1px solid #E6E6EA;border-radius:10px">${d}</div></td>`
  ).join("");
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#EEF1F3;font-family:'Public Sans',Helvetica,Arial,sans-serif;color:#16161A">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1F3;padding:40px 16px"><tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#F7F7F8;border:1px solid #ffffff;border-radius:20px;box-shadow:0 10px 40px rgba(22,22,26,.08)">
    <tr><td style="padding:32px 36px 8px">
      <img src="cid:fusionedge-logo" alt="Fusionedge" width="126" height="40" style="display:block;width:126px;height:40px">
    </td></tr>
    <tr><td style="padding:24px 36px 0">
      <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;letter-spacing:-.01em">Verify your email</h1>
      <p style="margin:0 0 12px;font-size:16px;line-height:1.6;color:#3A3A44">Hey there,</p>
      <p style="margin:0;font-size:16px;line-height:1.6;color:#3A3A44">Thanks for your interest in <span style="color:#5D1F72;font-weight:600">Fusionedge</span>. Enter the code below to unlock your brochure downloads.</p>
    </td></tr>
    <tr><td align="center" style="padding:28px 36px">
      <table cellpadding="0" cellspacing="0"><tr>${digits}</tr></table>
      <p style="margin:14px 0 0;font-size:14px;color:#6B6B76">This code expires in <b style="color:#16161A;background:#FFF3D6;padding:1px 4px;border-radius:4px">10 minutes</b></p>
    </td></tr>
    <tr><td style="padding:0 36px 28px">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #E6E6EA;border-radius:12px"><tr>
        <td style="padding:14px 16px;font-size:14px;color:#6B6B76;line-height:1.5">
          🔒 Didn't request this? You can safely ignore this email. Someone may have typed your address by mistake.
        </td></tr></table>
    </td></tr>
    <tr><td style="padding:0 36px 32px;font-size:16px;line-height:1.6;color:#3A3A44">Best,<br>Team Fusionedge</td></tr>
  </table>
  <p style="margin:20px 0 0;font-size:12px;color:#8A8A94">© Fusionedge · Sent because a brochure download was requested with this email.</p>
</td></tr></table></body></html>`;
}

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
    subject: `${code} is your Fusionedge verification code`,
    html: emailTemplate(code),
    attachments: [{ filename: "logo.png", content: LOGO, contentId: "fusionedge-logo" }],
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
