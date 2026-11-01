// ============================================================
// Code.gs change for the Netlify version
// Replace the whole hubSendWelcome function with this one.
// It links to the site (no private token) and tells people how to sign in.
// Also set WEB_APP_URL on the Settings tab to your Netlify address.
// ============================================================
function hubSendWelcome(emp, desired) {
  const cfg = hubConfig();
  const a = cfg.DEFAULT_ACCENT;
  const link = cfg.WEB_APP_URL || hubWebUrl(cfg);
  const first = hubFirstName(emp.name);
  const shown = desired.slice(0, 8);
  const more = desired.length - shown.length;

  const rows = shown.map(t => `<tr><td style="padding:10px 0;border-bottom:1px solid #eef0f5;font-size:15px;color:#1b2437;">
      <span style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;background:#eef3ff;border-radius:10px;margin-right:12px;vertical-align:middle;">${hubEsc(t.icon)}</span>${hubEsc(t.name)}</td></tr>`).join("");

  const list = shown.length
    ? `<p style="margin:26px 0 6px;font-weight:700;">What is waiting for you${emp.dept ? " in " + hubEsc(emp.dept) : ""}</p>
       <table style="width:100%;border-collapse:collapse;">${rows}</table>
       ${more > 0 ? `<p style="margin:10px 0 0;color:#8a93a7;font-size:13px;">and ${more} more inside.</p>` : ""}`
    : `<p>Your tools are being set up. They will appear in your hub as soon as they are ready.</p>`;

  const inner = `
    <h2 style="margin:0 0 14px;font-size:24px;color:${a};letter-spacing:-0.01em;">Welcome, ${hubEsc(first)}. Your hub is ready.</h2>
    <p style="margin:0 0 6px;">Everything you need to work at ${hubEsc(cfg.COMPANY_NAME)} now lives in one place: your team's trackers, your OKRs, performance reviews, report submission and more. No more hunting for links.</p>
    ${list}
    <p style="margin:30px 0;"><a href="${hubEsc(link)}" style="display:inline-block;background:${a};color:#ffffff;text-decoration:none;padding:15px 34px;border-radius:999px;font-weight:700;font-size:15px;">Open my hub</a></p>
    <p style="margin:0 0 6px;font-size:14px;color:#475467;">Sign in with this email address (${hubEsc(emp.email)}). If it is a Google account, tap Continue with Google. Otherwise choose Email me a sign-in code and we will send you one. If something is missing once you are in, use Help and requests.</p>
    <p style="margin:26px 0 0;">Welcome aboard,<br><strong>The People &amp; Culture Team</strong></p>`;

  MailApp.sendEmail({
    to: emp.email,
    subject: `${first}, your ${cfg.HUB_NAME} is ready`,
    body: `Welcome, ${first}. Your hub is ready: ${link}. Sign in with ${emp.email}.`,
    htmlBody: hubEmailShell(cfg, inner),
    name: cfg.SENDER_NAME,
    replyTo: cfg.REPLY_TO,
  });
}
