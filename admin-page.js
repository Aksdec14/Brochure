const LABELS = {
  "fusionedge-ppm": "FusionEdge PPM",
  "fusionedge-digital-checklist": "FusionEdge Digital Checklist",
  "fusionedge-asset-management-lifecycle": "FusionEdge Asset Management Lifecycle",
  "fusionedge-attendance-management": "FusionEdge Attendance Management",
  "fusionedge-visitor-management": "FusionEdge Visitor Management",
};
const KNOWN = Object.keys(LABELS);

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(date);
}

function label(id) {
  return LABELS[id] || id;
}

function columnsFor(groups) {
  const extra = [];
  for (const group of groups) {
    for (const id of Object.keys(group.counts)) {
      if (!KNOWN.includes(id) && !extra.includes(id)) extra.push(id);
    }
  }
  return KNOWN.concat(extra);
}

const CSS = `
  :root { --purple: #5C1E70; --purple-dark: #3D1250; --ink: #17171C; --muted: #6B6B76; --line: #DCDCE2; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Public Sans", system-ui, sans-serif; color: var(--ink); background: #fff; min-height: 100vh; min-height: 100dvh; }
  a { color: inherit; }
  button, .btn { font-family: inherit; cursor: pointer; border: 0; background: var(--purple); color: #fff; font-weight: 600; border-radius: 999px; }
  button:hover, .btn:hover { background: var(--purple-dark); }
  .login { min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; align-items: center; text-align: center; padding: 0 20px; }
  .logo { margin-top: clamp(32px, 8vh, 80px); }
  .logo img { height: clamp(48px, 7vw, 64px); width: auto; display: block; }
  main.login-main { flex: 1; width: 100%; max-width: 440px; display: flex; flex-direction: column; justify-content: center; padding: 32px 0 48px; }
  h1 { margin: 0; font-size: clamp(32px, 6vw, 52px); font-weight: 700; font-style: italic; letter-spacing: -.02em; line-height: 1.15; }
  h1 .u { display: inline-block; position: relative; padding-bottom: 4px; }
  h1 .u::after { content: ""; position: absolute; left: 0; right: 0; bottom: -6px; height: 6px; background: #00BF88; }
  .lead { margin: 22px 0 28px; font-size: 17px; color: var(--muted); line-height: 1.5; }
  form.stack { display: flex; flex-direction: column; gap: 12px; text-align: left; }
  label { font-size: 13px; font-weight: 600; color: var(--muted); }
  input { height: 52px; padding: 0 22px; font: inherit; font-size: 16px; color: var(--ink); border: 1px solid var(--line); border-radius: 999px; outline: none; background: #fff; width: 100%; }
  input:focus { border-color: var(--purple); }
  .go { height: 52px; font-size: 16px; margin-top: 4px; }
  .err { margin: 0 0 14px; font-size: 14px; color: #C0392B; text-align: center; }
  .dash { display: flex; flex-direction: column; min-height: 100vh; min-height: 100dvh; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 22px clamp(16px, 4vw, 40px); border-bottom: 1px solid var(--line); }
  .top img { height: 40px; width: auto; display: block; }
  .out { background: #fff; color: var(--purple); border: 1px solid var(--line); height: 40px; padding: 0 16px; font-size: 14px; }
  .out:hover { background: #faf7fb; }
  .wrap { width: 100%; max-width: 1040px; margin: 0 auto; padding: 36px clamp(16px, 4vw, 40px) 64px; }
  .wrap h1 { font-size: clamp(32px, 4vw, 44px); }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: left; font-size: 13px; color: var(--muted); font-weight: 600; padding: 0 12px 10px; }
  td { padding: 16px 12px; border-top: 1px solid var(--line); vertical-align: top; font-size: 15px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .zero { color: #b0b0b8; }
  .who { font-weight: 650; word-break: break-word; }
  details summary { cursor: pointer; color: var(--purple); font-size: 13px; font-weight: 600; margin-top: 6px; }
  details ul { margin: 8px 0 0; padding: 0; list-style: none; }
  details li { font-size: 13px; color: var(--muted); padding: 3px 0; }
  .empty { margin-top: 28px; padding: 28px; border: 1px solid var(--line); border-radius: 18px; color: var(--muted); }
  @media (max-width: 720px) {
    .logo { margin-top: 24px; align-self: flex-start; }
    main.login-main { justify-content: flex-start; padding-top: 40px; }
    h1 { font-size: 34px; }
    table, thead, tbody, tr, th, td { display: block; }
    thead { display: none; }
    tr { border: 1px solid var(--line); border-radius: 18px; margin-bottom: 12px; padding: 8px 4px; }
    td { border: 0; display: flex; justify-content: space-between; gap: 16px; padding: 8px 14px; }
    td::before { content: attr(data-label); color: var(--muted); font-size: 13px; font-weight: 600; }
    td.who { display: block; font-size: 16px; padding-top: 12px; }
    td.who::before { display: none; }
    td.num { text-align: right; }
  }
`;

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function loginPage(error) {
  const message = error === "2"
    ? "Too many attempts. Try again in a few minutes."
    : error === "1"
      ? "Email or password is incorrect."
      : "";
  return page("Fusionedge · Admin", `
<div class="login">
  <div class="logo"><img src="/logo.png" alt="Fusionedge" /></div>
  <main class="login-main">
    <h1>Admin <span class="u">sign in</span></h1>
    <p class="lead">This page is private. Download records stay behind this login.</p>
    ${message ? `<p class="err">${esc(message)}</p>` : ""}
    <form class="stack" method="post" action="/admin/login">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button class="go" type="submit">Sign in</button>
    </form>
  </main>
</div>`);
}

function dashboardPage(groups) {
  const columns = columnsFor(groups);
  const visitors = groups.length;
  const downloads = groups.reduce((sum, group) => sum + group.events.length, 0);
  const head = columns.map((id) => `<th class="num">${esc(label(id))}</th>`).join("");
  const rows = groups.map((group) => {
    const counts = columns.map((id) => {
      const n = group.counts[id] || 0;
      return `<td class="num" data-label="${esc(label(id))}"><span class="${n ? "" : "zero"}">${n || "—"}</span></td>`;
    }).join("");
    const times = group.events.map((event) =>
      `<li>${esc(label(event.brochure))} · ${esc(formatWhen(event.at))}</li>`
    ).join("");
    return `<tr>
      <td class="who" data-label="Email">${esc(group.email)}
        <details><summary>${group.events.length} download${group.events.length === 1 ? "" : "s"}</summary><ul>${times}</ul></details>
      </td>
      ${counts}
      <td data-label="Last download">${esc(formatWhen(group.last))}</td>
    </tr>`;
  }).join("");
  const table = visitors
    ? `<table>
        <thead><tr><th>Email</th>${head}<th>Last download</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<div class="empty">No brochure downloads yet.</div>`;
  return page("Fusionedge · Downloads", `
<div class="dash">
  <header class="top">
    <img src="/logo.png" alt="Fusionedge" />
    <form method="post" action="/admin/logout"><button class="out" type="submit">Sign out</button></form>
  </header>
  <div class="wrap">
    <h1>Brochure <span class="u">downloads</span></h1>
    <p class="lead">${visitors} visitor${visitors === 1 ? "" : "s"} · ${downloads} download${downloads === 1 ? "" : "s"}</p>
    ${table}
  </div>
</div>`);
}

module.exports = { loginPage, dashboardPage };
