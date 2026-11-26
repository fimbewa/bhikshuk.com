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

// ---------- page layout ----------
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
const usDate = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }); };
const readMins = it => Math.max(1, Math.round(String(it.body || "").split(/\s+/).filter(Boolean).length / 200));
// A picture for each card: the post's own photo, else its YouTube picture, else a drawn tile.
function thumb(p, cls = "thumb") {
  const img = firstImage(p);
  if (img) return `<span class="${cls}"><img src="${esc(img)}" alt="" loading="lazy"></span>`;
  const hue = [...String(p.slug)].reduce((a, c) => a + c.charCodeAt(0), 0) % 4;
  return `<span class="${cls} tile t${hue}" aria-hidden="true"><svg viewBox="0 0 64 64"><use href="#lotus"/></svg><b>${esc((p.cats || [])[0] || "The Immortal Love")}</b></span>`;
}
function metaLine(p) {
  return `<span class="m-author"><img src="/logo.png" alt="" width="22" height="22">${esc(p.author)}</span><span>${esc(usDate(p.date))}</span><span>${readMins(p)} min read</span>`;
}
function card(p, big = false) {
  return `<article class="card${big ? " card-big" : ""}"><a class="card-link" href="/${esc(p.slug)}">${thumb(p)}<span class="card-text">
<span class="kicker">${esc((p.cats || [])[0] || "Post")}</span><span class="card-title">${esc(p.title)}</span>
${summary(p.body) ? `<span class="excerpt">${esc(summary(p.body, big ? 240 : 140))}</span>` : ""}
<span class="meta">${metaLine(p)}</span></span></a></article>`;
}
function layout({ title, description, body, canonical, image, article = false }) {
  const s = store.settings;
  const yt = String(s.youtubeLinks || "").split("\n").map(x => x.trim()).filter(Boolean);
  const channel = s.youtube || yt.find(u => u.includes("@")) || "";
  const cats = allCats();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(description || s.subtitle)}">
<link rel="canonical" href="${esc(SITE_URL + (canonical || "/"))}">
<meta property="og:site_name" content="${esc(s.siteTitle)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description || s.subtitle)}">
<meta property="og:type" content="${article ? "article" : "website"}"><meta property="og:url" content="${esc(SITE_URL + (canonical || "/"))}">
<meta property="og:image" content="${esc(image ? (image.startsWith("/") ? SITE_URL + image : image) : SITE_URL + "/logo.png")}"><meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#fbf7f0" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#14121c" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/logo.png" type="image/png"><link rel="alternate" type="application/rss+xml" title="${esc(s.siteTitle)}" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Tiro+Devanagari+Marathi:ital@0;1&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=Noto+Serif+Devanagari:wght@400;600&family=Inter:wght@400;500;600&family=Noto+Sans+Devanagari:wght@400;600&display=swap">
<link rel="stylesheet" href="/site.css"></head><body${article ? ' class="reading"' : ""}>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><symbol id="lotus" viewBox="0 0 64 64"><path fill="currentColor" d="M32 10c5 7 7 14 7 20 0 5-3 9-7 12-4-3-7-7-7-12 0-6 2-13 7-20zm-17 12c7 1 12 5 15 10 2 4 2 9 0 13-5 0-10-2-13-6-3-5-3-11-2-17zm34 0c1 6 1 12-2 17-3 4-8 6-13 6-2-4-2-9 0-13 3-5 8-9 15-10zM8 40c6-1 12 1 17 5 2 2 4 4 5 6-6 2-12 1-17-2-2-2-4-5-5-9zm48 0c-1 4-3 7-5 9-5 3-11 4-17 2 1-2 3-4 5-6 5-4 11-6 17-5z"/></symbol></svg>
${article ? '<div class="progress" aria-hidden="true"><i id="prog"></i></div>' : ""}
<header class="top"><div class="shell top-in">
<a class="brand" href="/"><img src="/logo.png" alt="" width="40" height="40"><span><b>${esc(s.siteTitle)}</b><small>bhikshuk.com</small></span></a>
<nav class="primary" aria-label="Main"><a href="/">Home</a><a href="/themessage-of-the-immortal-love">The Message</a><a href="/about">About</a><a href="/contact">Contact</a></nav>
<div class="top-act"><form class="qs" action="/search" role="search"><input name="q" type="search" placeholder="Search posts" aria-label="Search posts"></form>
<details class="drawer"><summary aria-label="All pages"><span class="burger"><i></i><i></i><i></i></span><span class="dl">Menu</span></summary>
<div class="drawer-panel"><form action="/search" class="dsearch"><input name="q" type="search" placeholder="Search posts" aria-label="Search posts"></form>
<p class="dh">Pages</p><div class="dlinks">${navHtml()}</div>
${cats.length ? `<p class="dh">Topics</p><div class="dlinks">${cats.map(c => `<a href="/category/${catSlug(c)}">${esc(c)}</a>`).join("")}</div>` : ""}
</div></details></div></div></header>
<main id="main">${body}</main>
<footer class="foot"><div class="shell foot-grid">
<div class="foot-brand"><img src="/logo.png" alt="" width="64" height="64"><p class="fb-title">${esc(s.siteTitle)}</p><p>${esc(s.tagline)}</p>${channel ? `<a class="yt-btn" href="${esc(channel)}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8zM9.7 15.1V8.9l5.8 3.1-5.8 3.1z"/></svg>Watch on YouTube</a>` : ""}</div>
<div><p class="fh">Pages</p><div class="flinks">${menuPages().map(p => `<a href="/${esc(p.slug)}">${esc(SHORT[p.slug] || p.title)}</a>`).join("")}<a href="/privacy-policy">Privacy Policy</a></div></div>
<div><p class="fh">Topics</p><div class="flinks">${cats.map(c => `<a href="/category/${catSlug(c)}">${esc(c)}</a>`).join("")}<a href="/archive">All posts by month</a></div>
${yt.length ? `<p class="fh" style="margin-top:22px">YouTube</p><div class="flinks">${yt.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">${u.includes("@") ? esc("@" + u.split("@")[1]) : u.includes("shorts") ? "YouTube Shorts" : "Community post " + (i + 1)}</a>`).join("")}</div>` : ""}</div>
</div><div class="shell foot-end">${s.footerLine ? `<p>${esc(s.footerLine)}</p>` : ""}<p>${esc(s.footer)} · <a href="/admin">Owner login</a></p></div></footer>
${article ? `<script>(()=>{const b=document.getElementById("prog"),a=document.querySelector(".prose");if(!b||!a)return;const f=()=>{const r=a.getBoundingClientRect(),h=r.height-innerHeight;b.style.transform="scaleX("+Math.min(1,Math.max(0,-r.top/(h>0?h:1)))+")"};addEventListener("scroll",f,{passive:true});f();const c=document.getElementById("copy");c&&c.addEventListener("click",()=>{navigator.clipboard&&navigator.clipboard.writeText(location.href).then(()=>{c.textContent="Link copied"},()=>{})})})();</script>` : ""}
</body></html>`;
}
function listPage(req, res, { title, heading, intro, items, base, canonical }) {
  const url = new URL(req.url, "http://x");
  const pages = Math.max(1, Math.ceil(items.length / PER_PAGE));
  const page = Math.min(pages, Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const isHome = base === "/";
  const s = store.settings;
  const sep = base.includes("?") ? "&" : "?";
  const href = n => n === 1 ? base : `${base}${sep}page=${n}`;
  let list = items.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  let top = "";
  if (isHome && page === 1) {
    const [lead, ...rest] = list;
    list = rest;
    top = `<section class="hero"><div class="shell hero-in">
<div class="hero-copy"><p class="eyebrow">bhikshuk.com · Mahanubhav Dharma</p><h1>${esc(s.siteTitle)}</h1><p class="hero-tag">${esc(s.tagline)}</p><p class="hero-sub">${esc(s.subtitle)}</p>
<div class="chips">${allCats().map(c => `<a href="/category/${catSlug(c)}">${esc(c)}</a>`).join("")}</div></div>
<img class="hero-logo" src="/logo.png" alt="The Kali Yuga's The Revolution of the Immortal Love, propounded by The Messenger of the Immortal Love" width="260" height="258"></div></section>
${lead ? `<section class="shell lead"><p class="sec-h">Latest</p>${card(lead, true)}</section>` : ""}`;
  } else {
    top = `<section class="shell page-head"><p class="eyebrow">${esc(intro || "Collection")}</p><h1>${esc(heading)}</h1><p class="count">${items.length} ${items.length === 1 ? "post" : "posts"}</p></section>`;
  }
  let nums = [];
  for (let n = 1; n <= pages; n++) if (n === 1 || n === pages || Math.abs(n - page) <= 1) nums.push(n); else if (nums[nums.length - 1] !== "…") nums.push("…");
  const pager = pages > 1 ? `<nav class="pager" aria-label="Pages">${page > 1 ? `<a class="pg-btn" href="${href(page - 1)}">← Newer</a>` : "<span></span>"}<span class="pg-nums">${nums.map(n => n === "…" ? "<span>…</span>" : n === page ? `<b aria-current="page">${n}</b>` : `<a href="${href(n)}">${n}</a>`).join("")}</span>${page < pages ? `<a class="pg-btn" href="${href(page + 1)}">Older →</a>` : "<span></span>"}</nav>` : "";
  send(res, 200, layout({
    title, canonical, description: s.subtitle,
    body: `${top}<section class="shell">${isHome && page === 1 && list.length ? '<p class="sec-h">More stories</p>' : ""}<div class="grid">${list.map(p => card(p)).join("") || (items.length ? "" : '<p class="empty">Nothing found. Try another word.</p>')}</div>${pager}</section>`
  }));
}
function itemPage(res, it, preview = false) {
  const vids = (it.videos || []).map(ytId).filter(Boolean).map(video).join("");
  const isPost = it.type === "post";
  const all = posts(), i = all.findIndex(x => x.id === it.id);
  const related = isPost ? all.filter(x => x.id !== it.id && x.cats.some(c => it.cats.includes(c))).slice(0, 3) : [];
  const share = encodeURIComponent(SITE_URL + "/" + it.slug), tx = encodeURIComponent(it.title);
  send(res, 200, layout({
    article: true, title: `${it.title} – ${store.settings.siteTitle}`, canonical: "/" + it.slug, description: summary(it.body, 160), image: firstImage(it),
    body: `<article class="article">${preview ? '<p class="shell-narrow tnote">Preview: this is a draft. Only you can see it.</p>' : ""}
<header class="shell-narrow art-head">
${isPost ? `<p class="eyebrow">${(it.cats || []).map(c => `<a href="/category/${catSlug(c)}">${esc(c)}</a>`).join(" · ") || "Post"}</p>` : ""}
<h1>${esc(it.title)}</h1>
${isPost ? `<p class="meta big">${metaLine(it)}</p>` : ""}
</header>
<div class="shell-narrow prose">${renderBody(it.body)}${vids}${!String(it.body).trim() && !vids ? '<p class="empty">This post has no text yet.</p>' : ""}</div>
${isPost ? `<div class="shell-narrow share"><span>Share</span><a class="s-wa" href="https://wa.me/?text=${tx}%20${share}" target="_blank" rel="noopener">WhatsApp</a><a href="https://www.facebook.com/sharer/sharer.php?u=${share}" target="_blank" rel="noopener">Facebook</a><a href="https://twitter.com/intent/tweet?text=${tx}&url=${share}" target="_blank" rel="noopener">X</a><button id="copy" type="button">Copy link</button></div>
<aside class="shell-narrow author-box"><img src="/logo.png" alt="" width="72" height="72"><div><p class="ab-name">${esc(it.author)}</p><p>${esc(store.settings.tagline)}. ${esc(store.settings.subtitle)}</p></div></aside>
<nav class="shell-narrow prevnext">${all[i + 1] ? `<a href="/${esc(all[i + 1].slug)}"><small>← Previous</small><span>${esc(all[i + 1].title)}</span></a>` : "<span></span>"}${all[i - 1] ? `<a class="nx" href="/${esc(all[i - 1].slug)}"><small>Next →</small><span>${esc(all[i - 1].title)}</span></a>` : "<span></span>"}</nav>` : ""}
</article>
${related.length ? `<section class="shell more"><p class="sec-h">More on ${esc(it.cats[0])}</p><div class="grid">${related.map(p => card(p)).join("")}</div></section>` : ""}`
  }));
}
function archiveIndex(res) {
  const months = {};
  for (const p of posts()) (months[p.date.slice(0, 7)] ||= []).push(p);
  const name = k => new Date(k + "-15").toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  send(res, 200, layout({
    title: `All posts – ${store.settings.siteTitle}`, canonical: "/archive",
    body: `<section class="shell page-head"><p class="eyebrow">Archive</p><h1>All posts by month</h1><p class="count">${posts().length} posts</p></section>
<section class="shell-narrow archive">${Object.keys(months).map(k => `<h2><a href="/archive/${k}">${esc(name(k))}</a></h2><ul>${months[k].map(p => `<li><a href="/${esc(p.slug)}">${esc(p.title)}</a><span>${esc(usDate(p.date))}</span></li>`).join("")}</ul>`).join("")}</section>`
  }));
}
function notFound(res) {
  send(res, 404, layout({ title: "Page not found", body: `<section class="shell page-head"><p class="eyebrow">404</p><h1>This page isn't here</h1><p class="count">It may have moved. Try the search, or go back to the latest posts.</p><p><a class="pg-btn" href="/">Go to Home</a></p></section>` }));
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
  const RESERVED = ["admin", "api", "media", "search", "category", "archive", "author", "logo.png", "feed", "feed.xml", "page", "sitemap.xml", "robots.txt", "site.css", "favicon.svg"];
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
      return listPage(req, res, { title: `${cat} – ${store.settings.siteTitle}`, heading: cat, intro: "Topic", items: posts().filter(x => x.cats.includes(cat)), base: "/category/" + m[1], canonical: "/category/" + m[1] });
    }
    if (p === "/archive") return archiveIndex(res);
    if (p === "/feed.xml" || p === "/feed") {
      const items = posts().slice(0, 20).map(x => `<item><title>${esc(x.title)}</title><link>${esc(SITE_URL + "/" + x.slug)}</link><guid>${esc(SITE_URL + "/" + x.slug)}</guid><pubDate>${new Date(x.date).toUTCString()}</pubDate><description>${esc(summary(x.body, 300))}</description></item>`).join("");
      return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(store.settings.siteTitle)}</title><link>${SITE_URL}</link><description>${esc(store.settings.tagline)}</description>${items}</channel></rss>`, "application/rss+xml; charset=utf-8");
    }
    m = p.match(/^\/archive\/(\d{4}-\d{2})$/);
    if (m) {
      const label = new Date(m[1] + "-15").toLocaleDateString("en-IN", { month: "long", year: "numeric" });
      return listPage(req, res, { title: `${label} – ${store.settings.siteTitle}`, heading: label, intro: "Archive", items: posts().filter(x => x.date.startsWith(m[1])), base: "/archive/" + m[1], canonical: "/archive/" + m[1] });
    }
    m = p.match(/^\/author\/([\w-]+)$/);
    if (m) {
      const list = posts().filter(x => catSlug(x.author) === m[1]);
      if (!list.length) return notFound(res);
      return listPage(req, res, { title: `${list[0].author} – ${store.settings.siteTitle}`, heading: list[0].author, intro: "Author", items: list, base: "/author/" + m[1], canonical: "/author/" + m[1] });
    }
    if (p === "/search") {
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      const hits = q ? posts().concat(menuPages()).filter(x => (x.title + " " + x.body).toLowerCase().includes(q)) : [];
      return listPage(req, res, { title: `Search – ${store.settings.siteTitle}`, heading: q ? `“${q}”` : "Search", intro: "Search results", items: hits, base: "/search?q=" + encodeURIComponent(q), canonical: "/search" });
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
