// Project chat: every shared project gets # General, # Announcements (admin-only posting) and one thread per stage.
// Messages live in sharedProjects/{pid}/threads/{threadId}/messages. Runs after sharedprojects.js.
// Free-plan friendly: only the open thread is listened to, history loads 30 at a time, unread uses a map on the project doc.
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, query, where, orderBy, limit, startAfter, getDocs, addDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, Timestamp, arrayUnion, arrayRemove }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const db = getFirestore(getApp());
const PAGE = 30;
const MAX_LEN = 1000;
const REACTIONS = [["up", "\ud83d\udc4d"], ["ok", "\u2705"], ["eyes", "\ud83d\udc40"], ["heart", "\u2764\ufe0f"]];
const MENTION_RE = /@([a-z0-9_]{3,20})/gi;

let me = null;
let admin = false;
let cur = null; // { p, tid, msgs: Map, unsub, oldest, hasMore }
let ui = null;
let lastSend = 0;

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function ms(t) { return t && typeof t.toMillis === "function" ? t.toMillis() : Number(t) || 0; }
function sp() { return window.CadenceSharedProjects; }

// ---- which messages has this person seen (kept on this device) ----
function seenKey() { return "cadence.chatSeen." + (me ? me.uid : "anon"); }
function readSeen() { try { return JSON.parse(localStorage.getItem(seenKey()) || "{}") || {}; } catch (e) { return {}; } }
function markSeen(pid, tid) {
  try {
    const s = readSeen();
    s[pid] = s[pid] || {};
    s[pid][tid] = Date.now();
    localStorage.setItem(seenKey(), JSON.stringify(s));
  } catch (e) {}
}

function threadsOf(p) {
  const out = [{ id: "general", label: "# General" }, { id: "announcements", label: "# Announcements" }];
  p.stages.forEach(function (s) { out.push({ id: s.id, label: "Stage: " + s.name }); });
  return out;
}

// { threads: Set of thread ids with unread messages, mention: bool }
function unreadFor(p) {
  const res = { threads: new Set(), mention: false };
  if (!me) return res;
  const seen = (readSeen()[p.id]) || {};
  const at = p.chatAt && typeof p.chatAt === "object" ? p.chatAt : {};
  threadsOf(p).forEach(function (t) {
    if (Number(at[t.id]) > (seen[t.id] || 0)) res.threads.add(t.id);
  });
  const m = p.chatMention && p.chatMention[me.uid];
  if (m && res.threads.has(m.thread) && Number(m.t) > (seen[m.thread] || 0)) res.mention = true;
  return res;
}

// ---- overlay ----
function build() {
  if (ui) return ui;
  const root = mk("div", "chat-overlay");
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Project chat");

  const head = mk("div", "chat-head");
  const back = mk("button", "secondary chat-back", "\u2190");
  back.type = "button";
  back.setAttribute("aria-label", "Close chat");
  const titles = mk("div", "chat-titles");
  const title = mk("strong", "chat-title");
  const pick = mk("select", "field chat-pick");
  pick.setAttribute("aria-label", "Channel");
  titles.appendChild(title); titles.appendChild(pick);
  head.appendChild(back); head.appendChild(titles);

  const list = mk("div", "chat-list");
  list.setAttribute("role", "log");
  list.setAttribute("aria-live", "polite");

  const note = mk("p", "hint chat-note");
  note.hidden = true;

  const form = mk("form", "chat-form");
  form.autocomplete = "off";
  const box = mk("textarea", "field chat-input");
  box.rows = 1; box.maxLength = MAX_LEN;
  box.placeholder = "Message, or @handle to mention";
  box.setAttribute("aria-label", "Message");
  const send = mk("button", "chat-send", "Send");
  send.type = "submit";
  form.appendChild(box); form.appendChild(send);

  root.appendChild(head); root.appendChild(list); root.appendChild(note); root.appendChild(form);
  document.body.appendChild(root);

  back.onclick = close;
  pick.onchange = function () { if (cur) switchTo(pick.value); };
  form.onsubmit = function (e) { e.preventDefault(); submit(); };
  box.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
  });
  box.addEventListener("input", function () {
    box.style.height = "auto";
    box.style.height = Math.min(box.scrollHeight, 120) + "px";
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !root.hidden) close(); });

  ui = { root: root, title: title, pick: pick, list: list, note: note, box: box, send: send, back: back };
  return ui;
}

function fillPicker() {
  const u = unreadFor(cur.p);
  ui.pick.textContent = "";
  threadsOf(cur.p).forEach(function (t) {
    ui.pick.appendChild(new Option((u.threads.has(t.id) && t.id !== cur.tid ? "\u25cf " : "") + t.label, t.id));
  });
  ui.pick.value = cur.tid;
}

function canPost() { return cur.tid !== "announcements" || admin; }

function setComposer() {
  const ok = canPost();
  ui.box.disabled = !ok; ui.send.disabled = !ok;
  ui.note.hidden = ok;
  if (!ok) ui.note.textContent = "Only admins can post in Announcements.";
}

function say(text) {
  ui.note.textContent = text || "";
  ui.note.hidden = !text && canPost();
  if (!text && !canPost()) ui.note.textContent = "Only admins can post in Announcements.";
}

function msgsRef() { return collection(db, "sharedProjects", cur.p.id, "threads", cur.tid, "messages"); }

function dayLabel(t) { return new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }
function timeLabel(t) { return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }

function bodyNode(text) {
  const p = mk("p", "chat-text");
  let last = 0, m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    if (m.index > last) p.appendChild(document.createTextNode(text.slice(last, m.index)));
    p.appendChild(mk("span", "chat-mention", m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) p.appendChild(document.createTextNode(text.slice(last)));
  return p;
}

function render(stick) {
  const list = ui.list;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  list.textContent = "";
  if (cur.pins.size) {
    const box = mk("div", "chat-pins");
    cur.pins.forEach(function (pin, id) {
      const row = mk("div", "chat-pin");
      row.appendChild(mk("span", "", "\ud83d\udccc " + (pin.name ? pin.name + ": " : "") + (pin.text.length > 140 ? pin.text.slice(0, 140) + "\u2026" : pin.text)));
      if (admin) {
        const un = mk("button", "chat-del", "Unpin");
        un.type = "button";
        un.onclick = function () { setPin(id, false); };
        row.appendChild(un);
      }
      box.appendChild(row);
    });
    list.appendChild(box);
  }
  if (cur.hasMore) {
    const more = mk("button", "secondary chat-more", "Load older messages");
    more.type = "button";
    more.onclick = loadOlder;
    list.appendChild(more);
  }
  const items = Array.from(cur.msgs.values()).sort(function (a, b) { return a.t - b.t; });
  if (!items.length) list.appendChild(mk("p", "hint chat-empty", cur.tid === "announcements" ? "No announcements yet." : "No messages yet. Say hi."));
  let day = "";
  items.forEach(function (m) {
    const d = dayLabel(m.t);
    if (d !== day) { day = d; list.appendChild(mk("div", "chat-day", d)); }
    if (m.kind === "system") {
      list.appendChild(mk("div", "chat-system", m.text));
      return;
    }
    const mine = me && m.uid === me.uid;
    const tagged = me && Array.isArray(m.mentions) && m.mentions.indexOf(me.uid) >= 0;
    const row = mk("div", "chat-msg" + (mine ? " chat-mine" : "") + (tagged ? " chat-tagged" : ""));
    const meta = mk("div", "chat-meta");
    meta.appendChild(mk("strong", "", mine ? "You" : (m.name || "Member")));
    meta.appendChild(mk("small", "", timeLabel(m.t)));
    if (mine || admin) {
      const del = mk("button", "chat-del", "Delete");
      del.type = "button";
      del.setAttribute("aria-label", "Delete this message");
      del.onclick = function () { removeMsg(m.id); };
      meta.appendChild(del);
    }
    if (admin) {
      const pin = mk("button", "chat-del chat-pinbtn", cur.pins.has(m.id) ? "Unpin" : "Pin");
      pin.type = "button";
      pin.onclick = function () { setPin(m.id, !cur.pins.has(m.id)); };
      meta.insertBefore(pin, meta.querySelector(".chat-del"));
    }
    row.appendChild(meta);
    row.appendChild(bodyNode(m.text));
    row.appendChild(reactionRow(m));
    list.appendChild(row);
  });
  if (stick || nearBottom) list.scrollTop = list.scrollHeight;
}

function reactionRow(m) {
  const rx = mk("div", "chat-rx");
  const mineId = me ? me.uid : "";
  REACTIONS.forEach(function (r) {
    const who = Array.isArray(m.reactions[r[0]]) ? m.reactions[r[0]] : [];
    const picking = cur.picker === m.id;
    if (!who.length && !picking) return;
    const b = mk("button", "chat-rx-chip" + (who.indexOf(mineId) >= 0 ? " on" : ""), r[1] + (who.length ? " " + who.length : ""));
    b.type = "button";
    b.setAttribute("aria-pressed", who.indexOf(mineId) >= 0 ? "true" : "false");
    b.onclick = function () { cur.picker = ""; react(m, r[0]); };
    rx.appendChild(b);
  });
  const add = mk("button", "chat-rx-chip chat-rx-add", cur.picker === m.id ? "\u00d7" : "\u263a");
  add.type = "button";
  add.setAttribute("aria-label", cur.picker === m.id ? "Close reactions" : "Add a reaction");
  add.onclick = function () { cur.picker = cur.picker === m.id ? "" : m.id; render(false); };
  rx.appendChild(add);
  return rx;
}

async function react(m, key) {
  const mine = cur;
  const who = Array.isArray(m.reactions[key]) ? m.reactions[key].slice() : [];
  const has = who.indexOf(me.uid) >= 0;
  m.reactions[key] = has ? who.filter(function (u) { return u !== me.uid; }) : who.concat(me.uid);
  render(false);
  const f = {};
  f["reactions." + key] = has ? arrayRemove(me.uid) : arrayUnion(me.uid);
  try { await updateDoc(doc(db, "sharedProjects", cur.p.id, "threads", cur.tid, "messages", m.id), f); }
  catch (e) {
    if (cur !== mine) return;
    m.reactions[key] = who; render(false);
    say("Couldn't save that reaction. Make sure the updated chat rules are published.");
  }
}

async function setPin(id, on) {
  const mine = cur, m = cur.msgs.get(id);
  try {
    await updateDoc(doc(db, "sharedProjects", cur.p.id, "threads", cur.tid, "messages", id), { pinned: on });
    if (cur !== mine) return;
    if (on) {
      if (cur.pins.size >= 3) cur.pins.delete(cur.pins.keys().next().value);
      cur.pins.set(id, { name: m ? m.name : "", text: m ? m.text : "" });
    } else cur.pins.delete(id);
    render(false);
  } catch (e) { say("Couldn't pin that. Make sure the updated chat rules are published."); }
}

function ingest(docSnap) {
  const d = docSnap.data({ serverTimestamps: "estimate" });
  cur.msgs.set(docSnap.id, {
    id: docSnap.id, uid: String(d.uid || ""), name: String(d.name || ""), text: String(d.text || ""),
    kind: d.kind || "", reactions: d.reactions && typeof d.reactions === "object" ? d.reactions : {}, pinned: !!d.pinned, mentions: Array.isArray(d.mentions) ? d.mentions : [], t: ms(d.createdAt) || Date.now()
  });
}

async function switchTo(tid) {
  if (cur && cur.unsub) { cur.unsub(); cur.unsub = null; }
  const p = cur.p;
  cur = { p: p, tid: tid, msgs: new Map(), pins: new Map(), picker: "", unsub: null, oldest: null, hasMore: false };
  fillPicker(); setComposer();
  ui.list.textContent = "";
  ui.list.appendChild(mk("p", "hint chat-empty", "Loading\u2026"));
  const mine = cur;
  let startAt = Timestamp.now();
  try {
    const snap = await getDocs(query(msgsRef(), orderBy("createdAt", "desc"), limit(PAGE)));
    if (cur !== mine) return;
    snap.docs.forEach(ingest);
    if (snap.docs.length) {
      cur.oldest = snap.docs[snap.docs.length - 1];
      const newest = snap.docs[0].data().createdAt;
      if (newest && typeof newest.toMillis === "function") startAt = newest;
    }
    cur.hasMore = snap.docs.length === PAGE;
  } catch (e) {
    if (cur !== mine) return;
    ui.list.textContent = "";
    ui.list.appendChild(mk("p", "hint chat-empty", "Couldn't load this chat. Check your connection, and that the chat rules are published in Firebase."));
    return;
  }
  try {
    const ps = await getDocs(query(msgsRef(), where("pinned", "==", true), limit(3)));
    if (cur !== mine) return;
    ps.docs.forEach(function (d) { cur.pins.set(d.id, { name: String(d.data().name || ""), text: String(d.data().text || "") }); });
  } catch (e) {}
  markSeen(p.id, tid); fillPicker();
  render(true);
  cur.unsub = onSnapshot(query(msgsRef(), where("createdAt", ">", startAt), orderBy("createdAt", "asc")), function (snap) {
    if (cur !== mine) return;
    snap.docChanges().forEach(function (c) {
      if (c.type === "removed") cur.msgs.delete(c.doc.id); else ingest(c.doc);
    });
    markSeen(p.id, tid);
    render(false);
  }, function () { say("Lost connection to the chat. Close it and open it again."); });
}

async function loadOlder() {
  if (!cur || !cur.oldest) return;
  const mine = cur;
  try {
    const snap = await getDocs(query(msgsRef(), orderBy("createdAt", "desc"), startAfter(cur.oldest), limit(PAGE)));
    if (cur !== mine) return;
    snap.docs.forEach(ingest);
    if (snap.docs.length) cur.oldest = snap.docs[snap.docs.length - 1];
    cur.hasMore = snap.docs.length === PAGE;
    const keep = ui.list.scrollHeight - ui.list.scrollTop;
    render(false);
    ui.list.scrollTop = ui.list.scrollHeight - keep;
  } catch (e) { say("Couldn't load older messages."); }
}

async function removeMsg(id) {
  if (!confirm("Delete this message?")) return;
  const mine = cur;
  try {
    await deleteDoc(doc(db, "sharedProjects", cur.p.id, "threads", cur.tid, "messages", id));
    if (cur === mine) { cur.msgs.delete(id); render(false); }
  } catch (e) { say("Couldn't delete that message."); }
}

async function resolveMentions(p, text) {
  const handles = [];
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const h = m[1].toLowerCase();
    if (handles.indexOf(h) < 0) handles.push(h);
    if (handles.length >= 5) break;
  }
  const uids = [];
  for (let i = 0; i < handles.length; i++) {
    try {
      const hs = await getDoc(doc(db, "handles", handles[i]));
      if (hs.exists()) {
        const uid = hs.data().uid;
        if (uid && uid !== me.uid && p.members.indexOf(uid) >= 0 && uids.indexOf(uid) < 0) uids.push(uid);
      }
    } catch (e) {}
  }
  return uids;
}

function myName(p) { return String((p.names && p.names[me.uid]) || me.displayName || "Admin").slice(0, 30); }

// Mark the thread as having new activity so other members see an unread dot
async function bump(p, tid, mentionUids) {
  const fields = {};
  fields["chatAt." + tid] = Date.now();
  mentionUids.forEach(function (uid) { fields["chatMention." + uid] = { t: Date.now(), thread: tid }; });
  try { await updateDoc(doc(db, "sharedProjects", p.id), fields); } catch (e) {}
}

async function submit() {
  if (!cur || !canPost()) return;
  const text = ui.box.value.trim().slice(0, MAX_LEN);
  if (!text) return;
  if (Date.now() - lastSend < 600) return;
  lastSend = Date.now();
  ui.send.disabled = true;
  const p = cur.p, tid = cur.tid, mine = cur;
  try {
    const mentions = await resolveMentions(p, text);
    const data = { uid: me.uid, name: myName(p), text: text, createdAt: serverTimestamp() };
    if (mentions.length) data.mentions = mentions;
    await addDoc(collection(db, "sharedProjects", p.id, "threads", tid, "messages"), data);
    ui.box.value = ""; ui.box.style.height = "auto";
    say("");
    markSeen(p.id, tid);
    bump(p, tid, mentions);
  } catch (e) {
    if (cur === mine) say("Couldn't send. Check your connection, and that the chat rules are published in Firebase.");
  }
  if (cur === mine) setComposer();
}

function openChat(p, tid) {
  if (!me) return;
  build();
  cur = { p: p, tid: "", msgs: new Map(), pins: new Map(), picker: "", unsub: null, oldest: null, hasMore: false };
  ui.title.textContent = p.name;
  ui.root.hidden = false;
  document.body.classList.add("chat-open");
  const start = tid && threadsOf(p).some(function (t) { return t.id === tid; }) ? tid : "general";
  switchTo(start);
  ui.back.focus();
}

function close() {
  if (cur && cur.unsub) cur.unsub();
  cur = null;
  if (ui) ui.root.hidden = true;
  document.body.classList.remove("chat-open");
  if (sp() && sp().rerender) sp().rerender();
}

// System line in a stage thread, e.g. "Mika set Animation to Review". Best effort.
async function log(p, tid, text) {
  if (!me) return;
  try {
    await addDoc(collection(db, "sharedProjects", p.id, "threads", tid, "messages"),
      { uid: me.uid, name: myName(p), text: String(text).slice(0, 200), kind: "system", createdAt: serverTimestamp() });
    bump(p, tid, []);
  } catch (e) {}
}

// ---- buttons used by sharedprojects.js ----
function button(p) {
  const u = unreadFor(p);
  const b = mk("button", "secondary chat-open-btn");
  b.type = "button";
  b.appendChild(mk("span", "", "Open chat"));
  if (u.threads.size) b.appendChild(mk("span", "chip sp-ready", u.mention ? "@ you \u00b7 " + u.threads.size + " new" : u.threads.size + " new"));
  b.onclick = function () { openChat(p, ""); };
  return b;
}
function stageButton(p, stage) {
  const u = unreadFor(p);
  const b = mk("button", "secondary sp-x chat-stage-btn", u.threads.has(stage.id) ? "Discuss \u25cf" : "Discuss");
  b.type = "button";
  b.setAttribute("aria-label", "Open the chat thread for " + stage.name);
  b.onclick = function () { openChat(p, stage.id); };
  return b;
}

window.CadenceChat = { button: button, stageButton: stageButton, open: openChat, log: log, unreadFor: unreadFor };

onAuthStateChanged(getAuth(), async function (user) {
  me = user || null;
  admin = false;
  if (cur) close();
  if (me) { try { admin = (await getDoc(doc(db, "admins", me.uid))).exists(); } catch (e) {} }
  if (sp() && sp().rerender) sp().rerender();
});
