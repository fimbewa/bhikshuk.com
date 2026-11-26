// bhikshuk.com: a small website with an owner page for writing posts from a phone.
// No outside packages. Content lives in DATA_DIR/content.json; photos in DATA_DIR/media.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const PORT = Number(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const MEDIA = path.join(DATA, "media");
const BACKUPS = path.join(DATA, "backups");
const PUB = path.join(__dirname, "public");
const SITE_URL = (process.env.SITE_URL || "https://bhikshuk.com").replace(/\/$/, "");
const PER_PAGE = 10;

for (const d of [DATA, MEDIA, BACKUPS]) fs.mkdirSync(d, { recursive: true });

// ---------- content store ----------
const FILE = path.join(DATA, "content.json");
if (!fs.existsSync(FILE)) fs.copyFileSync(path.join(__dirname, "seed", "content.json"), FILE);
let store = JSON.parse(fs.readFileSync(FILE, "utf8"));
function save() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  fs.renameSync(tmp, FILE);
}
function dailyBackup() {
  const day = new Date().toISOString().slice(0, 10);
  const f = path.join(BACKUPS, `content-${day}.json`);
  if (!fs.existsSync(f)) fs.copyFileSync(FILE, f);
  const old = fs.readdirSync(BACKUPS).filter(x => x.startsWith("content-")).sort().slice(0, -30);
  for (const x of old) fs.unlinkSync(path.join(BACKUPS, x));
}
dailyBackup();
setInterval(dailyBackup, 6 * 3600e3).unref();

// ---------- owner password and login ----------
const PW_FILE = path.join(DATA, "owner-password.json");
const SECRET_FILE = path.join(DATA, "secret");
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim();
function hashPw(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString("hex") };
}
if (!fs.existsSync(PW_FILE)) {
  const words = ["lotus", "river", "mountain", "temple", "light", "peace", "truth", "moon", "sun", "garden"];
  const pw = words[crypto.randomInt(10)] + "-" + words[crypto.randomInt(10)] + "-" + crypto.randomInt(1000, 9999);
  fs.writeFileSync(PW_FILE, JSON.stringify(hashPw(pw)), { mode: 0o600 });
  console.log("==============================================");
  console.log("OWNER PANEL PASSWORD: " + pw);
  console.log("Open " + SITE_URL + "/admin and log in with it.");
  console.log("==============================================");
}
function checkPw(pw) {
  const { salt, hash } = JSON.parse(fs.readFileSync(PW_FILE, "utf8"));
  const h = crypto.scryptSync(String(pw), salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(hash, "hex"));
}
function makeToken() {
  const exp = Date.now() + 30 * 86400e3;
  const sig = crypto.createHmac("sha256", SECRET).update(String(exp)).digest("hex");
  return exp + "." + sig;
}
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = crypto.createHmac("sha256", SECRET).update(exp).digest("hex");
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function cookies(req) {
  const out = {};
  for (const p of (req.headers.cookie || "").split(";")) {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}
const isOwner = req => validToken(cookies(req).bk_owner);
const attempts = new Map(); // ip -> [count, firstTime]
function clientIp(req) { return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }

// ---------- helpers ----------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slugify = s => String(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "post-" + new Date().toISOString().slice(0, 10);
const catSlug = c => String(c).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "category";
const longDate = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }); };
const ytId = u => { const m = String(u).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/); return m ? m[1] : null; };
const published = () => store.items.filter(x => x.status === "published");
const posts = () => published().filter(x => x.type === "post").sort((a, b) => b.date.localeCompare(a.date));
const menuPages = () => published().filter(x => x.type === "page" && x.inMenu).sort((a, b) => (a.order || 0) - (b.order || 0));
const allCats = () => [...new Set(store.items.filter(x => x.type === "post").flatMap(x => x.cats || []))].sort();

function linkify(s) {
  return s.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}
function inline(s) {
  return linkify(esc(s)).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}
// Body text: blank line = new paragraph, "## " = heading, "- " = list, a line with only a YouTube link = video,
// a line with only a photo address (/media/...) = photo.
function renderBody(text) {
  const out = [];
  for (const block of String(text || "").replace(/\r/g, "").split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    const lines = b.split("\n");
    if (lines.length === 1 && /^#{2,3}\s/.test(b)) { out.push(`<h2>${inline(b.replace(/^#+\s*/, ""))}</h2>`); continue; }
    if (lines.length === 1 && ytId(b) && /^\S+$/.test(b)) { out.push(video(ytId(b))); continue; }
    if (lines.length === 1 && /^\/media\/[\w.-]+$/.test(b)) { out.push(`<figure><img src="${esc(b)}" alt="" loading="lazy"></figure>`); continue; }
    if (lines.every(l => /^\s*[-•]\s+/.test(l))) { out.push("<ul>" + lines.map(l => `<li>${inline(l.replace(/^\s*[-•]\s+/, ""))}</li>`).join("") + "</ul>"); continue; }
    out.push(`<p>${lines.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");
}
function video(id) {
  return `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${id}" title="YouTube video" loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
}
function summary(text, n = 180) {
  const t = String(text || "").replace(/https?:\/\/\S+/g, "").replace(/\/media\/\S+/g, "").replace(/[#*•\-]+\s/g, "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n).replace(/\s\S*$/, "") + "…" : t;
}
function firstImage(it) {
  const m = String(it.body || "").match(/^\/media\/[\w.-]+$/m);
  if (m) return m[0];
  const v = (it.videos || []).map(ytId).find(Boolean) || ytId((String(it.body).match(/https?:\/\/\S+/) || [""])[0]);
  return v ? `https://i.ytimg.com/vi/${v}/hqdefault.jpg` : null;
}

// ---------- page layout (same design as the old GoDaddy site) ----------
const DEFAULT_SETTINGS = {
  featured: "a-great-sculptor-of-the-mahanubhava-sect-part-50-a-acharya-shri-nagarajvyas-kapa\nshri-kshetra-jalicha-dev-chakradhar-swami-buldhana-yatra",
  youtubeLinks: "http://youtube.com/post/Ugkx002B1mDmbpGykiFHVQFGqVKPuMZd1xoW?si=qLG9L2LMq1mKK-Vv\nhttp://www.youtube.com/@MahanubhavPratitiPanth\nhttps://youtube.com/shorts/kMzwgz9qMZ8?si=MQJ2ShBUmBBW0FGJ",
  footerLine: "Door of Hell | Swagram | Swadesh | Kaam Mad",
  footer: "© 2018 All rights reserved.",
  subtitle: "The eternal journey of Bhikshsuk in the Mahanubhav Dharma till the end of the this Kaliyuga!"
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (store.settings[k] === undefined || (k === "footer" && store.settings.footer.startsWith("© 2018–2026"))) store.settings[k] = v;
// Posts that had no text on the old site were first saved as drafts. The old site listed them, so show them too (once).
if (!store.settings.shownEmptyPosts) {
  for (const it of store.items) if (it.type === "post" && it.status === "draft" && !String(it.body).trim()) it.status = "published";
  store.settings.shownEmptyPosts = true; save();
}
// The top menu, in the same order as before. "Puja Avasara" opens a small list.
const MENU = ["privacy-policy", "madhyan-puja-avasar-marathi-aarth-meaning", "sayankal-puja-avasara", "about", "contact",
  "themessage-of-the-immortal-love", "mahanubhavvichar", "dnyanpunj-bhikshuk-and-dnyanpunj-tapasvini", "lets-know-parmeshwar",
  "@puja", "leela-charitra-vachan-the-leela-satsang-online", "cafe-social", "my-reported-judgment"];
const PUJA = ["pratah-puja-avsara-marathi-arth", "madhyan-puja-avasar-marathi-aarth-meaning", "sayankal-puja-avasara"];
const SHORT = { "dnyanpunj-bhikshuk-and-dnyanpunj-tapasvini": "Dnyanpunj Bhikshuk & Tapasvini", "leela-charitra-vachan-the-leela-satsang-online": "Leela Charitra Vachan", "madhyan-puja-avasar-marathi-aarth-meaning": "Madhyan Puja Avasar Marathi Aarth | Meaning" };
function navHtml() {
  const pages = menuPages();
  const bySlug = Object.fromEntries(published().filter(p => p.type === "page").map(p => [p.slug, p]));
  const link = p => `<a href="/${esc(p.slug)}">${esc(SHORT[p.slug] || p.title)}</a>`;
  const out = [], used = new Set();
  for (const s of MENU) {
    if (s === "@puja") {
      const kids = PUJA.map(k => bySlug[k]).filter(Boolean);
      if (kids.length) out.push(`<details class="sub"><summary>Puja Avasara</summary><div>${kids.map(link).join("")}</div></details>`);
      kids.forEach(k => used.add(k.slug));
      continue;
    }
    if (bySlug[s]) { out.push(link(bySlug[s])); used.add(s); }
  }
  for (const p of pages) if (!used.has(p.slug)) out.push(link(p)); // pages added later on the owner page
  return out.join("");
}
function sidebar() {
  const recent = posts().slice(0, 5);
  const months = {};
  for (const p of posts()) { const k = p.date.slice(0, 7); months[k] = (months[k] || 0) + 1; }
  const monthName = k => new Date(k + "-15").toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  return `<aside class="side">
<section class="widget"><h2>Search</h2><form class="sform" action="/search"><input name="q" type="search" aria-label="Search"><button class="btn-navy">Search</button></form></section>
<section class="widget"><div class="wtabs"><input type="radio" name="wt" id="wt1" checked><label for="wt1">Recent Posts</label><input type="radio" name="wt" id="wt2"><label for="wt2">Archives</label>
<ul class="wt1">${recent.map(p => `<li><a href="/${esc(p.slug)}">${esc(p.title)}</a></li>`).join("")}</ul>
<ul class="wt2">${Object.keys(months).map(k => `<li><a href="/archive/${k}">${esc(monthName(k))}</a> (${months[k]})</li>`).join("")}</ul></div></section>
<section class="widget"><h2>Categories</h2><ul>${allCats().map(c => `<li><a href="/category/${catSlug(c)}">${esc(c)}</a></li>`).join("")}</ul></section>
<section class="widget"><h2>Meta</h2><ul><li><a href="/admin">Log in</a></li><li><a href="/sitemap.xml">Site map</a></li></ul></section>
</aside>`;
}
function layout({ title, description, body, canonical, image, side = true }) {
  const s = store.settings;
  const featured = String(s.featured || "").split("\n").map(x => store.items.find(i => i.slug === x.trim())).filter(Boolean);
  const yt = String(s.youtubeLinks || "").split("\n").map(x => x.trim()).filter(Boolean);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description || s.subtitle)}">
<link rel="canonical" href="${esc(SITE_URL + (canonical || "/"))}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description || s.subtitle)}">
<meta property="og:type" content="website"><meta property="og:url" content="${esc(SITE_URL + (canonical || "/"))}">
<meta property="og:image" content="${esc(image ? (image.startsWith("/") ? SITE_URL + image : image) : SITE_URL + "/logo.png")}">
<meta name="theme-color" content="#1a3a6b"><link rel="icon" href="/logo.png" type="image/png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+Dives+Akuru&family=Playfair+Display:wght@400;500;700&family=Noto+Serif+Devanagari:wght@400;600&display=swap">
<link rel="stylesheet" href="/site.css"></head><body id="top">
<header class="masthead"><div class="wrap">
<a class="site-title" href="/">${esc(s.siteTitle)}</a>
<p class="tagline">${esc(s.tagline)}</p><p class="subline">${esc(s.subtitle)}</p>
<form class="hsearch" action="/search" role="search"><input name="q" type="search" placeholder="Search …" aria-label="Search"><button class="btn-gold">Search</button></form>
</div></header>
<nav class="menu" aria-label="Menu"><details class="menu-toggle"><summary>Menu <span aria-hidden="true">☰</span></summary></details><div class="wrap menu-links">${navHtml()}</div></nav>
<div class="wrap ${side ? "cols" : "single"}"><main class="content">${body}</main>${side ? sidebar() : ""}</div>
<footer class="foot"><div class="wrap">
${featured.length ? `<p class="feat">${featured.map(p => `<a href="/${esc(p.slug)}">${esc(p.title)}</a>`).join('<span class="sep">|</span>')}</p><hr>` : ""}
${yt.length ? `<p class="ytl">YouTube Links:</p><p class="ytlinks">${yt.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join("<br>")}</p><hr>` : ""}
${s.footerLine ? `<p>${esc(s.footerLine)}</p>` : ""}
<div class="foot-end"><p>${esc(s.footer)}</p><a class="totop" href="#top">↑ Scroll back to top</a></div>
</div></footer></body></html>`;
}
function tags(p) {
  return (p.cats || []).length ? `<p class="tags">${p.cats.map(c => `<a href="/category/${catSlug(c)}">${esc(c)}</a>`).join("")}</p>` : "";
}
function card(p) {
  return `<article class="entry"><h2><a href="/${esc(p.slug)}">${esc(p.title)}</a></h2>
<p class="meta">${esc(usDate(p.date))} <span>by</span> <a href="/author/${catSlug(p.author)}">${esc(p.author)}</a></p>${tags(p)}</article>`;
}
const usDate = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "Asia/Kolkata" }); };
function listPage(req, res, { title, heading, items, base, canonical }) {
  const url = new URL(req.url, "http://x");
  const pages = Math.max(1, Math.ceil(items.length / PER_PAGE));
  const page = Math.min(pages, Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const slice = items.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const sep = base.includes("?") ? "&" : "?";
  const href = n => n === 1 ? base : `${base}${sep}page=${n}`;
  let nums = [];
  for (let n = 1; n <= pages; n++) if (n === 1 || n === pages || Math.abs(n - page) <= 1) nums.push(n); else if (nums[nums.length - 1] !== "…") nums.push("…");
  const pager = pages > 1 ? `<nav class="pager">${page < pages ? `<a href="${href(page + 1)}">← Older posts</a><span class="bar">|</span>` : ""}${nums.map(n => n === "…" ? "<span>…</span>" : n === page ? `<b>${n}</b>` : `<a href="${href(n)}">${n}</a>`).join("")}${page > 1 ? `<span class="bar">|</span><a href="${href(page - 1)}">Newer posts →</a>` : ""}</nav>` : "";
  const isHome = base === "/";
  send(res, 200, layout({
    title, canonical, description: store.settings.subtitle,
    body: `${isHome && page === 1 ? `<img class="logo" src="/logo.png" alt="The Kali Yuga's The Revolution of the Immortal Love, propounded by The Messenger of the Immortal Love" width="200" height="199">` : ""}
<h1 class="${isHome ? "sr" : "list-h"}">${esc(heading)}</h1>
${slice.map(card).join("") || "<p>Nothing found.</p>"}${pager}`
  }));
}
function itemPage(res, it, preview = false) {
  const vids = (it.videos || []).map(ytId).filter(Boolean).map(video).join("");
  send(res, 200, layout({
    title: `${it.title} – Bhikshuk`, canonical: "/" + it.slug, description: summary(it.body, 160), image: firstImage(it),
    body: `<article class="post">${preview ? '<p class="tnote">Preview: this is a draft. Only you can see it.</p>' : ""}
<p><a class="back" href="/">← Back to Home</a></p>
${it.type === "post" && (it.cats || []).length ? `<p class="kick">${it.cats.map(c => `<a href="/category/${catSlug(c)}">${esc(c)}</a>`).join("")}</p>` : ""}
<h1>${esc(it.title)}</h1>
${it.type === "post" ? `<p class="byline">By ${esc(it.author)}<span>${esc(longDate(it.date))}</span></p>` : ""}
<div class="post-body">${renderBody(it.body)}${vids}</div>
${it.type === "post" ? `<p class="share"><a href="https://wa.me/?text=${encodeURIComponent(it.title + " " + SITE_URL + "/" + it.slug)}" target="_blank" rel="noopener">Share on WhatsApp</a></p>` : ""}
<p><a class="back" href="/">← Back to Home</a></p></article>`
  }));
}
function notFound(res) {
  send(res, 404, layout({ title: "Page not found", body: `<h1 class="list-h">Page not found</h1><p>Sorry, the page you're looking for doesn't exist or has been moved.</p><p><a class="back" href="/">Go Home</a></p>` }));
}

// ---------- http ----------
function send(res, code, body, type = "text/html; charset=utf-8", extra = {}) {
  res.writeHead(code, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", ...extra });
  res.end(body);
}
const json = (res, code, obj, extra) => send(res, code, JSON.stringify(obj), "application/json; charset=utf-8", { "Cache-Control": "no-store", ...extra });
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > limit) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const TYPES = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
function sendFile(res, file, cache) {
  fs.readFile(file, (err, buf) => {
    if (err) return notFound(res);
    send(res, 200, buf, TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", { "Cache-Control": cache });
  });
}
function cleanItem(b, old = {}) {
  const it = { ...old };
  if (b.type === "page" || b.type === "post") it.type = b.type;
  it.title = String(b.title ?? it.title ?? "").trim().slice(0, 300);
  it.body = String(b.body ?? it.body ?? "").slice(0, 300000);
  it.videos = (Array.isArray(b.videos) ? b.videos : it.videos || []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 30);
  it.cats = (Array.isArray(b.cats) ? b.cats : it.cats || []).map(s => String(s).trim()).filter(Boolean).slice(0, 10);
  it.status = b.status === "draft" ? "draft" : "published";
  it.author = String(b.author ?? it.author ?? "The Messenger of the Immortal Love").trim().slice(0, 100);
  it.date = !isNaN(new Date(b.date)) ? new Date(b.date).toISOString() : (it.date || new Date().toISOString());
  it.order = Number(b.order ?? it.order ?? 0) || 0;
  it.inMenu = it.type === "page" ? !!(b.inMenu ?? it.inMenu ?? true) : false;
  let slug = slugify(b.slug || it.slug || it.title);
  const RESERVED = ["admin", "api", "media", "search", "category", "archive", "author", "logo.png", "page", "sitemap.xml", "robots.txt", "site.css", "favicon.svg"];
  let s = slug, i = 2;
  while (RESERVED.includes(s) || store.items.some(x => x.slug === s && x.id !== it.id)) s = `${slug}-${i++}`;
  it.slug = s;
  if (!it.title) throw new Error("Please write a title.");
  return it;
}

async function api(req, res, p) {
  if (p === "/api/login" && req.method === "POST") {
    const ip = clientIp(req), a = attempts.get(ip) || [0, Date.now()];
    if (Date.now() - a[1] > 15 * 60e3) { a[0] = 0; a[1] = Date.now(); }
    if (a[0] >= 10) return json(res, 429, { error: "Too many tries. Wait 15 minutes." });
    const b = JSON.parse((await readBody(req, 10e3)).toString() || "{}");
    if (!checkPw(b.password || "")) { a[0]++; attempts.set(ip, a); return json(res, 401, { error: "Wrong password." }); }
    attempts.delete(ip);
    return json(res, 200, { ok: true }, { "Set-Cookie": `bk_owner=${makeToken()}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 86400}` });
  }
  if (p === "/api/logout") return json(res, 200, { ok: true }, { "Set-Cookie": "bk_owner=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" });
  if (!isOwner(req)) return json(res, 401, { error: "Please log in." });
  if (req.method !== "GET" && !String(req.headers["content-type"] || "").match(/^(application\/json|image\/)/)) return json(res, 400, { error: "Bad request." });

  if (p === "/api/items" && req.method === "GET") return json(res, 200, { items: store.items, settings: store.settings, cats: allCats() });
  if (p === "/api/items" && req.method === "POST") {
    const b = JSON.parse((await readBody(req, 1e6)).toString());
    const it = cleanItem(b, { id: "i" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"), type: b.type === "page" ? "page" : "post" });
    store.items.push(it); save();
    return json(res, 200, { ok: true, item: it });
  }
  let m = p.match(/^\/api\/items\/([\w-]+)$/);
  if (m) {
    const idx = store.items.findIndex(x => x.id === m[1]);
    if (idx < 0) return json(res, 404, { error: "Not found." });
    if (req.method === "PUT") {
      const b = JSON.parse((await readBody(req, 1e6)).toString());
      store.items[idx] = cleanItem(b, store.items[idx]); save();
      return json(res, 200, { ok: true, item: store.items[idx] });
    }
    if (req.method === "DELETE") { const [gone] = store.items.splice(idx, 1); save(); return json(res, 200, { ok: true, deleted: gone.slug }); }
  }
  if (p === "/api/settings" && req.method === "PUT") {
    const b = JSON.parse((await readBody(req, 50e3)).toString());
    for (const k of ["siteTitle", "tagline", "subtitle", "blogTitle", "youtube", "footer", "footerLine", "youtubeLinks", "featured"]) if (typeof b[k] === "string") store.settings[k] = b[k].trim().slice(0, 2000);
    save(); return json(res, 200, { ok: true, settings: store.settings });
  }
  if (p === "/api/password" && req.method === "POST") {
    const b = JSON.parse((await readBody(req, 10e3)).toString());
    if (!checkPw(b.old || "")) return json(res, 400, { error: "The current password is wrong." });
    if (String(b.new || "").length < 8) return json(res, 400, { error: "Use at least 8 characters." });
    fs.writeFileSync(PW_FILE, JSON.stringify(hashPw(String(b.new))), { mode: 0o600 });
    return json(res, 200, { ok: true });
  }
  if (p === "/api/upload" && req.method === "POST") {
    const ext = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" }[String(req.headers["content-type"]).split(";")[0]];
    if (!ext) return json(res, 400, { error: "Only photos (JPG, PNG, WebP, GIF)." });
    const buf = await readBody(req, 12e6);
    const name = new Date().toISOString().slice(0, 10) + "-" + crypto.randomBytes(5).toString("hex") + ext;
    fs.writeFileSync(path.join(MEDIA, name), buf);
    return json(res, 200, { ok: true, url: "/media/" + name });
  }
  return json(res, 404, { error: "Not found." });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let p = decodeURIComponent(url.pathname);
    if (p.length > 1 && p.endsWith("/")) { res.writeHead(301, { Location: p.slice(0, -1) + url.search }); return res.end(); }
    if (p.startsWith("/api/")) return await api(req, res, p);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");
    if (p === "/") return listPage(req, res, { title: `${store.settings.siteTitle} | ${store.settings.tagline}`, heading: store.settings.blogTitle, items: posts(), base: "/", canonical: "/" });
    let m = p.match(/^\/page\/(\d+)$/);
    if (m) { res.writeHead(301, { Location: "/?page=" + m[1] }); return res.end(); }
    if (p === "/site.css" || p === "/favicon.svg" || p === "/logo.png") return sendFile(res, path.join(PUB, p), "public, max-age=3600");
    if (p === "/admin") return sendFile(res, path.join(PUB, "admin.html"), "no-store");
    if (p === "/admin.js") return sendFile(res, path.join(PUB, "admin.js"), "no-store");
    m = p.match(/^\/media\/([\w.-]+)$/);
    if (m) return sendFile(res, path.join(MEDIA, m[1]), "public, max-age=31536000, immutable");
    m = p.match(/^\/category\/([\w-]+)$/);
    if (m) {
      const cat = allCats().find(c => catSlug(c) === m[1]);
      if (!cat) return notFound(res);
      return listPage(req, res, { title: `${cat} – ${store.settings.siteTitle}`, heading: cat, items: posts().filter(x => x.cats.includes(cat)), base: "/category/" + m[1], canonical: "/category/" + m[1] });
    }
    m = p.match(/^\/archive\/(\d{4}-\d{2})$/);
    if (m) {
      const label = new Date(m[1] + "-15").toLocaleDateString("en-IN", { month: "long", year: "numeric" });
      return listPage(req, res, { title: `${label} – ${store.settings.siteTitle}`, heading: "Archives: " + label, items: posts().filter(x => x.date.startsWith(m[1])), base: "/archive/" + m[1], canonical: "/archive/" + m[1] });
    }
    m = p.match(/^\/author\/([\w-]+)$/);
    if (m) {
      const list = posts().filter(x => catSlug(x.author) === m[1]);
      if (!list.length) return notFound(res);
      return listPage(req, res, { title: `${list[0].author} – ${store.settings.siteTitle}`, heading: "Author: " + list[0].author, items: list, base: "/author/" + m[1], canonical: "/author/" + m[1] });
    }
    if (p === "/search") {
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      const hits = q ? posts().concat(menuPages()).filter(x => (x.title + " " + x.body).toLowerCase().includes(q)) : [];
      return listPage(req, res, { title: `Search – ${store.settings.siteTitle}`, heading: q ? `Search: ${q} (${hits.length})` : "Search", items: hits, base: "/search?q=" + encodeURIComponent(q), canonical: "/search" });
    }
    if (p === "/robots.txt") return send(res, 200, `User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: ${SITE_URL}/sitemap.xml\n`, "text/plain");
    if (p === "/sitemap.xml") {
      const urls = ["/"].concat(menuPages().map(x => "/" + x.slug), posts().map(x => "/" + x.slug), allCats().map(c => "/category/" + catSlug(c)));
      return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `<url><loc>${esc(SITE_URL + u)}</loc></url>`).join("\n")}\n</urlset>`, "application/xml");
    }
    if (p === "/health") return send(res, 200, "ok", "text/plain");
    const slug = p.slice(1);
    const it = store.items.find(x => x.slug === slug);
    if (it && it.status === "published") return itemPage(res, it);
    if (it && isOwner(req)) return itemPage(res, it, true);
    return notFound(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 400, { error: e.message && e.message.length < 120 ? e.message : "Something went wrong." });
  }
});
server.listen(PORT, () => console.log(`bhikshuk.com running on port ${PORT}`));

// ---------- updates: if new code is on GitHub, exit so Docker restarts us and the start command downloads it ----------
const AUTO = Number(process.env.AUTO_UPDATE_MINUTES || 0);
if (AUTO > 0 && fs.existsSync(path.join(__dirname, ".git"))) {
  setInterval(() => {
    execFile("git", ["-C", __dirname, "fetch", "-q", "origin"], err => {
      if (err) return;
      execFile("git", ["-C", __dirname, "rev-list", "--count", "HEAD..@{u}"], (e, out) => {
        if (!e && Number(out) > 0) { console.log("New code found on GitHub. Restarting to update."); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000); }
      });
    });
  }, AUTO * 60e3).unref();
}
