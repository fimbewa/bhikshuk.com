"use strict";
const $ = id => document.getElementById(id);
let ITEMS = [], SETTINGS = {}, CATS = [], tab = "post", current = null;

async function call(method, url, body, type = "application/json") {
  const r = await fetch(url, { method, headers: body ? { "Content-Type": type } : {}, body: body && type === "application/json" ? JSON.stringify(body) : body, credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== "/api/login") { show("login"); throw new Error(j.error || "Please log in."); }
  if (!r.ok) throw new Error(j.error || "Something went wrong.");
  return j;
}
function show(view) {
  for (const v of ["login", "listView", "editView", "settingsView"]) $(v).hidden = v !== view;
  window.scrollTo(0, 0);
}
function msg(el, text, ok) { el.textContent = text; el.className = "msg " + (ok ? "ok" : "bad"); }
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const day = iso => (iso || new Date().toISOString()).slice(0, 10);

async function load() {
  const j = await call("GET", "/api/items");
  ITEMS = j.items; SETTINGS = j.settings; CATS = j.cats;
  renderList();
  if (tab === "settings") show("settingsView"); else show("listView");
}
function setTab(t) {
  tab = t;
  $("tPosts").setAttribute("aria-pressed", t === "post"); $("tPages").setAttribute("aria-pressed", t === "page"); $("tSettings").setAttribute("aria-pressed", t === "settings");
  if (t === "settings") { fillSettings(); show("settingsView"); $("listView").hidden = false; $("list").hidden = true; $("filter").hidden = true; $("newBtn").hidden = true; return; }
  $("list").hidden = false; $("filter").hidden = false; $("newBtn").hidden = false;
  $("newBtn").textContent = t === "post" ? "+ New post" : "+ New page";
  $("filter").placeholder = t === "post" ? "Find a post…" : "Find a page…";
  renderList(); show("listView");
}
function renderList() {
  const q = $("filter").value.trim().toLowerCase();
  let rows = ITEMS.filter(x => x.type === tab && (!q || (x.title + " " + x.body).toLowerCase().includes(q)));
  rows.sort(tab === "post" ? (a, b) => b.date.localeCompare(a.date) : (a, b) => (a.order || 0) - (b.order || 0));
  $("list").innerHTML = rows.map(x => `<button class="row-item" data-id="${esc(x.id)}"><span><b>${esc(x.title)}</b><small>${tab === "post" ? esc(new Date(x.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })) : "Menu " + (x.inMenu ? "#" + x.order : "hidden")}</small></span><span class="pill ${x.status === "draft" ? "draft" : ""}">${x.status === "draft" ? "Draft" : "Live"}</span></button>`).join("") || `<p class="help">Nothing here yet.</p>`;
}
function openEditor(it) {
  current = it || null;
  const type = it ? it.type : tab;
  $("fTitle").value = it ? it.title : "";
  $("fBody").value = it ? it.body : "";
  $("fVideos").value = it ? (it.videos || []).join("\n") : "";
  $("fStatus").value = it ? it.status : "published";
  $("fDate").value = day(it && it.date);
  $("fSlug").value = it ? it.slug : "";
  $("fAuthor").value = it ? it.author : "The Messenger of the Immortal Love";
  $("fOrder").value = it ? it.order || 0 : Math.max(0, ...ITEMS.filter(x => x.type === "page").map(x => x.order || 0)) + 1;
  $("fMenu").value = it ? (it.inMenu ? "1" : "0") : "1";
  $("newCat").value = "";
  const chosen = new Set(it ? it.cats : ["Message of the Immortal Love"]);
  $("fCats").innerHTML = CATS.map((c, i) => `<label><input type="checkbox" value="${esc(c)}" ${chosen.has(c) ? "checked" : ""}> ${esc(c)}</label>`).join("");
  $("postOnly").hidden = type !== "post"; $("pageOnly").hidden = type !== "page";
  $("delBtn").hidden = !it; $("confirmBox").hidden = true;
  $("viewLink").hidden = !it; if (it) $("viewLink").href = "/" + it.slug;
  $("editMsg").textContent = ""; $("upMsg").textContent = "";
  $("editView").dataset.type = type;
  show("editView");
}
async function saveItem() {
  const cats = [...$("fCats").querySelectorAll("input:checked")].map(x => x.value);
  if ($("newCat").value.trim()) cats.push($("newCat").value.trim());
  const body = {
    type: $("editView").dataset.type, title: $("fTitle").value, body: $("fBody").value,
    videos: $("fVideos").value.split("\n"), cats, status: $("fStatus").value,
    date: $("fDate").value ? $("fDate").value + "T10:00:00+05:30" : undefined,
    slug: $("fSlug").value, author: $("fAuthor").value, order: $("fOrder").value, inMenu: $("fMenu").value === "1"
  };
  $("saveBtn").disabled = true;
  try {
    const j = current ? await call("PUT", "/api/items/" + current.id, body) : await call("POST", "/api/items", body);
    const i = ITEMS.findIndex(x => x.id === j.item.id);
    if (i >= 0) ITEMS[i] = j.item; else ITEMS.push(j.item);
    for (const c of j.item.cats) if (!CATS.includes(c)) CATS.push(c);
    current = j.item; $("fSlug").value = j.item.slug;
    $("viewLink").hidden = false; $("viewLink").href = "/" + j.item.slug; $("delBtn").hidden = false;
    msg($("editMsg"), j.item.status === "draft" ? "Saved as draft." : "Saved. It is live on the website.", true);
  } catch (e) { msg($("editMsg"), e.message, false); }
  $("saveBtn").disabled = false;
}
// Photos from a phone are large, so shrink them to 1600px before upload.
function shrink(file) {
  return new Promise((resolve) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return resolve(file);
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => resolve(b || file), "image/jpeg", 0.85);
    };
    img.onerror = () => resolve(file);
    img.src = url;
  });
}
async function upload(file) {
  $("upMsg").textContent = "Uploading photo…";
  try {
    const blob = await shrink(file);
    const j = await call("POST", "/api/upload", blob, blob.type || file.type);
    const ta = $("fBody"), pos = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, pos) + "\n\n" + j.url + "\n\n" + ta.value.slice(pos);
    $("upMsg").textContent = "Photo added to the text. Press Save.";
  } catch (e) { $("upMsg").textContent = e.message; }
}
function fillSettings() {
  $("sTitle").value = SETTINGS.siteTitle || ""; $("sTagline").value = SETTINGS.tagline || ""; $("sSub").value = SETTINGS.subtitle || "";
  $("sBlog").value = SETTINGS.blogTitle || ""; $("sYt").value = SETTINGS.youtube || ""; $("sFoot").value = SETTINGS.footer || "";
}

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  try { await call("POST", "/api/login", { password: $("pw").value }); $("pw").value = ""; await load(); }
  catch (err) { msg($("loginMsg"), err.message, false); }
});
$("tPosts").onclick = () => setTab("post");
$("tPages").onclick = () => setTab("page");
$("tSettings").onclick = () => setTab("settings");
$("filter").oninput = renderList;
$("newBtn").onclick = () => openEditor(null);
$("list").onclick = e => { const b = e.target.closest(".row-item"); if (b) openEditor(ITEMS.find(x => x.id === b.dataset.id)); };
$("backBtn").onclick = () => setTab(tab);
$("saveBtn").onclick = saveItem;
$("photo").onchange = e => { if (e.target.files[0]) upload(e.target.files[0]); e.target.value = ""; };
$("delBtn").onclick = () => { $("confirmBox").hidden = false; };
$("delNo").onclick = () => { $("confirmBox").hidden = true; };
$("delYes").onclick = async () => {
  try { await call("DELETE", "/api/items/" + current.id); ITEMS = ITEMS.filter(x => x.id !== current.id); setTab(tab); }
  catch (e) { msg($("editMsg"), e.message, false); }
};
$("sSave").onclick = async () => {
  try {
    const j = await call("PUT", "/api/settings", { siteTitle: $("sTitle").value, tagline: $("sTagline").value, subtitle: $("sSub").value, blogTitle: $("sBlog").value, youtube: $("sYt").value, footer: $("sFoot").value });
    SETTINGS = j.settings; msg($("sMsg"), "Saved.", true);
  } catch (e) { msg($("sMsg"), e.message, false); }
};
$("pSave").onclick = async () => {
  try { await call("POST", "/api/password", { old: $("pOld").value, new: $("pNew").value }); $("pOld").value = $("pNew").value = ""; msg($("pMsg"), "Password changed.", true); }
  catch (e) { msg($("pMsg"), e.message, false); }
};
$("logoutBtn").onclick = async () => { await call("POST", "/api/logout"); show("login"); };

load().catch(() => show("login"));
