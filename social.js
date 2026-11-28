// Profiles and friends (Firebase). Loads after cloud.js. Needs the rules in firestore-rules.txt.
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, query, where, getDocs, onSnapshot, writeBatch, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { COLORS, getProfile, setCached, avatarEl, paintAva } from "./avatars.js";

const db = getFirestore(getApp());
const auth = getAuth(getApp());
const $ = function (id) { return document.getElementById(id); };
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
let me = null, mine = null, color = COLORS[0], unsub = null, photoData = "";
let incoming = [], outgoing = [], friends = [], blocked = [];
let pendingAdd = (new URLSearchParams(location.search).get("add") || "").toLowerCase();

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function nameOf(p) { return (p && p.nickname) || "Cadence user"; }
function avatar(p, lg) { return avatarEl(p, lg ? "lg" : "", nameOf(p)); }
function pairId(a, b) { return [a, b].sort().join("_"); }
let target = $("personBox"), closeFn = null, modalMsg = null;
function say(id, t) { $(id).textContent = t || ""; if (id === "friendMsg" && modalMsg) modalMsg.textContent = t || ""; }

const dcache = {};
async function getDetails(uid) {
  if (dcache[uid]) return dcache[uid];
  try { const sn = await getDoc(doc(db, "profileDetails", uid)); return (dcache[uid] = sn.exists() ? sn.data() : {}); }
  catch (e) { return {}; }
}

function relation(uid) {
  if (me && uid === me.uid) return "self";
  if (friends.some(function (f) { return f.uid === uid; })) return "friends";
  if (incoming.some(function (r) { return r.from === uid; })) return "incoming";
  if (outgoing.some(function (r) { return r.to === uid; })) return "outgoing";
  return "none";
}

// ----- My profile -----
// Banner is a small JPEG stored as text, same idea as the avatar photo. Nothing else is allowed in a CSS url().
function okBanner(b) { return typeof b === "string" && b.length <= 95000 && /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(b); }

function paintMine() {
  if (window.PC) window.PC.apply(mine);
  const has = !!mine;
  $("profEditBtn").hidden = !me;
  $("profEditBtn").textContent = has ? "Edit" : "Set up profile";
  if (has) { $("profileName").textContent = mine.nickname; try { localStorage.setItem("cadence:displayName", mine.nickname); } catch (e) {} }
  $("profileHandle").hidden = !has;
  $("profileHandle").textContent = has ? "@" + mine.handle : "";
  const mt = has && mine.course ? tagChip(mine.course) : null;
  if (mt) { $("profileHandle").appendChild(document.createTextNode(" ")); $("profileHandle").appendChild(mt); }
  ["profileAvatar", "headerAvatar"].forEach(function (id) {
    if (has && mine.photo) { const el = $(id); el.textContent = ""; const im = mk("img"); im.src = mine.photo; im.alt = ""; el.appendChild(im); }
  });
  $("profileBio").hidden = !(has && mine.bio);
  $("profileBio").textContent = has ? mine.bio : "";
}

function openForm(open) {
  $("profForm").hidden = !open;
  if (!open) return;
  const base = mine || { nickname: me.displayName ? me.displayName.trim().split(/\s+/)[0] : "", handle: "", bio: "", course: "", color: COLORS[0] };
  $("pfNick").value = base.nickname; $("pfHandle").value = base.handle;
  $("pfBio").value = base.bio || ""; $("pfCourse").value = base.course || ""; paintTagBtn();
  color = base.color || COLORS[0]; photoData = base.photo || ""; paintColors(); say("pfMsg", "");
  if (window.PC) window.PC.fill();
  $("pfNick").focus();
}

function paintPhoto() {
  paintAva($("pfPhoto"), { nickname: $("pfNick").value || "?", color: color, photo: photoData });
  $("pfUnpick").hidden = !photoData;
  $("pfPick").textContent = photoData ? "Change photo" : "Add photo";
}
function shrinkAvatar(file) {
  return new Promise(function (resolve, reject) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { reject(new Error("type")); return; }
    const url = URL.createObjectURL(file), img = new Image();
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("read")); };
    img.onload = function () {
      URL.revokeObjectURL(url);
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - side) / 2, sy = (img.naturalHeight - side) / 2;
      let size = 128, q = 0.8;
      for (let i = 0; i < 10; i++) {
        const cv = document.createElement("canvas"); cv.width = cv.height = size;
        const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, size, size);
        cx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        const out = cv.toDataURL("image/jpeg", q);
        if (out.length <= 12000) { resolve(out); return; }
        if (q > 0.5) q -= 0.1; else size = Math.round(size * 0.85);
      }
      reject(new Error("big"));
    };
    img.src = url;
  });
}
$("pfPick").onclick = function () { $("pfFile").click(); };
$("pfUnpick").onclick = function () { photoData = ""; $("pfFile").value = ""; paintPhoto(); };
$("pfNick").addEventListener("input", paintPhoto);
$("pfFile").onchange = async function () {
  const f = $("pfFile").files && $("pfFile").files[0];
  if (!f) return;
  try { photoData = await shrinkAvatar(f); say("pfMsg", ""); }
  catch (err) { say("pfMsg", err.message === "type" ? "Use a JPG, PNG or WebP photo." : "Couldn't use that photo. Try another."); }
  $("pfFile").value = ""; paintPhoto();
};

function paintColors() {
  paintPhoto();
  const box = $("pfColors"); box.textContent = "";
  COLORS.forEach(function (c) {
    const b = mk("button"); b.type = "button"; b.style.backgroundColor = c;
    b.setAttribute("aria-label", "Colour " + c); b.setAttribute("aria-pressed", String(c === color));
    b.onclick = function () { color = c; paintColors(); };
    box.appendChild(b);
  });
}

$("profEditBtn").onclick = function () { openForm($("profForm").hidden); };
$("pfCancel").onclick = function () { openForm(false); };
$("profForm").onsubmit = async function (e) {
  e.preventDefault();
  const handle = $("pfHandle").value.trim().replace(/^@/, "").toLowerCase();
  const nick = $("pfNick").value.trim();
  if (!nick) { say("pfMsg", "Add a nickname."); return; }
  if (!HANDLE_RE.test(handle)) { say("pfMsg", "Handle: 3-20 letters, numbers or _."); return; }
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    const old = mine ? mine.handle : "";
    if (handle !== old) {
      const taken = await getDoc(doc(db, "handles", handle));
      if (taken.exists() && taken.data().uid !== me.uid) { say("pfMsg", "That handle is taken."); return; }
    }
    const x = window.PC ? window.PC.collect() : { banner: "", theme: "", links: [] };
    const p = { uid: me.uid, nickname: nick.slice(0, 30), handle: handle, color: color, photo: photoData, banner: x.banner, theme: x.theme, updatedAt: Date.now() };
    const det = { bio: $("pfBio").value.trim().slice(0, 160), course: $("pfCourse").value.trim().slice(0, 60), links: x.links };
    const batch = writeBatch(db);
    batch.set(doc(db, "profiles", me.uid), p);
    batch.set(doc(db, "profileDetails", me.uid), det);
    if (handle !== old) {
      batch.set(doc(db, "handles", handle), { uid: me.uid });
      if (old) batch.delete(doc(db, "handles", old));
    }
    await batch.commit();
    mine = Object.assign({}, p, det); setCached(me.uid, p); dcache[me.uid] = det; paintMine(); openForm(false); document.dispatchEvent(new Event("cadence:profile"));
  } catch (err) { say("pfMsg", "Couldn't save. Make sure the new Firestore rules are published."); }
  finally { if (btn) btn.disabled = false; }
};

// ----- Lists -----
function item(p, acts, onOpen) {
  const row = mk("div", "soc-item");
  row.appendChild(avatar(p));
  const who = mk("button", "who"); who.type = "button";
  who.appendChild(mk("strong", "", nameOf(p)));
  who.appendChild(mk("small", "", p && p.handle ? "@" + p.handle : ""));
  who.onclick = function () { onOpen(p); };
  row.appendChild(who);
  const a = mk("div", "acts");
  acts.forEach(function (x) {
    const b = mk("button", x.secondary ? "secondary" : "", x.label); b.type = "button";
    b.onclick = x.run; a.appendChild(b);
  });
  row.appendChild(a);
  return row;
}

async function paintLists() {
  const reqs = await Promise.all(incoming.map(async function (r) { return { r: r, p: await getProfile(r.from) }; }));
  const sent = await Promise.all(outgoing.map(async function (r) { return { r: r, p: await getProfile(r.to) }; }));
  const rl = $("reqList"); rl.textContent = "";
  reqs.forEach(function (x) {
    if (!x.p) return;
    rl.appendChild(item(x.p, [
      { label: "Accept", run: function () { accept(x.p.uid); } },
      { label: "Decline", secondary: true, run: function () { dropRequest(x.r.from + "_" + me.uid); } },
      { label: "Block", secondary: true, run: function () { block(x.p.uid); } }
    ], showPerson));
  });
  sent.forEach(function (x) {
    if (!x.p) return;
    rl.appendChild(item(x.p, [{ label: "Cancel", secondary: true, run: function () { dropRequest(me.uid + "_" + x.r.to); } }], showPerson));
    rl.lastChild.querySelector("small").textContent += " · request sent";
  });
  $("reqWrap").hidden = !rl.children.length;
  $("reqCount").textContent = incoming.length ? "(" + incoming.length + " new)" : "";
  const fl = $("friendList"); fl.textContent = "";
  friends.forEach(function (p) { fl.appendChild(item(p, [], showPerson)); });
  $("friendEmpty").hidden = friends.length > 0;
  const bl = $("blockList"); bl.textContent = "";
  const bps = await Promise.all(blocked.map(getProfile));
  bps.forEach(function (bp) {
    if (bp) bl.appendChild(item(bp, [{ label: "Unblock", secondary: true, run: function () { unblock(bp.uid); } }], showPerson));
  });
  $("blockWrap").hidden = !bl.children.length;
  $("blockCount").textContent = String(bl.children.length);
  document.dispatchEvent(new Event("cadence:friends"));
}

async function loadFriends() {
  const snap = await getDocs(query(collection(db, "friendships"), where("users", "array-contains", me.uid)));
  const ids = snap.docs.map(function (d) { return d.data().users.filter(function (u) { return u !== me.uid; })[0]; });
  const ps = await Promise.all(ids.map(getProfile));
  friends = ps.filter(Boolean);
}
async function loadOutgoing() {
  const snap = await getDocs(query(collection(db, "friendRequests"), where("from", "==", me.uid)));
  outgoing = snap.docs.map(function (d) { return d.data(); });
}
async function loadBlocked() {
  const snap = await getDocs(query(collection(db, "blocks"), where("by", "==", me.uid)));
  blocked = snap.docs.map(function (d) { return d.data().blocked; });
}
async function refresh() {
  try { await Promise.all([loadFriends(), loadOutgoing(), loadBlocked()]); await paintLists(); say("friendMsg", ""); }
  catch (e) { say("friendMsg", "Couldn't load friends. Make sure the new Firestore rules are published."); }
}

// ----- Person card -----
function closePerson() { if (closeFn) closeFn(); else $("personBox").textContent = ""; }
// ----- Tags: BSEMC year tag with an icon, saved in the course field as "BSEMC 3A|3" (no new Firestore fields needed) -----
const TAGS = [{ n: "BSEMC 1A", y: "1ST" }, { n: "BSEMC 2A", y: "2ND" }, { n: "BSEMC 3A", y: "3RD" }, { n: "BSEMC 4A", y: "4TH" }];
const TAG_ICONS = 5;
function parseTag(raw) {
  const m = String(raw || "").split("|"), ic = parseInt(m[1], 10);
  return { name: m[0].trim(), icon: ic >= 1 && ic <= TAG_ICONS ? ic : 0 };
}
function tagValue(name, icon) { return name ? name + "|" + (icon || 1) : ""; }
function tagChip(raw) {
  const t = parseTag(raw);
  if (!t.name) return null;
  const c = mk("span", "dc-tag");
  if (t.icon) { const im = mk("img"); im.src = "tags/tag" + t.icon + ".png"; im.alt = ""; c.appendChild(im); }
  c.appendChild(mk("span", "", t.name));
  return c;
}
function paintTagBtn() {
  const b = $("pfTagBtn"); if (!b) return;
  b.textContent = "";
  const chip = tagChip($("pfCourse").value);
  b.appendChild(chip || mk("span", "pf-tagnone", "None"));
  const nx = mk("span", "pf-tagnext"); nx.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';
  b.appendChild(nx);
}
function openTagPicker() {
  const cur = parseTag($("pfCourse").value);
  let name = TAGS.some(function (t) { return t.n === cur.name; }) ? cur.name : "", icon = cur.icon || 1;
  const ov = mk("div", "tg-sheet");
  const panel = mk("div", "tg-panel"); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Change Tag");
  const done = mk("button", "tg-done", "Done"); done.type = "button";
  const iconsBox = mk("div", "tg-icons"), list = mk("div", "tg-list");
  panel.append(mk("div", "tg-grip"), mk("h3", "tg-title", "Change Tag"), done, mk("div", "tg-label", "Tag icon"), iconsBox, mk("div", "tg-label", "Tag"), list);
  ov.appendChild(panel);
  function commit() { $("pfCourse").value = tagValue(name, icon); paintTagBtn(); }
  function draw() {
    iconsBox.textContent = "";
    for (let i = 1; i <= TAG_ICONS; i++) {
      const b = mk("button", "tg-icon"); b.type = "button";
      b.setAttribute("aria-label", "Icon " + i); b.setAttribute("aria-pressed", icon === i ? "true" : "false");
      const im = mk("img"); im.src = "tags/tag" + i + ".png"; im.alt = ""; b.appendChild(im);
      b.onclick = function () { icon = i; commit(); draw(); };
      iconsBox.appendChild(b);
    }
    list.textContent = "";
    [{ n: "", y: "" }].concat(TAGS).forEach(function (t) {
      const on = name === t.n;
      const r = mk("button", "tg-row" + (on ? " on" : "")); r.type = "button";
      r.setAttribute("role", "radio"); r.setAttribute("aria-checked", on ? "true" : "false");
      const txt = mk("span", "tg-txt"); txt.appendChild(mk("strong", "", t.n || "None"));
      if (t.y) txt.appendChild(mk("small", "", t.y + " year"));
      r.appendChild(txt);
      if (t.n) r.appendChild(tagChip(tagValue(t.n, icon)));
      r.appendChild(mk("span", "tg-radio"));
      r.onclick = function () { name = t.n; commit(); draw(); };
      list.appendChild(r);
    });
  }
  function close() { ov.remove(); document.removeEventListener("keydown", esc, true); $("pfTagBtn").focus(); }
  function esc(e) { if (e.key === "Escape") { e.stopImmediatePropagation(); e.preventDefault(); close(); } }
  done.onclick = close;
  ov.onclick = function (e) { if (e.target === ov) close(); };
  document.addEventListener("keydown", esc, true);
  draw();
  document.body.appendChild(ov);
  done.focus();
}
if ($("pfTagBtn")) $("pfTagBtn").onclick = openTagPicker;

function mutualProjects(uid) {
  const api = window.CadenceSharedProjects, all = api && api.list ? api.list() : [];
  return all.filter(function (x) { return me && Array.isArray(x.members) && x.members.indexOf(me.uid) >= 0 && x.members.indexOf(uid) >= 0; });
}
// Banner picture, else the person's theme colour, else their avatar colour
function paintBanner(el, p) {
  if (!p) return;
  if (okBanner(p.banner)) { el.style.backgroundImage = 'url("' + p.banner + '")'; return; }
  const hex = /^#[0-9a-fA-F]{6}$/;
  const c = hex.test(p.theme || "") ? p.theme : (hex.test(p.color || "") ? p.color : "");
  if (c) el.style.backgroundColor = c;
}
// Discord style profile card: banner, big avatar, names, mutual projects, bio, message box
function showPerson(p) {
  const box = target; box.textContent = "";
  if (!p) return;
  const rel = relation(p.uid), inner = rel === "friends" || rel === "self";
  const card = mk("div", "soc-person dc-card");
  const bn = mk("div", "dc-banner"); paintBanner(bn, p);
  const x = mk("button", "dc-x", "\u2715"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.onclick = closePerson;
  bn.appendChild(x);
  const ava = mk("div", "dc-ava"); ava.appendChild(avatar(p, true));
  card.append(bn, ava);
  const body = mk("div", "dc-body");
  body.appendChild(mk("strong", "dc-name", nameOf(p)));
  const sub = mk("div", "dc-sub", p.handle ? "@" + p.handle : "");
  body.appendChild(sub);
  if (rel !== "self") {
    const mu = mutualProjects(p.uid).length;
    if (mu) body.appendChild(mk("div", "dc-mutual", mu + (mu === 1 ? " Mutual Project" : " Mutual Projects")));
  }
  if (inner) {
    const bio = mk("p", "dc-bio"); bio.hidden = true; body.appendChild(bio);
    getDetails(p.uid).then(function (d) {
      const tc = d.course ? tagChip(d.course) : null;
      if (tc) { sub.appendChild(document.createTextNode(" ")); sub.appendChild(tc); }
      if (d.bio) { bio.textContent = d.bio; bio.hidden = false; }
      (Array.isArray(d.links) ? d.links.slice(0, 3) : []).forEach(function (u) {
        const safe = typeof safeUrl === "function" ? safeUrl(u) : "";
        if (!safe) return;
        const a = mk("a", "soc-link", safe.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""));
        a.href = safe; a.target = "_blank"; a.rel = "noopener noreferrer";
        body.insertBefore(a, form || row);
      });
    });
  } else body.appendChild(mk("small", "dc-hint", "Bio and course are only visible to friends."));
  let form = null;
  if (rel === "friends") {
    form = mk("form", "dc-msg"); form.autocomplete = "off";
    const input = mk("input", "field"); input.type = "text"; input.maxLength = 2000;
    input.placeholder = "Message @" + nameOf(p); input.setAttribute("aria-label", "Message " + nameOf(p));
    form.appendChild(input);
    form.onsubmit = function (e) {
      e.preventDefault();
      const t = input.value.trim();
      closePerson();
      if (window.CadenceHub) window.CadenceHub.open(t ? { dm: p.uid, send: t } : { dm: p.uid });
    };
    body.appendChild(form);
  }
  const row = mk("div", "row dc-acts");
  const btn = function (label, run, sec) { const b = mk("button", sec ? "secondary" : "", label); b.type = "button"; b.onclick = run; row.appendChild(b); return b; };
  if (rel === "none") btn("Add friend", function () { addFriend(p); });
  else if (rel === "incoming") btn("Accept request", function () { accept(p.uid); });
  else if (rel === "outgoing") btn("Request sent. Cancel?", function () { dropRequest(me.uid + "_" + p.uid); }, true);
  else if (rel === "friends") {
    btn("View Showcase", function () { viewShowcase(p, card); }, true);
    btn("Remove", function () { unfriend(p); }, true);
  }
  else if (rel === "self") btn("Edit Profile", function () { closePerson(); const b = $("profEditBtn"); if (b) b.click(); });
  body.appendChild(row);
  card.appendChild(body); box.appendChild(card);
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ----- Showcase for friends -----
const S = window.CadenceShare;
async function viewShowcase(p, card) {
  let box = card.querySelector(".soc-showcase");
  if (box) { box.remove(); return; }
  box = mk("div", "soc-showcase"); card.appendChild(box);
  box.appendChild(mk("p", "hint", "Loading…"));
  try {
    const snap = await getDoc(doc(db, "friendShowcases", p.uid));
    box.textContent = "";
    const items = snap.exists() ? S.itemsFrom(snap.data().items) : [];
    if (!snap.exists()) box.appendChild(mk("p", "hint", nameOf(p) + " hasn't shared their Showcase with friends."));
    else if (!items.length) box.appendChild(mk("p", "hint", "Nothing in their Showcase yet."));
    items.forEach(function (it) { box.appendChild(S.card(it)); });
  } catch (e) { box.textContent = ""; box.appendChild(mk("p", "hint", "Couldn't load their Showcase.")); }
}

async function publishShowcase() {
  if (!me || !$("friendShowToggle").checked) return;
  lastShow = showRaw();
  try {
    await setDoc(doc(db, "friendShowcases", me.uid), { items: S.itemsFrom(Storage.snapshot().showcase), updatedAt: Date.now() });
    say("friendMsg", "");
  } catch (e) { say("friendMsg", "Couldn't update your Showcase for friends. Make sure the new Firestore rules are published."); }
}
// Keep friends' copy current: check for Showcase edits every few seconds while sharing is on
let lastShow = "";
function showRaw() { try { return localStorage.getItem("cadence:showcase") || ""; } catch (e) { return ""; } }
setInterval(function () {
  if (!me || !$("friendShowToggle").checked || document.hidden) return;
  const now = showRaw();
  if (now !== lastShow) { lastShow = now; publishShowcase(); }
}, 5000);
$("friendShowToggle").onchange = async function () {
  if (!me) return;
  if (this.checked) { await publishShowcase(); return; }
  try { await deleteDoc(doc(db, "friendShowcases", me.uid)); say("friendMsg", "Friends can no longer see your Showcase."); }
  catch (e) { this.checked = true; say("friendMsg", "Couldn't turn that off. Try again."); }
};

// ----- Actions -----
async function act(fn, errMsg) {
  try { await fn(); } catch (e) {
    say("friendMsg", e && e.message === "limit" ? "You've sent a lot of requests. Try again in an hour." : (errMsg || "That didn't work. Check your connection and the Firestore rules."));
    return false;
  }
  say("friendMsg", ""); return true;
}
// Server-checked limit: 20 requests per hour, tracked in rateLimits/{uid} and written in the same batch as the request
const RATE_MAX = 20, RATE_WINDOW = 3600000;
async function sendRequest(toUid) {
  const rref = doc(db, "rateLimits", me.uid);
  const rs = await getDoc(rref);
  const b = writeBatch(db);
  if (!rs.exists()) b.set(rref, { count: 1, windowStart: serverTimestamp(), last: serverTimestamp() });
  else {
    const d = rs.data();
    if (Date.now() - d.windowStart.toMillis() >= RATE_WINDOW) b.update(rref, { count: 1, windowStart: serverTimestamp(), last: serverTimestamp() });
    else if (d.count >= RATE_MAX) throw new Error("limit");
    else b.update(rref, { count: d.count + 1, last: serverTimestamp() });
  }
  b.set(doc(db, "friendRequests", me.uid + "_" + toUid), { from: me.uid, to: toUid, createdAt: serverTimestamp() });
  return b.commit();
}
async function addFriend(p) {
  if (!mine) { say("friendMsg", "Set up your own profile first."); if (closeFn) { closeFn(); $("avatarBtn").click(); } openForm(true); return; }
  if (relation(p.uid) === "incoming") return accept(p.uid);
  if (outgoing.length >= 20) { say("friendMsg", "You have 20 requests waiting. Cancel some before sending more."); return; }
  const ok = await act(function () { return sendRequest(p.uid); }, "Couldn't send that request.");
  if (ok) { await refresh(); showPerson(p); }
}
async function accept(uid) {
  const ok = await act(function () {
    const b = writeBatch(db);
    b.set(doc(db, "friendships", pairId(me.uid, uid)), { users: [me.uid, uid].sort(), createdAt: Date.now() });
    b.delete(doc(db, "friendRequests", uid + "_" + me.uid));
    if (outgoing.some(function (r) { return r.to === uid; })) b.delete(doc(db, "friendRequests", me.uid + "_" + uid));
    return b.commit();
  });
  if (ok) { incoming = incoming.filter(function (r) { return r.from !== uid; }); await refresh(); const p = await getProfile(uid); showPerson(p); }
}
async function dropRequest(id) {
  if (await act(function () { return deleteDoc(doc(db, "friendRequests", id)); })) {
    incoming = incoming.filter(function (r) { return r.from + "_" + r.to !== id; });
    await refresh(); $("personBox").textContent = "";
  }
}
async function block(uid) {
  if (!confirm("Block this person? Their request is removed and they can't send you another.")) return;
  const ok = await act(function () {
    const b = writeBatch(db);
    b.set(doc(db, "blocks", me.uid + "_" + uid), { by: me.uid, blocked: uid, createdAt: Date.now() });
    b.delete(doc(db, "friendRequests", uid + "_" + me.uid));
    return b.commit();
  });
  if (ok) { incoming = incoming.filter(function (r) { return r.from !== uid; }); await refresh(); }
}
async function unblock(uid) {
  if (await act(function () { return deleteDoc(doc(db, "blocks", me.uid + "_" + uid)); })) await refresh();
}
async function unfriend(p) {
  if (!confirm("Remove " + nameOf(p) + " from your friends?")) return;
  if (await act(function () { return deleteDoc(doc(db, "friendships", pairId(me.uid, p.uid))); })) { await refresh(); showPerson(p); }
}

$("inviteBtn").onclick = function () {
  if (!mine) { say("friendMsg", "Set up your profile first, then share your link."); return; }
  const link = location.origin + location.pathname + "?add=" + mine.handle;
  if (navigator.share) { navigator.share({ title: "Add me on Cadence", url: link }).catch(function () {}); return; }
  (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(
    function () { say("friendMsg", "Invite link copied."); }, function () { say("friendMsg", link); });
};

// ----- Profile popup (opened by tapping a name or picture in the community) -----
async function openSheet(load, emptyText) {
  if (closeFn) closeFn();
  const ov = mk("div", "pf-sheet");
  ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true"); ov.setAttribute("aria-label", "Profile");
  const panel = mk("div", "pf-panel"); panel.tabIndex = -1;
  const box = mk("div"); const msg = mk("p", "hint"); msg.setAttribute("aria-live", "polite");
  panel.appendChild(box); panel.appendChild(msg); ov.appendChild(panel);
  document.body.appendChild(ov); document.body.style.overflow = "hidden";
  const prevFocus = document.activeElement;
  function esc(e) { if (e.key === "Escape") closeFn(); }
  closeFn = function () {
    ov.remove(); document.body.style.overflow = ""; document.removeEventListener("keydown", esc);
    target = $("personBox"); modalMsg = null; closeFn = null;
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  ov.onclick = function (e) { if (e.target === ov) closeFn(); };
  document.addEventListener("keydown", esc);
  target = box; modalMsg = msg; panel.focus();
  let p = null, err = "";
  try { p = await load(); } catch (e) { err = typeof e === "string" ? e : "Couldn't search. Make sure the new Firestore rules are published."; }
  if (!closeFn) return;
  if (p) showPerson(p);
  else {
    box.appendChild(mk("p", "", err || emptyText));
    const b = mk("button", "secondary", "Close"); b.type = "button"; b.onclick = closeFn; box.appendChild(b);
  }
}
async function openProfile(uid, name) {
  if (!me) return;
  return openSheet(function () { return getProfile(uid); }, (name || "This student") + " hasn't set up a profile yet.");
}
// Used by the top search bar: look someone up by handle and show their card with Add friend
async function openByHandle(raw) {
  if (!me) return;
  const h = String(raw || "").trim().replace(/^@/, "").toLowerCase();
  return openSheet(async function () {
    if (!HANDLE_RE.test(h)) throw "Handles are 3-20 letters, numbers or _.";
    const hs = await getDoc(doc(db, "handles", h));
    const p = hs.exists() ? await getProfile(hs.data().uid) : null;
    if (!p) throw "No one found with @" + h + ".";
    return p;
  }, "");
}
window.CadenceProfile = { open: openProfile };
// Friends list (read-only copy) for shared projects, and handle lookup for the top search
window.CadenceFriends = {
  list: function () { return friends.slice(); }, find: openByHandle,
  incoming: function () { return incoming.slice(); }, outgoing: function () { return outgoing.slice(); },
  accept: function (uid) { return accept(uid); },
  decline: function (uid) { return dropRequest(uid + "_" + me.uid); },
  cancel: function (uid) { return dropRequest(me.uid + "_" + uid); },
  details: function (uid) { return getDetails(uid); }, tagChip: tagChip, mutual: mutualProjects, paintBanner: paintBanner
};

// ----- Sign-in wiring -----
function badge() {
  const n = incoming.length;
  $("avatarBadge").hidden = !n; $("avatarBadge").textContent = String(n);
}
onAuthStateChanged(auth, async function (user) {
  me = user; if (unsub) { unsub(); unsub = null; }
  if (window.PC) window.PC.apply(null);
  mine = null; incoming = []; outgoing = []; friends = []; blocked = []; badge();
  $("socialSection").hidden = !user; $("friendsSection").hidden = !user; $("socialSignedOut").hidden = !!user;
  $("profEditBtn").hidden = !user; $("profileHandle").hidden = true; $("profileBio").hidden = true;
  if (closeFn) closeFn(); openForm(false); $("personBox").textContent = ""; $("friendShowToggle").checked = false;
  if (!user) return;
  getDoc(doc(db, "friendShowcases", user.uid)).then(function (d) {
    $("friendShowToggle").checked = d.exists(); if (d.exists()) publishShowcase();
  }).catch(function () {});
  try { mine = await getProfile(user.uid); if (mine) mine = Object.assign({}, mine, await getDetails(user.uid)); } catch (e) { say("friendMsg", "Couldn't load your profile. Make sure the new Firestore rules are published."); }
  paintMine();
  unsub = onSnapshot(query(collection(db, "friendRequests"), where("to", "==", user.uid)), function (snap) {
    incoming = snap.docs.map(function (d) { return d.data(); }); badge(); paintLists();
  }, function () {});
  await refresh();
  if (pendingAdd) {
    const h = pendingAdd; pendingAdd = "";
    openByHandle(h);
  } else if (!mine) { say("friendMsg", "Tip: tap Set up profile to pick a nickname and handle."); }
});
