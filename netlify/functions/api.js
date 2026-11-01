// ============================================================
// STABLEFLOW HUB, API
// One Netlify function that handles everything under /api/*.
//  - Login with Google, or with a 6-digit code sent by email
//  - Session cookie, re-checked against the sheet on every request
//  - Reads and writes the Employee Hub Google Sheet (service account)
// ============================================================
import crypto from "node:crypto";
import { OAuth2Client, JWT } from "google-auth-library";
import { SignJWT, jwtVerify } from "jose";
import { getStore } from "@netlify/blobs";

const env = (k, d = "") => process.env[k] || d;
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const nowLagos = () => new Date().toLocaleString("sv-SE", { timeZone: "Africa/Lagos" });
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

const ACCENTS = ["#2F6FDB", "#6D4AE0", "#0E9384", "#D6336C", "#E08A00"];
const RTYPES = ["Question", "Complaint", "Access request", "Suggestion"];
const RSTATUS = ["New", "In progress", "Resolved"];
const COOKIE = "hub_session";

class UserError extends Error {
  constructor(message, status = 400, code = "") { super(message); this.status = status; this.code = code; }
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
});

// ------------------------------------------------------------
// Google Sheets (service account)
// ------------------------------------------------------------
let _auth = null;
let cache = null;

function sheetsAuth() {
  const missing = ["HUB_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_PRIVATE_KEY"].filter(k => !env(k));
  if (missing.length) throw new UserError("Netlify is missing these settings: " + missing.join(", ") + ". Add them, then redeploy.", 503);
  if (!_auth) {
    _auth = new JWT({
      email: env("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
      key: env("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  }
  return _auth;
}

const sheetUrl = () => `https://sheets.googleapis.com/v4/spreadsheets/${env("HUB_SHEET_ID")}`;

function explainSheetsError(err) {
  const msg = String((err && err.message) || err);
  const detail = JSON.stringify((err && err.response && err.response.data) || "");
  console.error("Sheets error:", msg, detail.slice(0, 400));
  if (err instanceof UserError) return err;
  if (/DECODER|PEM|private key|invalid_grant|JWT/i.test(msg + detail))
    return new UserError("The Google key in Netlify is not valid. Paste GOOGLE_PRIVATE_KEY again, exactly as it is in the JSON file, then redeploy.", 503);
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg + detail))
    return new UserError("The Google Sheets API is switched off. Enable it in Google Cloud, then try again.", 503);
  if (/PERMISSION_DENIED|403/.test(msg + detail))
    return new UserError("The hub sheet is not shared with the service account. Share it with GOOGLE_SERVICE_ACCOUNT_EMAIL as Editor.", 503);
  if (/NOT_FOUND|404|Requested entity/.test(msg + detail))
    return new UserError("Google cannot find the hub sheet or one of its tabs. Check HUB_SHEET_ID and the tab names.", 503);
  return new UserError("The site could not read the hub sheet. Check the Netlify function logs.", 503);
}

async function sheetsGet(ranges) {
  const q = ranges.map(r => "ranges=" + encodeURIComponent(r)).join("&");
  try {
    const res = await sheetsAuth().request({ url: `${sheetUrl()}/values:batchGet?${q}&majorDimension=ROWS` });
    return res.data.valueRanges.map(v => v.values || []);
  } catch (err) {
    throw explainSheetsError(err);
  }
}

async function sheetsUpdate(range, values, input = "USER_ENTERED") {
  cache = null;
  await sheetsAuth().request({
    method: "PUT",
    url: `${sheetUrl()}/values/${encodeURIComponent(range)}?valueInputOption=${input}`,
    data: { values },
  });
}

async function sheetsAppend(range, values) {
  cache = null;
  await sheetsAuth().request({
    method: "POST",
    url: `${sheetUrl()}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    data: { values },
  });
}

function driveIdFromUrl(url) {
  if (!/docs\.google\.com|drive\.google\.com/.test(url || "")) return "";
  const m = /\/(?:d|folders)\/([A-Za-z0-9_-]{15,})/.exec(url);
  return m ? m[1] : "";
}

const c = (r, i) => (r && r[i - 1] != null ? String(r[i - 1]).trim() : "");

// Reads every tab we need in one call and keeps it for 30 seconds.
// This is also how fast an Inactive status cuts someone off.
async function load() {
  if (cache && Date.now() - cache.t < 30000) return cache.d;
  const [emp, tools, dept, person, reqs, set] = await sheetsGet([
    "Employees!A2:O1000", "Tools!A2:J300", "'Department Access'!A1:AZ300",
    "'Person Access'!A2:C500", "Requests!A2:L2000", "Settings!A2:B50",
  ]);

  const settings = {};
  set.forEach(r => { if (c(r, 1) && c(r, 2)) settings[c(r, 1)] = c(r, 2); });

  const employees = emp.map((r, i) => {
    let prefs = {};
    try { prefs = JSON.parse(c(r, 12) || "{}"); } catch (e) { prefs = {}; }
    return {
      row: i + 2, name: c(r, 1), email: c(r, 2).toLowerCase(), dept: c(r, 3), title: c(r, 4),
      lead: c(r, 5), role: c(r, 6) || "Employee", status: c(r, 7), start: c(r, 8), seen: c(r, 13), prefs,
    };
  }).filter(e => e.email);

  const toolList = tools.map(r => ({
    id: c(r, 1), name: c(r, 2), cat: c(r, 3) || "Other", url: c(r, 4), icon: c(r, 5) || "🔗", desc: c(r, 6),
    fileId: c(r, 7) || driveIdFromUrl(c(r, 4)), perm: c(r, 8) || "Viewer", pin: c(r, 9) === "Yes", active: c(r, 10) !== "No",
  })).filter(t => t.id && t.name);

  const head = dept[0] || [];
  const matrix = {};
  dept.slice(1).forEach(r => {
    const id = c(r, 1);
    if (!id) return;
    const m = { everyone: c(r, 3).toUpperCase() === "TRUE", depts: {} };
    for (let i = 3; i < head.length; i++) {
      const name = String(head[i] || "").trim();
      if (name && String(r[i] || "").toUpperCase() === "TRUE") m.depts[name] = true;
    }
    matrix[id] = m;
  });

  const overrides = {};
  person.forEach(r => {
    const e = c(r, 1).toLowerCase(), t = c(r, 2).toLowerCase(), a = c(r, 3);
    if (e && t && a) (overrides[e] = overrides[e] || []).push({ tool: t, access: a });
  });

  const requests = reqs.map((r, i) => ({
    row: i + 2, ticket: c(r, 1), time: c(r, 2), name: c(r, 3), email: c(r, 4).toLowerCase(), dept: c(r, 5),
    type: c(r, 6), subject: c(r, 7), message: String(r[7] || ""), status: c(r, 9) || "New", reply: String(r[9] || ""),
  })).filter(r => r.ticket);

  const d = { settings, employees, tools: toolList, matrix, overrides, requests };
  cache = { t: Date.now(), d };
  return d;
}

function siteInfo(d) {
  const s = d.settings;
  return {
    hubName: s.HUB_NAME || "StableFlow Hub",
    company: s.COMPANY_NAME || "StableFlow HQ",
    accent: s.DEFAULT_ACCENT || "#2F6FDB",
    support: s.REPLY_TO || env("SUPPORT_EMAIL"),
    admins: (s.ADMIN_EMAILS || "").split(",").map(x => x.trim()).filter(Boolean),
  };
}

// Same rule as the Apps Script engine: department access (or Everyone),
// then personal Grant and Revoke on top.
function effectiveTools(emp, d) {
  const ids = new Set();
  d.tools.forEach(t => {
    if (!t.active || !t.url) return;
    const m = d.matrix[t.id];
    if (m && (m.everyone || m.depts[emp.dept])) ids.add(t.id);
  });
  (d.overrides[emp.email] || []).forEach(o => {
    const t = d.tools.find(x => x.name.toLowerCase() === o.tool);
    if (!t) return;
    if (o.access === "Grant" && t.active && t.url) ids.add(t.id);
    if (o.access === "Revoke") ids.delete(t.id);
  });
  return d.tools.filter(t => ids.has(t.id));
}

function accessLabel(t) {
  if (!t.fileId || t.perm === "None") return "Link";
  if (t.perm === "Editor") return "Can edit";
  if (t.perm === "Commenter") return "Can comment";
  return "Can view";
}

// ------------------------------------------------------------
// Session
// ------------------------------------------------------------
const secret = () => {
  if (!env("SESSION_SECRET")) throw new UserError("The site is missing its session secret.", 500);
  return new TextEncoder().encode(env("SESSION_SECRET"));
};

async function makeCookie(email) {
  const jwt = await new SignJWT({ email }).setProtectedHeader({ alg: "HS256" })
    .setIssuedAt().setExpirationTime("7d").sign(secret());
  return `${COOKIE}=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 86400}`;
}

async function sessionEmail(req) {
  const m = new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)").exec(req.headers.get("cookie") || "");
  if (!m) return null;
  try { return (await jwtVerify(m[1], secret())).payload.email; } catch (e) { return null; }
}

function lookup(d, email) {
  const support = siteInfo(d).support;
  const emp = d.employees.find(e => e.email === email);
  if (!emp) {
    throw new UserError(`Unfortunately, ${email} is not on the hub list. Check that you used the email People & Culture has on file, or contact them at ${support} to be added.`, 404, "not_found");
  }
  if (emp.status !== "Active") {
    throw new UserError(`Your hub access is not active right now. Please contact People & Culture at ${support}.`, 403, "inactive");
  }
  return emp;
}

async function signIn(emp) {
  const cookie = await makeCookie(emp.email);
  await sheetsUpdate(`Employees!M${emp.row}`, [[nowLagos()]]).catch(() => {});
  return json({ ok: true }, 200, { "set-cookie": cookie });
}

// ------------------------------------------------------------
// Email (sent through the hub Gmail, via the Apps Script relay)
// ------------------------------------------------------------
async function sendMail({ to, subject, html, replyTo }) {
  const url = env("MAIL_URL");
  if (!url || !env("MAIL_SECRET")) throw new UserError("Email is not set up on the site yet. Please contact People & Culture.", 500);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ secret: env("MAIL_SECRET"), to, subject, html, replyTo }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.ok) {
    console.error("Mail relay error", res.status, data && data.error);
    throw new UserError("We could not send that email. Try again in a minute.", 502);
  }
}

function emailShell(info, inner) {
  const a = info.accent;
  return `<div style="background:#f3f5fa;padding:32px 12px;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #e8ebf2;">
    <div style="background:${a};padding:24px 32px;color:#ffffff;font-size:18px;font-weight:700;">${esc(info.hubName)}</div>
    <div style="padding:32px;color:#1b2437;font-size:15px;line-height:1.75;">${inner}</div>
    <div style="padding:16px 32px;background:#f7f8fb;color:#8a93a7;font-size:12px;">Sent by People &amp; Culture at ${esc(info.company)}.</div>
  </div></div>`;
}

// ------------------------------------------------------------
// Public endpoints
// ------------------------------------------------------------
async function getConfig() {
  let i = { hubName: "StableFlow Hub", company: "", accent: "#2F6FDB", support: env("SUPPORT_EMAIL") };
  try { i = siteInfo(await load()); } catch (e) { console.error("config: sheet not readable yet"); }
  return { hubName: i.hubName, company: i.company, accent: i.accent, support: i.support, googleClientId: env("GOOGLE_CLIENT_ID") };
}

async function authGoogle([credential]) {
  const clientId = env("GOOGLE_CLIENT_ID");
  if (!clientId || !credential) throw new UserError("Google sign-in is not set up yet. Use the email code instead.");
  let p;
  try {
    const ticket = await new OAuth2Client(clientId).verifyIdToken({ idToken: credential, audience: clientId });
    p = ticket.getPayload();
  } catch (e) {
    throw new UserError("Google could not confirm that sign-in. Try again.", 401);
  }
  if (!p.email || !p.email_verified) throw new UserError("That Google account has no verified email.", 401);
  return signIn(lookup(await load(), p.email.toLowerCase()));
}

async function authCodeRequest([email]) {
  email = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserError("Enter a valid email address.");
  const d = await load();
  lookup(d, email);

  const store = getStore("login-codes");
  const key = sha(email);
  const old = await store.get(key, { type: "json" });
  if (old && Date.now() - old.sent < 45000) throw new UserError("Wait a minute before asking for another code.", 429);

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await store.setJSON(key, {
    hash: sha(`${code}:${email}:${env("SESSION_SECRET")}`), exp: Date.now() + 10 * 60000, tries: 0, sent: Date.now(),
  });

  const info = siteInfo(d);
  await sendMail({
    to: email,
    subject: `${code} is your ${info.hubName} sign-in code`,
    html: emailShell(info, `
      <h2 style="margin:0 0 12px;font-size:22px;color:${info.accent};">Your sign-in code</h2>
      <p style="margin:0 0 18px;">Enter this code on the sign-in page. It works for 10 minutes.</p>
      <p style="margin:0 0 18px;font-size:34px;font-weight:800;letter-spacing:8px;">${code}</p>
      <p style="margin:0;color:#8a93a7;font-size:13px;">If you did not ask for this, ignore this email. Nobody can sign in without the code.</p>`),
  });
  return { ok: true };
}

async function authCodeVerify([email, code]) {
  email = String(email || "").trim().toLowerCase();
  code = String(code || "").replace(/\D/g, "");
  const store = getStore("login-codes");
  const key = sha(email);
  const rec = await store.get(key, { type: "json" });

  if (!rec || rec.exp < Date.now()) throw new UserError("That code has expired. Ask for a new one.", 400, "expired");
  if (rec.tries >= 5) {
    await store.delete(key);
    throw new UserError("Too many wrong tries. Ask for a new code.", 429, "locked");
  }
  const want = Buffer.from(rec.hash);
  const got = Buffer.from(sha(`${code}:${email}:${env("SESSION_SECRET")}`));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
    rec.tries += 1;
    await store.setJSON(key, rec);
    throw new UserError("That code is not right. Check it and try again.", 400, "bad_code");
  }
  await store.delete(key);
  return signIn(lookup(await load(), email));
}

async function logout() {
  return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
}

// ------------------------------------------------------------
// Signed-in endpoints. Each gets (employee, args, data).
// The first argument from the page is an unused placeholder.
// ------------------------------------------------------------
function myRequests(d, email) {
  return d.requests.filter(r => r.email === email).reverse().map(r => ({
    ticket: r.ticket, time: r.time, type: r.type, subject: r.subject, message: r.message, status: r.status, reply: r.reply,
  }));
}

function adminData(d) {
  const counts = { Active: 0, "On leave": 0, Inactive: 0, Pending: 0 };
  const people = d.employees.map(e => {
    if (counts[e.status] !== undefined) counts[e.status] += 1;
    return { name: e.name, email: e.email, dept: e.dept, status: e.status || "Pending", role: e.role, seen: e.seen };
  });
  const open = d.requests.filter(r => r.status !== "Resolved").reverse().map(r => ({
    ticket: r.ticket, time: r.time, name: r.name, email: r.email, dept: r.dept, type: r.type,
    subject: r.subject, message: r.message, status: r.status, reply: r.reply,
  }));
  return { counts, people, open, sheetUrl: `https://docs.google.com/spreadsheets/d/${env("HUB_SHEET_ID")}/edit` };
}

async function hubBoot(emp, args, d) {
  const info = siteInfo(d);
  let photo = "";
  try { photo = (await getStore("hub-photos").get(sha(emp.email))) || ""; } catch (e) { photo = ""; }
  const out = {
    ok: true,
    support: info.support,
    me: { name: emp.name, email: emp.email, dept: emp.dept, title: emp.title, lead: emp.lead, role: emp.role,
          start: emp.start, photo, prefs: emp.prefs },
    tools: effectiveTools(emp, d).map(t => ({
      id: t.id, name: t.name, cat: t.cat, url: t.url, icon: t.icon, desc: t.desc, pin: t.pin, access: accessLabel(t),
    })),
    requests: myRequests(d, emp.email),
  };
  if (emp.role === "Admin") out.admin = adminData(d);
  return out;
}

async function hubSavePrefs(emp, [, prefs]) {
  const clean = {
    theme: prefs && prefs.theme === "dark" ? "dark" : "light",
    accent: prefs && ACCENTS.includes(prefs.accent) ? prefs.accent : ACCENTS[0],
  };
  await sheetsUpdate(`Employees!L${emp.row}`, [[JSON.stringify(clean)]], "RAW");
  return clean;
}

async function hubUploadPhoto(emp, [, dataUrl]) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw new UserError("Choose a JPG, PNG or WebP image.");
  if (Math.floor(m[2].length * 3 / 4) > 700000) throw new UserError("That image is too large. Try a smaller one.");
  await getStore("hub-photos").set(sha(emp.email), dataUrl);
  return dataUrl;
}

async function hubSubmitRequest(emp, [, type, subject, message], d) {
  if (!RTYPES.includes(type)) throw new UserError("Pick what kind of message this is.");
  subject = String(subject || "").trim().slice(0, 120);
  message = String(message || "").trim().slice(0, 2000);
  if (!message) throw new UserError("Write your message first.");

  const n = Math.max(0, ...d.requests.map(r => parseInt(r.ticket.replace(/\D/g, ""), 10) || 0)) + 1;
  const ticket = "HUB-" + String(n).padStart(4, "0");
  await sheetsAppend("Requests!A:L", [[ticket, nowLagos(), emp.name, emp.email, emp.dept, type, subject, message, "New", "", "", ""]]);

  const info = siteInfo(d);
  if (info.admins.length) {
    try {
      await sendMail({
        to: info.admins, replyTo: emp.email,
        subject: `${ticket}: ${type} from ${emp.name}`,
        html: emailShell(info, `
          <h2 style="margin:0 0 12px;font-size:21px;color:${info.accent};">New ${esc(type.toLowerCase())} from ${esc(emp.name)}</h2>
          <p style="margin:0 0 8px;color:#8a93a7;font-size:13px;">${esc(ticket)} / ${esc(emp.dept)} / ${esc(emp.email)}</p>
          <p style="margin:0 0 6px;font-weight:700;">${esc(subject || "(no subject)")}</p>
          <div style="background:#f3f5fa;border-radius:16px;padding:16px 20px;white-space:pre-wrap;">${esc(message)}</div>`),
      });
    } catch (e) { console.error("Admin email failed", e.message); }
  }
  return myRequests(await load(), emp.email);
}

async function hubAdminReply(emp, [, ticket, reply, status], d) {
  if (emp.role !== "Admin") throw new UserError("Admin access only.", 403);
  const r = d.requests.find(x => x.ticket === ticket);
  if (!r) throw new UserError("We could not find that request.", 404);
  if (!RSTATUS.includes(status)) status = "In progress";
  reply = String(reply || "").trim().slice(0, 2000);

  if (reply) {
    await sheetsUpdate(`Requests!I${r.row}:L${r.row}`, [[status, reply, nowLagos(), emp.email]]);
    const info = siteInfo(d);
    try {
      await sendMail({
        to: r.email, replyTo: info.support,
        subject: `Re: ${r.subject || r.type} (${r.ticket})`,
        html: emailShell(info, `
          <h2 style="margin:0 0 12px;font-size:21px;color:${info.accent};">We have a reply for you, ${esc(r.name.split(" ")[0])}.</h2>
          <p style="margin:0 0 8px;color:#8a93a7;font-size:13px;">${esc(r.ticket)} / ${esc(r.type)}: ${esc(r.subject)}</p>
          <div style="background:#f3f5fa;border-radius:16px;padding:16px 20px;white-space:pre-wrap;">${esc(reply)}</div>
          <p style="margin:18px 0 0;">You can also see this under Help and requests in your hub.</p>`),
      });
    } catch (e) { console.error("Reply email failed", e.message); }
  } else {
    await sheetsUpdate(`Requests!I${r.row}`, [[status]]);
  }
  return adminData(await load());
}

const PUBLIC = { authGoogle, authCodeRequest, authCodeVerify, logout };
const PRIVATE = { hubBoot, hubSavePrefs, hubUploadPhoto, hubSubmitRequest, hubAdminReply };

// ------------------------------------------------------------
// Router
// ------------------------------------------------------------
export default async (req) => {
  const name = new URL(req.url).pathname.replace(/^\/api\//, "").replace(/\/$/, "");
  try {
    if (name === "config" && req.method === "GET") return json(await getConfig());
    if (req.method !== "POST") return json({ error: "Not found" }, 404);
    if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ error: "Bad request" }, 400);

    const body = await req.json().catch(() => ({}));
    const args = Array.isArray(body.args) ? body.args : [];

    if (PUBLIC[name]) {
      const out = await PUBLIC[name](args);
      return out instanceof Response ? out : json(out);
    }
    if (!PRIVATE[name]) return json({ error: "Not found" }, 404);

    const email = await sessionEmail(req);
    if (!email) return json({ error: "signed_out" }, 401);
    const d = await load();
    const emp = d.employees.find(e => e.email === email);
    if (!emp || emp.status !== "Active") return json({ error: "signed_out" }, 401);

    const out = await PRIVATE[name](emp, args, d);
    return out instanceof Response ? out : json(out);
  } catch (err) {
    if (err instanceof UserError) return json({ error: err.message, code: err.code }, err.status);
    console.error(err);
    return json({ error: "Something went wrong. Try again in a moment." }, 500);
  }
};

export const config = { path: "/api/*" };
