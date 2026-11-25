// Resources tab: admins add links; signed-in students browse, search, filter and star favourites.
// Loads after cloud.js. Data lives in the "resources" collection; stars stay on the student's own device.
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, deleteDoc, collection, query, orderBy, limit, getDocs, addDoc, updateDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const db = getFirestore(getApp());
const $ = function (id) { return document.getElementById(id); };
const CATS = ["Tutorials", "References", "Software", "Inspiration", "Templates", "Other"];
const TILE = ["#8fa8ff", "#c792ea", "#4fc3a1", "#f0b44c", "#5cc8e8", "#ff8a80"];
const SAVED_KEY = "cadence:savedResources";

let user = null;
let admin = false;
let items = [];
let loading = false;
let filter = "All";
let term = "";

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function saved() { try { return JSON.parse(localStorage.getItem(SAVED_KEY)) || []; } catch (e) { return []; } }
function setSaved(list) { try { localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(-200))); } catch (e) {} }
function say(text) { document.querySelectorAll(".res-msg").forEach(function (n) { n.textContent = text; }); }
function cleanUrl(raw) {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch (e) { return ""; }
}
function host(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; } }

function card(r, compact) {
  const c = mk("article", "res-card");
  const head = mk("div", "res-head");
  const ci = CATS.indexOf(r.category) >= 0 ? CATS.indexOf(r.category) : CATS.length - 1;
  const tile = mk("span", "res-tile", (r.title.trim().charAt(0) || "?").toUpperCase());
  tile.setAttribute("aria-hidden", "true");
  tile.style.color = TILE[ci];
  tile.style.backgroundColor = "color-mix(in srgb, " + TILE[ci] + " 20%, var(--panel))";
  head.appendChild(tile);
  const box = mk("div", "res-title");
  box.appendChild(mk("strong", "", r.title));
  const tags = mk("div", "tags");
  tags.appendChild(mk("span", "chip", r.category));
  const h = host(r.url);
  if (h) tags.appendChild(mk("span", "chip", h));
  box.appendChild(tags);
  head.appendChild(box);

  const star = mk("button", "res-star", "");
  star.type = "button";
  function paintStar() {
    const on = saved().indexOf(r.id) >= 0;
    star.textContent = on ? "★" : "☆";
    star.setAttribute("aria-pressed", on ? "true" : "false");
    star.setAttribute("aria-label", (on ? "Remove from saved: " : "Save: ") + r.title);
  }
  paintStar();
  star.onclick = function () {
    const list = saved();
    const i = list.indexOf(r.id);
    if (i >= 0) list.splice(i, 1); else list.push(r.id);
    setSaved(list);
    renderAll();
  };
  head.appendChild(star);
  c.appendChild(head);

  if (r.desc) c.appendChild(mk("p", "note", r.desc));
  const embed = !compact && typeof embedUrl === "function" ? embedUrl(r.url) : "";
  if (embed) {
    const f = document.createElement("iframe");
    f.className = "player";
    f.src = embed;
    f.title = "Video: " + r.title;
    f.setAttribute("allow", "fullscreen; picture-in-picture");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.loading = "lazy";
    c.appendChild(f);
  }
  const row = mk("div", "row");
  const a = mk("a", "btn", "Open link");
  a.href = r.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  row.appendChild(a);
  if (admin && !compact) {
    const edit = mk("button", "secondary", "Edit");
    edit.type = "button";
    edit.onclick = function () { c.replaceWith(editForm(r)); };
    row.appendChild(edit);
    const del = mk("button", "secondary", "Delete");
    del.type = "button";
    del.onclick = async function () {
      if (!confirm("Delete \"" + r.title + "\" for everyone?")) return;
      try { await deleteDoc(doc(db, "resources", r.id)); items = items.filter(function (x) { return x.id !== r.id; }); renderAll(); }
      catch (e) { say("Couldn't delete. Check your connection and that you're an admin."); }
    };
    row.appendChild(del);
  }
  c.appendChild(row);
  return c;
}

function editForm(r) {
  const f = mk("form", "res-card res-edit");
  function field(label, el) { const l = mk("label", "", label); el.classList.add("field"); l.appendChild(el); f.appendChild(l); return el; }
  const t = field("Title", mk("input")); t.value = r.title; t.maxLength = 100; t.required = true;
  const u = field("Link", mk("input")); u.value = r.url; u.maxLength = 500; u.inputMode = "url"; u.autocapitalize = "off"; u.required = true;
  const cat = field("Category", mk("select"));
  CATS.forEach(function (c) { const o = mk("option", "", c); o.value = c; cat.appendChild(o); });
  cat.value = r.category;
  const d = field("Description", mk("textarea")); d.rows = 3; d.maxLength = 300; d.value = r.desc;
  const msg = mk("p", "hint"); msg.setAttribute("aria-live", "polite"); f.appendChild(msg);
  const row = mk("div", "row");
  const save = mk("button", "", "Save"); save.type = "submit";
  const cancel = mk("button", "secondary", "Cancel"); cancel.type = "button";
  cancel.onclick = renderAll;
  row.appendChild(save); row.appendChild(cancel); f.appendChild(row);
  f.onsubmit = async function (e) {
    e.preventDefault();
    const title = t.value.trim().slice(0, 100), url = cleanUrl(u.value.trim());
    if (!title) { msg.textContent = "Add a title."; return; }
    if (!url) { msg.textContent = "That link doesn't look right."; return; }
    const data = { title: title, url: url.slice(0, 500), category: cat.value, desc: d.value.trim().slice(0, 300) };
    save.disabled = true;
    try {
      await updateDoc(doc(db, "resources", r.id), data);
      items = items.map(function (x) { return x.id === r.id ? Object.assign({}, x, data) : x; });
      renderAll();
    } catch (err) {
      save.disabled = false;
      msg.textContent = "Couldn't save. Check your connection and that your rules let admins update resources.";
    }
  };
  setTimeout(function () { t.focus(); }, 0);
  return f;
}

function renderPills() {
  const box = $("resPills");
  box.textContent = "";
  const names = ["All", "Saved"].concat(CATS.filter(function (c) { return items.some(function (r) { return r.category === c; }); }));
  if (names.indexOf(filter) < 0) filter = "All";
  names.forEach(function (n) {
    const b = mk("button", "res-pill", n);
    b.type = "button";
    b.setAttribute("aria-pressed", filter === n ? "true" : "false");
    b.onclick = function () { filter = n; renderAll(); };
    box.appendChild(b);
  });
}

function renderAll() {
  const out = $("resList");
  if (!user) { out.textContent = ""; renderPills(); return; }
  renderPills();
  const savedIds = saved();
  const q = term.trim().toLowerCase();
  const shown = items.filter(function (r) {
    if (filter === "Saved" && savedIds.indexOf(r.id) < 0) return false;
    if (filter !== "All" && filter !== "Saved" && r.category !== filter) return false;
    return !q || (r.title + " " + r.desc + " " + r.category + " " + host(r.url)).toLowerCase().indexOf(q) >= 0;
  });
  out.textContent = "";
  shown.forEach(function (r) { out.appendChild(card(r, false)); });
  if (!loading) {
    if (!items.length) say("No resources yet. Check back soon.");
    else if (!shown.length) say(filter === "Saved" ? "Nothing saved yet. Tap the star on a resource to keep it here." : "No matches.");
    else say("");
  }
}

async function load() {
  if (!user || loading) { renderAll(); return; }
  loading = true;
  say("Loading…");
  try {
    const snap = await getDocs(query(collection(db, "resources"), orderBy("createdAt", "desc"), limit(100)));
    items = snap.docs.map(function (d) {
      const x = d.data();
      const url = cleanUrl(String(x.url || ""));
      if (!url || typeof x.title !== "string" || !x.title.trim()) return null;
      return {
        id: d.id, title: x.title.trim().slice(0, 100), url: url,
        desc: typeof x.desc === "string" ? x.desc.trim().slice(0, 300) : "",
        category: CATS.indexOf(x.category) >= 0 ? x.category : "Other"
      };
    }).filter(Boolean);
    loading = false;
    renderAll();
  } catch (e) {
    loading = false;
    items = [];
    renderAll();
    say("Couldn't load resources. Check your connection, and that the resources rules are published in Firebase.");
  }
  loading = false;
}

// Admin form (on the Profile tab)
CATS.forEach(function (c) { const o = document.createElement("option"); o.value = c; o.textContent = c; $("resCat").appendChild(o); });
$("resForm").onsubmit = async function (e) {
  e.preventDefault();
  if (!user || !admin) return;
  const msg = $("resAdminMsg");
  const title = $("resTitleIn").value.trim().slice(0, 100);
  const url = cleanUrl($("resUrl").value.trim());
  if (!title) { msg.textContent = "Add a title."; return; }
  if (!url) { msg.textContent = "That link doesn't look right."; return; }
  const btn = $("resSubmit");
  btn.disabled = true;
  try {
    await addDoc(collection(db, "resources"), {
      title: title, category: $("resCat").value, url: url.slice(0, 500),
      desc: $("resDesc").value.trim().slice(0, 300), createdAt: serverTimestamp()
    });
    $("resForm").reset();
    msg.textContent = "Added. Students will see it in Resources.";
    await load();
  } catch (err) {
    msg.textContent = "Couldn't add it. Make sure the resources rules are published and your account is in the admins collection.";
  }
  btn.disabled = false;
};

$("resSearch").addEventListener("input", function () { term = this.value; renderAll(); });
$("tab-resources").addEventListener("click", load);
document.addEventListener("visibilitychange", function () { if (!document.hidden && user) load(); });

onAuthStateChanged(getAuth(), async function (u) {
  user = u || null;
  admin = false;
  if (user) {
    try { admin = (await getDoc(doc(db, "admins", user.uid))).exists(); } catch (e) {}
  } else {
    items = [];
    say("Sign in with Google to see the resources.");
  }
  $("adminResSection").hidden = !admin;
  if (user) load(); else renderAll();
});
