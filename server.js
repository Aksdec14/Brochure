// npm install express resend dotenv
// .env -> RESEND_API_KEY=re_xxx   FROM_EMAIL="Brochures <noreply@yourdomain.com>"
// ADMIN_EMAIL and ADMIN_PASSWORD lock /admin.
// Optional ADMIN_TOKEN (16+ characters) lets you read the same history over HTTP.
// Optional DOWNLOAD_LOG_PATH keeps that history outside the app folder so a redeploy does not wipe it.
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const readline = require("readline");
const path = require("path");
const { Resend } = require("resend");
const { loginPage, dashboardPage } = require("./admin-page");

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// On Vercel the app is bundled and the project directory is read-only. Included files live at cwd.
const ROOT = process.env.VERCEL ? process.cwd() : __dirname;
app.use(express.static(path.join(ROOT, "public"))); // index.html goes in /public

// Brochure files live in /brochures (NOT public) so they can't be downloaded without verifying
const BROCHURES = {
  "fusionedge-brochure": {
    file: "FusionEdge_Brochure_Page1_Liner_Removed.pdf",
    downloadName: "FusionEdge Brochure.pdf",
  },
};

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

const PUBLIC_DIR = path.join(ROOT, "public");

function isInside(parent, child) {
  const from = process.platform === "win32" ? parent.toLowerCase() : parent;
  const to = process.platform === "win32" ? child.toLowerCase() : child;
  const rel = path.relative(from, to);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function openDownloadLog() {
  const tmp = path.join("/tmp", "brochure-downloads.jsonl");
  const candidates = [];
  if (process.env.DOWNLOAD_LOG_PATH) candidates.push(path.resolve(process.env.DOWNLOAD_LOG_PATH));
  else if (process.env.VERCEL) candidates.push(tmp);
  else candidates.push(path.join(ROOT, "data", "downloads.jsonl"));
  if (process.env.VERCEL && !candidates.includes(tmp)) candidates.push(tmp);

  let lastErr;
  for (const file of candidates) {
    try {
      if (isInside(PUBLIC_DIR, file)) throw new Error("DOWNLOAD_LOG_PATH must not be inside public/");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, "a", 0o600);
      try { fs.chmodSync(file, 0o600); } catch (err) {
        console.error("Could not restrict download log permissions:", err.message);
      }
      return { file, fd };
    } catch (err) {
      lastErr = err;
      console.error("Download log unavailable at", file, err.message);
      if (!process.env.VERCEL) break;
    }
  }
  if (!process.env.VERCEL) throw lastErr;
  return { file: candidates[0], fd: null };
}

const openedLog = openDownloadLog();
let DOWNLOAD_LOG = openedLog.file;
let logFd = openedLog.fd;

// One JSON object per line, written in a single append and then fsynced.
function recordDownload(email, brochure) {
  if (logFd == null) {
    console.error("Download log is not writable; this download was not recorded.");
    return;
  }
  const line = JSON.stringify({ email, brochure, at: new Date().toISOString() }) + "\n";
  const buf = Buffer.from(line, "utf8");
  const written = fs.writeSync(logFd, buf);
  if (written !== buf.length) throw new Error("Incomplete write to download log");
  fs.fsyncSync(logFd);
}

function readDownloads() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DOWNLOAD_LOG)) return resolve([]);
    const rows = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(DOWNLOAD_LOG, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      if (!line) return;
      try { rows.push(JSON.parse(line)); } catch { /* torn line from a crash */ }
    });
    rl.on("close", () => resolve(rows));
    rl.on("error", reject);
  });
}

function tokensMatch(provided, expected) {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Signed values travel with the browser, so a code still works when Vercel uses another instance.
function appSecret() {
  const raw = process.env.APP_SECRET || process.env.RESEND_API_KEY || "";
  if (!raw) return null;
  return crypto.createHash("sha256").update("brochure-otp:" + raw).digest();
}

function signPayload(data) {
  const secret = appSecret();
  if (!secret) throw new Error("Missing signing secret");
  const body = Buffer.from(JSON.stringify(data)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readPayload(token) {
  const secret = appSecret();
  if (!secret || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!data || typeof data.exp !== "number" || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function otpCookie(value, req, clear) {
  const parts = [
    `otp=${clear ? "" : value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/api",
    clear ? "Max-Age=0" : "Max-Age=600",
  ];
  if (req.secure) parts.push("Secure");
  return parts.join("; ");
}

function adminToken() {
  const token = process.env.ADMIN_TOKEN || "";
  return token.length >= 16 ? token : "";
}

function adminEmail() {
  return String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
}
function adminPassword() {
  return String(process.env.ADMIN_PASSWORD || "");
}
function adminConfigured() {
  return validEmail(adminEmail()) && adminPassword().length >= 8;
}

const ADMIN_TTL_SEC = 7 * 24 * 3600;
const adminFails = new Map(); // ip -> { count, reset }

function adminSecret() {
  return crypto.createHash("sha256").update(adminPassword()).digest();
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    try { out[key] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[key] = ""; }
  }
  return out;
}

function signAdminSession() {
  const body = Buffer.from(JSON.stringify({
    email: adminEmail(),
    exp: Date.now() + ADMIN_TTL_SEC * 1000,
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", adminSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readAdminSession(req) {
  if (!adminConfigured()) return null;
  const token = parseCookies(req).admin_session;
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", adminSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(body, "base64url").toString()); }
  catch { return null; }
  if (!data || data.email !== adminEmail() || typeof data.exp !== "number" || Date.now() > data.exp) return null;
  return data;
}

function adminCookie(value, req, clear) {
  const parts = [
    `admin_session=${clear ? "" : value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/admin",
    clear ? "Max-Age=0" : `Max-Age=${ADMIN_TTL_SEC}`,
  ];
  if (req.secure) parts.push("Secure");
  return parts.join("; ");
}

function adminLocked(ip) {
  const rec = adminFails.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.reset) { adminFails.delete(ip); return false; }
  return rec.count >= 8;
}

function adminFail(ip) {
  const rec = adminFails.get(ip);
  if (!rec || Date.now() > rec.reset) adminFails.set(ip, { count: 1, reset: Date.now() + 15 * 60_000 });
  else rec.count += 1;
}

function groupDownloads(rows) {
  const byEmail = new Map();
  for (const row of rows) {
    if (!row || typeof row.email !== "string" || typeof row.brochure !== "string") continue;
    if (!byEmail.has(row.email)) byEmail.set(row.email, { email: row.email, counts: {}, last: "", events: [] });
    const group = byEmail.get(row.email);
    group.counts[row.brochure] = (group.counts[row.brochure] || 0) + 1;
    const at = typeof row.at === "string" ? row.at : "";
    group.events.push({ brochure: row.brochure, at });
    if (at > group.last) group.last = at;
  }
  for (const group of byEmail.values()) group.events.sort((a, b) => (a.at < b.at ? 1 : -1));
  return [...byEmail.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
}

function sendHtml(res, html) {
  res.set("Cache-Control", "no-store");
  res.set("X-Robots-Tag", "noindex, nofollow");
  res.type("html").send(html);
}

// Logo is embedded in the email itself (inline attachment), so it shows without any public URL
const LOGO = fs.readFileSync(path.join(PUBLIC_DIR, "logo.png")).toString("base64");
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
  if (!appSecret()) return res.status(500).json({ error: "Server is not configured." });

  const prev = readPayload(parseCookies(req).otp);
  if (prev && prev.kind === "otp" && prev.email === email && Date.now() - prev.lastSent < 60_000)
    return res.status(429).json({ error: "Please wait a minute before requesting another code." });

  const code = crypto.randomInt(100000, 1000000).toString();
  const { error } = await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to: email,
    subject: `${code} is your Fusionedge verification code`,
    html: emailTemplate(code),
    attachments: [{ filename: "logo.png", content: LOGO, contentId: "fusionedge-logo" }],
  });
  if (error) { console.error(error); return res.status(500).json({ error: "Could not send email." }); }

  res.setHeader("Set-Cookie", otpCookie(signPayload({
    kind: "otp",
    email,
    codeHash: hash(code),
    exp: Date.now() + 10 * 60_000,
    attempts: 0,
    lastSent: Date.now(),
  }), req));
  res.json({ ok: true });
});

app.post("/api/verify-otp", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const code = String(req.body.code || "").trim();
  const rec = readPayload(parseCookies(req).otp);
  if (!rec || rec.kind !== "otp" || rec.email !== email) return res.status(400).json({ error: "Code expired. Request a new one." });
  if (rec.attempts >= 5) {
    res.setHeader("Set-Cookie", otpCookie("", req, true));
    return res.status(429).json({ error: "Too many attempts. Request a new code." });
  }
  if (hash(code) !== rec.codeHash) {
    rec.attempts += 1;
    res.setHeader("Set-Cookie", otpCookie(signPayload(rec), req));
    return res.status(400).json({ error: "Incorrect code." });
  }

  console.log("Verified lead:", email);
  res.setHeader("Set-Cookie", otpCookie("", req, true));
  res.json({ ok: true, token: signPayload({ kind: "dl", email, exp: Date.now() + 24 * 3600_000 }) });
});

app.get("/api/download/:id", (req, res) => {
  const s = readPayload(String(req.query.token || ""));
  if (!s || s.kind !== "dl" || typeof s.email !== "string") return res.status(401).send("Please verify your email first.");
  const brochure = req.params.id;
  const item = BROCHURES[brochure];
  if (!item) return res.status(404).send("Not found");
  const full = path.join(ROOT, "brochures", item.file);
  if (!fs.existsSync(full)) return res.status(404).send("Not found");

  // The page sends HEAD to check the token, then GET to save the file. Only GET is a download.
  if (req.method === "GET") {
    try { recordDownload(s.email, brochure); }
    catch (err) { console.error("Failed to record download:", err); }
  }
  res.download(full, item.downloadName, (err) => {
    if (!err) return;
    console.error(err);
    if (!res.headersSent) res.status(404).send("Not found");
  });
});

app.get("/admin", async (req, res) => {
  if (!adminConfigured()) return res.status(404).send("Not found");
  if (!readAdminSession(req)) {
    const error = req.query.e === "1" || req.query.e === "2" ? req.query.e : "";
    return sendHtml(res, loginPage(error));
  }
  try {
    sendHtml(res, dashboardPage(groupDownloads(await readDownloads())));
  } catch (err) {
    console.error(err);
    res.status(500).send("Could not read download log");
  }
});

app.post("/admin/login", (req, res) => {
  if (!adminConfigured()) return res.status(404).send("Not found");
  const ip = req.ip || "unknown";
  if (adminLocked(ip)) return res.redirect(303, "/admin?e=2");
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const emailOk = tokensMatch(email, adminEmail());
  const passwordOk = tokensMatch(password, adminPassword());
  if (!emailOk || !passwordOk) {
    adminFail(ip);
    return res.redirect(303, "/admin?e=1");
  }
  adminFails.delete(ip);
  res.setHeader("Set-Cookie", adminCookie(signAdminSession(), req, false));
  res.redirect(303, "/admin");
});

app.post("/admin/logout", (req, res) => {
  if (!adminConfigured()) return res.status(404).send("Not found");
  res.setHeader("Set-Cookie", adminCookie("", req, true));
  res.redirect(303, "/admin");
});

app.get("/api/downloads", async (req, res) => {
  const secret = adminToken();
  if (!secret) return res.status(404).send("Not found");
  const header = req.get("authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!presented || !tokensMatch(presented, secret)) return res.status(401).send("Unauthorized");
  try {
    const downloads = await readDownloads();
    const byEmail = new Map();
    for (const row of downloads) {
      if (!row || !row.email || !row.brochure) continue;
      if (!byEmail.has(row.email)) byEmail.set(row.email, {});
      const counts = byEmail.get(row.email);
      counts[row.brochure] = (counts[row.brochure] || 0) + 1;
    }
    res.set("Cache-Control", "no-store");
    res.json({
      downloads,
      byEmail: [...byEmail.entries()].map(([email, brochures]) => ({ email, brochures })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Could not read download log");
  }
});

function shutdown() {
  if (logFd != null) {
    try { fs.fsyncSync(logFd); } catch { /* already closed */ }
    try { fs.closeSync(logFd); } catch { /* already closed */ }
  }
  process.exit(0);
}

const PORT = process.env.PORT || 3000; // Hostinger provides PORT
if (require.main === module && !process.env.VERCEL) {
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  if (!adminConfigured()) {
    console.warn("Set ADMIN_EMAIL and ADMIN_PASSWORD (8+ characters) in .env to open /admin.");
  }
  app.listen(PORT, () => {
    console.log(`Running on port ${PORT}`);
    console.log(`Download log: ${DOWNLOAD_LOG}`);
  });
}

module.exports = app;
