// Home hub: Friends and direct messages. It lives inside the team chat panel and opens from the Cadence logo on the chat rail.
// Needs the dms rules in firestore.rules. Publish them in Firestore before uploading this release.
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, collection, query, where, orderBy, limitToLast, onSnapshot, writeBatch, updateDoc }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getProfile, avatarFor, avatarEl } from "./avatars.js";

const db = getFirestore(getApp());
const auth = getAuth(getApp());
const $ = function (id) { return document.getElementById(id); };
const WIDE = window.matchMedia("(min-width: 900px) and (orientation: landscape)");
const SVG = function (d) { return '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + d + "</svg>"; };
const ICON = {
  back: '<path d="M15 5l-7 7 7 7"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  send: '<path d="M5 12l14-7-5 14-2.5-5.5z"/>',
  friends: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6"/>'
};

let me = null, dms = new Map(), unsubDms = null, unsubMsgs = null;
let root = null, hosted = null, els = {}, view = "home", tab = "all", other = "", names = {}, msgs = [], draw = 0;

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function pid(a, b) { return [a, b].sort().join("_"); }
function F() { return window.CadenceFriends || { list: function () { return []; }, incoming: function () { return []; }, outgoing: function () { return []; } }; }
function nameOf(p) { return (p && p.nickname) || "Cadence user"; }
function unread(d) { return !!d.lastBy && d.lastBy !== me.uid && (d.lastAt || 0) > ((d.seen || {})[me.uid] || 0); }
function badge() { if (!me) return 0; let n = 0; dms.forEach(function (d) { if (unread(d)) n++; }); return n + F().incoming().length; }
function paintBadge() { document.dispatchEvent(new Event("cadence:hub")); }
function icoBtn(cls, icon, label, fn) {
  const b = mk("button", cls); b.type = "button"; b.title = label; b.setAttribute("aria-label", label);
  b.innerHTML = SVG(icon); b.onclick = fn; return b;
}
function textBtn(label, fn, sec) { const b = mk("button", "hub-btn" + (sec ? " sec" : ""), label); b.type = "button"; b.onclick = fn; return b; }
function note(t) { els.note.textContent = t || ""; els.note.hidden = !t; }

// ----- Layout -----
function build() {
  if (root) return;
  root = mk("div", "hub"); root.hidden = true;
  root.setAttribute("aria-label", "Friends and messages");
  root.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  const side = mk("aside", "hub-side"), main = mk("div", "hub-main");

  const head = mk("div", "hub-head");
  head.appendChild(icoBtn("hub-ico", ICON.close, "Close", close));
  head.appendChild(mk("strong", "", "Cadence"));
  els.nav = mk("button", "hub-nav"); els.nav.type = "button";
  els.nav.innerHTML = '<span class="hub-ico">' + SVG(ICON.friends) + "</span>";
  els.nav.appendChild(mk("strong", "", "Friends"));
  els.navPill = mk("span", "hub-pill"); els.nav.appendChild(els.navPill);
  els.nav.onclick = function () { show("friends"); };
  els.dms = mk("div", "hub-dms");
  els.me = mk("button", "hub-me"); els.me.type = "button";
  els.me.onclick = function () { if (me && window.CadenceProfile) window.CadenceProfile.open(me.uid, "You"); };
  side.append(head, els.nav, mk("div", "hub-label", "Direct Messages"), els.dms, els.me);

  const top = mk("div", "hub-top");
  els.back = icoBtn("hub-ico hub-back", ICON.back, "Back", function () { show("home"); });
  els.topAva = mk("span", "hub-topava"); els.title = mk("strong", "", "Friends");
  els.profBtn = icoBtn("hub-ico hub-profbtn", ICON.friends, "Show or hide profile", function () {
    if (WIDE.matches) { root.classList.toggle("hide-prof"); } else if (other && window.CadenceProfile) window.CadenceProfile.open(other, els.title.textContent);
  });
  els.profBtn.hidden = true;
  top.append(els.back, els.topAva, els.title, els.profBtn);
  els.tabs = mk("div", "hub-tabs"); els.body = mk("div", "hub-body");

  els.convo = mk("div", "hub-convo"); els.msgs = mk("div", "hub-msgs");
  els.note = mk("p", "hint hub-note"); els.note.hidden = true; els.note.setAttribute("role", "status");
  const compose = mk("div", "hub-compose");
  els.input = mk("textarea", "field hub-input"); els.input.rows = 1; els.input.maxLength = 2000;
  els.input.placeholder = "Message"; els.input.setAttribute("aria-label", "Message");
  els.input.oninput = autosize;
  els.input.onkeydown = function (e) { if (e.key === "Enter" && !e.shiftKey && WIDE.matches) { e.preventDefault(); send(); } };
  els.send = icoBtn("hub-send", ICON.send, "Send", send);
  compose.append(els.input, els.send);
  els.convo.append(els.msgs, els.note, compose);
  els.prof = mk("aside", "hub-prof"); els.prof.setAttribute("aria-label", "Profile");
  els.dmrow = mk("div", "hub-dmrow"); els.dmrow.append(els.convo, els.prof);

  main.append(top, els.tabs, els.body, els.dmrow);
  root.append(side, main);
}
function autosize() { els.input.style.height = "auto"; els.input.style.height = Math.min(els.input.scrollHeight, 140) + "px"; }

function show(v) {
  if (v === "home" && WIDE.matches) v = "friends";
  view = v; root.dataset.view = v;
  if (v !== "dm") { stopMsgs(); other = ""; }
  renderSide(); renderMain();
}
function renderMain() {
  const dm = view === "dm", fr = view === "friends";
  els.tabs.hidden = !fr; els.body.hidden = !fr; els.dmrow.hidden = !dm; els.profBtn.hidden = !dm;
  els.topAva.textContent = "";
  if (fr) { els.title.textContent = "Friends"; renderTabs(); renderFriends(); }
}
function renderSide() {
  const n = F().incoming().length;
  els.nav.classList.toggle("on", view === "friends");
  els.navPill.hidden = !n; els.navPill.textContent = String(n);
  els.dms.textContent = "";
  const rows = Array.from(dms.entries()).sort(function (a, b) { return (b[1].lastAt || 0) - (a[1].lastAt || 0); });
  rows.forEach(function (e) {
    const d = e[1], uid = (d.users || []).filter(function (u) { return u !== me.uid; })[0];
    if (!uid) return;
    const b = mk("button", "hub-dm" + (view === "dm" && uid === other ? " on" : "") + (unread(d) ? " unread" : ""));
    b.type = "button"; b.appendChild(avatarFor(uid, "?"));
    const who = mk("span", "hub-who"), nm = mk("strong", "", "\u2026");
    who.append(nm, mk("small", "", (d.lastBy === me.uid ? "You: " : "") + (d.last || "")));
    b.appendChild(who);
    if (unread(d)) b.appendChild(mk("span", "hub-dot"));
    getProfile(uid).then(function (p) { nm.textContent = nameOf(p); });
    b.onclick = function () { openDm(uid); };
    els.dms.appendChild(b);
  });
  if (!rows.length) els.dms.appendChild(mk("p", "hint hub-empty", "No messages yet. Open Friends and tap the message icon next to someone."));
  els.me.textContent = "";
  els.me.appendChild(avatarFor(me.uid, "?"));
  const who = mk("span", "hub-who"), nm = mk("strong", "", "You"), sub = mk("small", "", "Online");
  who.append(nm, sub); els.me.appendChild(who);
  getProfile(me.uid).then(function (p) { nm.textContent = nameOf(p); sub.textContent = p && p.handle ? "@" + p.handle : "Set up your profile"; });
}

// ----- Friends -----
function renderTabs() {
  els.tabs.textContent = "";
  [["all", "All"], ["pending", "Pending"], ["add", "Add Friend"]].forEach(function (t) {
    const b = mk("button", "hub-tab" + (t[0] === "add" ? " add" : "") + (tab === t[0] ? " on" : ""), t[1]);
    b.type = "button";
    if (t[0] === "pending" && F().incoming().length) b.appendChild(mk("span", "hub-pill", String(F().incoming().length)));
    b.onclick = function () { tab = t[0]; renderTabs(); renderFriends(); };
    els.tabs.appendChild(b);
  });
}
function row(p, acts) {
  const r = mk("div", "hub-row");
  r.appendChild(avatarEl(p, "", nameOf(p)));
  const who = mk("span", "hub-who"); who.append(mk("strong", "", nameOf(p)), mk("small", "", p.handle ? "@" + p.handle : ""));
  r.appendChild(who);
  const a = mk("div", "hub-acts"); acts.forEach(function (x) { a.appendChild(x); }); r.appendChild(a);
  return r;
}
async function renderFriends() {
  const body = els.body, token = ++draw; body.textContent = "";
  if (tab === "all") {
    const list = F().list();
    body.appendChild(mk("div", "hub-label2", "All friends \u2013 " + list.length));
    if (!list.length) body.appendChild(mk("p", "hint", "No friends yet. Use Add Friend to send a request or share your invite link."));
    list.forEach(function (p) {
      body.appendChild(row(p, [
        icoBtn("hub-act", ICON.chat, "Message " + nameOf(p), function () { openDm(p.uid); }),
        icoBtn("hub-act", ICON.more, "Profile", function () { if (window.CadenceProfile) window.CadenceProfile.open(p.uid, nameOf(p)); })
      ]));
    });
  } else if (tab === "pending") {
    const inc = F().incoming(), out = F().outgoing();
    const ps = await Promise.all(inc.map(function (r) { return getProfile(r.from); }).concat(out.map(function (r) { return getProfile(r.to); })));
    if (token !== draw) return;
    const pin = ps.slice(0, inc.length).filter(Boolean), pout = ps.slice(inc.length).filter(Boolean);
    if (pin.length) body.appendChild(mk("div", "hub-label2", "Incoming \u2013 " + pin.length));
    pin.forEach(function (p) {
      body.appendChild(row(p, [textBtn("Accept", function () { F().accept(p.uid); }), textBtn("Decline", function () { F().decline(p.uid); }, true)]));
    });
    if (pout.length) body.appendChild(mk("div", "hub-label2", "Sent \u2013 " + pout.length));
    pout.forEach(function (p) { body.appendChild(row(p, [textBtn("Cancel", function () { F().cancel(p.uid); }, true)])); });
    if (!pin.length && !pout.length) body.appendChild(mk("p", "hint", "No pending requests."));
  } else {
    body.appendChild(mk("div", "hub-label2", "Add Friend"));
    body.appendChild(mk("p", "hint", "Add a friend with their Cadence handle."));
    const input = mk("input", "field"); input.type = "text"; input.placeholder = "@handle"; input.setAttribute("aria-label", "Friend's handle");
    input.autocapitalize = "none"; input.autocomplete = "off";
    const go = function () { if (input.value.trim() && F().find) F().find(input.value); };
    input.onkeydown = function (e) { if (e.key === "Enter") go(); };
    const msg = mk("p", "hint"); msg.hidden = true;
    body.append(input, textBtn("Find", go), mk("span", "hub-gap"), textBtn("Share my invite link", function () {
      const b = $("inviteBtn"); if (b) b.click();
      msg.textContent = "If nothing opened, your invite link was copied."; msg.hidden = false;
    }, true), msg);
  }
}

// ----- Direct messages -----
function stopMsgs() { if (unsubMsgs) { unsubMsgs(); unsubMsgs = null; } msgs = []; }
async function openDm(uid) {
  if (!me) return;
  stopMsgs(); other = uid; view = "dm"; root.dataset.view = "dm";
  els.msgs.textContent = ""; els.input.value = ""; autosize(); note("");
  els.title.textContent = "\u2026"; els.topAva.textContent = "";
  renderSide(); renderMain();
  const ps = await Promise.all([getProfile(me.uid), getProfile(uid)]);
  if (other !== uid) return;
  names = {}; names[me.uid] = ps[0]; names[uid] = ps[1];
  els.title.textContent = nameOf(ps[1]); els.topAva.appendChild(avatarEl(ps[1], "", nameOf(ps[1])));
  els.input.placeholder = "Message @" + nameOf(ps[1]);
  renderProf(uid, ps[1]);
  const id = pid(me.uid, uid);
  unsubMsgs = onSnapshot(query(collection(db, "dms", id, "messages"), orderBy("at"), limitToLast(100)), function (snap) {
    msgs = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    drawMsgs(); markSeen(id);
  }, function () { note("Couldn't load messages. Make sure the new Firestore rules are published."); });
  if (WIDE.matches) els.input.focus();
}
// Right hand profile panel beside a conversation (wide screens)
function renderProf(uid, p) {
  const box = els.prof; box.textContent = "";
  const bn = mk("div", "hub-pbanner"); if (F().paintBanner) F().paintBanner(bn, p);
  const ava = mk("div", "hub-pava"); ava.appendChild(avatarEl(p, "lg", nameOf(p)));
  box.append(bn, ava);
  const body = mk("div", "hub-pbody");
  body.appendChild(mk("strong", "hub-pname", nameOf(p)));
  const sub = mk("div", "hub-psub", p && p.handle ? "@" + p.handle : ""); body.appendChild(sub);
  const mu = F().mutual ? F().mutual(uid).length : 0;
  if (mu) body.appendChild(mk("div", "hub-pmu", mu + (mu === 1 ? " Mutual Project" : " Mutual Projects")));
  const bio = mk("p", "hub-pbio"); bio.hidden = true; body.appendChild(bio);
  box.appendChild(body);
  box.appendChild(textBtn("View Full Profile", function () { if (window.CadenceProfile) window.CadenceProfile.open(uid, nameOf(p)); }, true));
  if (F().details) F().details(uid).then(function (d) {
    if (other !== uid) return;
    const tc = d.course && F().tagChip ? F().tagChip(d.course) : null;
    if (tc) { sub.appendChild(document.createTextNode(" ")); sub.appendChild(tc); }
    if (d.bio) { bio.textContent = d.bio; bio.hidden = false; }
  });
}
function markSeen(id) {
  const d = dms.get(id);
  if (d && unread(d)) updateDoc(doc(db, "dms", id), { ["seen." + me.uid]: Date.now() }).catch(function () {});
}
function drawMsgs() {
  const box = els.msgs, stick = !box.children.length || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.textContent = ""; let prev = null;
  msgs.forEach(function (m) {
    const at = Number(m.at) || 0, day = new Date(at).toDateString();
    if (!prev || new Date(prev.at).toDateString() !== day) {
      box.appendChild(mk("div", "hub-day", new Date(at).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }))); prev = null;
    }
    const first = !prev || prev.from !== m.from || at - prev.at > 300000;
    const r = mk("div", "hub-msg" + (first ? " first" : ""));
    r.appendChild(first ? avatarEl(names[m.from], "", nameOf(names[m.from])) : mk("span", "hub-gut"));
    const b = mk("div", "hub-msg-body");
    if (first) {
      const h = mk("div", "hub-msg-head");
      h.append(mk("strong", "", nameOf(names[m.from])), mk("small", "", new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
      b.appendChild(h);
    }
    b.appendChild(mk("div", "hub-text", String(m.text || "")));
    r.appendChild(b); box.appendChild(r); prev = { from: m.from, at: at };
  });
  if (!msgs.length) box.appendChild(mk("p", "hint", "This is the start of your conversation. Say hi!"));
  if (stick) box.scrollTop = box.scrollHeight;
}
async function send() {
  const t = els.input.value.trim().slice(0, 2000);
  if (!t || !me || !other || els.send.disabled) return;
  const id = pid(me.uid, other), now = Date.now();
  els.send.disabled = true;
  try {
    const b = writeBatch(db);
    b.set(doc(db, "dms", id), { users: [me.uid, other].sort(), last: t.slice(0, 120), lastAt: now, lastBy: me.uid, seen: { [me.uid]: now } }, { merge: true });
    b.set(doc(collection(db, "dms", id, "messages")), { from: me.uid, text: t, at: now });
    await b.commit();
    els.input.value = ""; autosize(); note("");
  } catch (e) { note("Couldn't send. You can only message friends, and the new Firestore rules must be published."); }
  finally { els.send.disabled = false; els.input.focus(); }
}

// ----- Open / close -----
function hostEl() { const c = window.CadenceChat; return c && c.host ? c.host() : null; }
// Sit inside the open team chat, beside the project rail. With no project to open a chat for, fall back to a full screen layer.
function mount() {
  let host = hostEl();
  if (!host && window.CadenceChat && window.CadenceChat.openAny && window.CadenceChat.openAny()) host = hostEl();
  const parent = host || document.body;
  if (root.parentNode !== parent) parent.appendChild(root);
  if (hosted && hosted !== host) hosted.classList.remove("chat-hubmode");
  hosted = host;
  root.classList.toggle("hub-solo", !host);
  root.setAttribute("role", host ? "region" : "dialog");
  if (host) host.classList.add("chat-hubmode");
  document.body.classList.toggle("hub-open", !host);
}
function open(opts) {
  if (!me) { alert("Sign in to use Friends and messages."); return; }
  build(); mount(); root.hidden = false;
  if (opts && opts.tab) tab = opts.tab;
  if (opts && opts.dm) {
    openDm(opts.dm).then(function () { if (opts.send && other === opts.dm) { els.input.value = opts.send; send(); } });
  } else show("home");
  document.dispatchEvent(new Event("cadence:hub"));
  root.querySelector(".hub-ico").focus();
}
function close() {
  if (!root || root.hidden) return;
  stopMsgs(); root.hidden = true;
  if (hosted) hosted.classList.remove("chat-hubmode");
  hosted = null;
  document.body.classList.remove("hub-open");
  document.dispatchEvent(new Event("cadence:hub"));
}
window.CadenceHub = { open: open, close: close, badge: badge, isOpen: function () { return !!root && !root.hidden; } };
if (WIDE.addEventListener) WIDE.addEventListener("change", function () { if (root && !root.hidden && view === "home") show("home"); });

document.addEventListener("cadence:friends", function () {
  paintBadge();
  if (!root || root.hidden) return;
  renderSide();
  if (view === "friends" && tab !== "add") { renderTabs(); renderFriends(); }
});
onAuthStateChanged(auth, function (user) {
  if (unsubDms) { unsubDms(); unsubDms = null; }
  dms = new Map(); me = user;
  if (!user) { close(); paintBadge(); return; }
  unsubDms = onSnapshot(query(collection(db, "dms"), where("users", "array-contains", user.uid)), function (snap) {
    dms = new Map(snap.docs.map(function (d) { return [d.id, d.data()]; }));
    paintBadge(); if (root && !root.hidden) renderSide();
  }, function () {});
  paintBadge();
});
