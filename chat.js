// Project chat: each shared project gets # General, # Announcements (only the owner and admins can post),
// a thread for every stage, and any custom channels the owner adds.
// Messages are stored in sharedProjects/{pid}/threads/{threadId}/messages. Loads after sharedprojects.js.
// Built for the free plan: only the open thread is listened to, history loads 30 messages at a time,
// and unread state is a map on the project document.
import { avatarFor } from "./avatars.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, query, where, orderBy, limit, startAfter, getDocs, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, Timestamp, arrayUnion, arrayRemove }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const db = getFirestore(getApp());
const PAGE = 30;
const MAX_LEN = 1000;
const REACTIONS = [["up", "\ud83d\udc4d"], ["ok", "\u2705"], ["eyes", "\ud83d\udc40"], ["heart", "\u2764\ufe0f"]];
const MENTION_RE = /@([a-z0-9_]{3,20})/gi;

let me = null;
let admin = false;
let cur = null; // Open chat: { p, tid, msgs: Map, unsub, oldest, hasMore }
let ui = null;
let lastSend = 0;
const picked = new Map(); // People chosen from the @ list: uid -> name

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function ms(t) { return t && typeof t.toMillis === "function" ? t.toMillis() : Number(t) || 0; }
function sp() { return window.CadenceSharedProjects; }

// ---- Read state, kept on this device ----
function seenKey() { return "cadence.chatSeen." + (me ? me.uid : "anon"); }
function readSeen() { try { return JSON.parse(localStorage.getItem(seenKey()) || "{}") || {}; } catch (e) { return {}; } }
function markSeen(pid, tid) {
  try {
    const s = readSeen();
    s[pid] = s[pid] || {};
    s[pid][tid] = Date.now();
    localStorage.setItem(seenKey(), JSON.stringify(s));
    queueSeen(pid, tid, s[pid][tid]);
  } catch (e) {}
}

// ---- Read state synced across devices in chatState/{uid}. Best effort, batched into a few small writes ----
let seenDirty = {}, seenTimer = 0, seenSyncOff = false, lastSeenPull = 0;
function queueSeen(pid, tid, t) {
  if (!me || seenSyncOff) return;
  (seenDirty[pid] = seenDirty[pid] || {})[tid] = t;
  clearTimeout(seenTimer);
  seenTimer = setTimeout(flushSeen, 6000);
}
async function flushSeen() {
  clearTimeout(seenTimer); seenTimer = 0;
  if (!me || seenSyncOff || !Object.keys(seenDirty).length) return;
  const batch = seenDirty; seenDirty = {};
  try { await setDoc(doc(db, "chatState", me.uid), { seen: batch, updatedAt: Date.now() }, { merge: true }); }
  catch (e) { if (e && e.code === "permission-denied") seenSyncOff = true; }
}
async function pullSeen() {
  if (!me || seenSyncOff) return false;
  lastSeenPull = Date.now();
  try {
    const s = await getDoc(doc(db, "chatState", me.uid));
    if (!s.exists()) return false;
    const remote = s.data().seen;
    if (!remote || typeof remote !== "object") return false;
    const local = readSeen();
    let changed = false;
    Object.keys(remote).forEach(function (pid) {
      const r = remote[pid];
      if (!r || typeof r !== "object") return;
      local[pid] = local[pid] || {};
      Object.keys(r).forEach(function (tid) {
        const v = Number(r[tid]) || 0;
        if (v > (local[pid][tid] || 0)) { local[pid][tid] = v; changed = true; }
      });
    });
    if (changed) { try { localStorage.setItem(seenKey(), JSON.stringify(local)); } catch (e) {} }
    return changed;
  } catch (e) {
    if (e && e.code === "permission-denied") seenSyncOff = true;
    return false;
  }
}

// Custom channels are stored on the project document as channels: [{ id, name }].
// Only the owner or an admin can change them.
const MAX_CHANNELS = 8;
const FINE = window.matchMedia("(hover: hover) and (pointer: fine)");
const TOUCH = window.matchMedia("(hover: none)");
const WIDE = window.matchMedia("(min-width: 900px) and (orientation: landscape)");
// Portrait: the workspace opens on a Discord-style home screen (project rail + channels + stages)
let homeMode = false;
function setHome(on) {
  if (!ui || !cur) return;
  on = !!on && !WIDE.matches;
  if (on === homeMode) return;
  homeMode = on;
  ui.root.classList.toggle("chat-home", on);
  if (on) {
    toggleDrawer(false); toggleSheet(false); closeFind(); closeSwitch();
    ui.proj.hidden = true;
    hideSuggest();
    fillPicker();
  } else {
    markSeen(cur.p.id, cur.tid);
    fillPicker(); render(true);
  }
}
if (WIDE.addEventListener) WIDE.addEventListener("change", function () { if (WIDE.matches && homeMode) setHome(false); });
let fq = ""; // Current find-in-chat query
function chansOf(p) {
  return (Array.isArray(p.channels) ? p.channels : [])
    .filter(function (c) { return c && /^ch[a-z0-9]{4,10}$/.test(String(c.id || "")) && c.name; })
    .map(function (c) { return { id: String(c.id), name: String(c.name).slice(0, 24) }; });
}
function isStageTid(p, tid) { return p.stages.some(function (s) { return s.id === tid; }); }

function threadsOf(p) {
  const out = [{ id: "general", label: "# General" }, { id: "announcements", label: "# Announcements" }];
  chansOf(p).forEach(function (c) { out.push({ id: c.id, label: "# " + c.name, custom: true }); });
  p.stages.forEach(function (s) { out.push({ id: s.id, label: "Stage: " + s.name }); });
  return out;
}

// Returns { threads: Set of thread IDs with unread messages, mention: boolean }
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

// ---- Overlay ----
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
  back.setAttribute("aria-label", "Back to channels");
  const titles = mk("div", "chat-titles");
  const title = mk("button", "chat-title chat-title-btn");
  title.type = "button";
  title.setAttribute("aria-haspopup", "dialog");
  title.onclick = function () {
    if (!cur) return;
    showProjectSheet("");
    const m = ui.jpanel.querySelector(".sp-members");
    if (m) m.scrollIntoView({ block: "start" });
  };
  const pick = mk("button", "chat-pick-btn");
  pick.type = "button";
  pick.setAttribute("aria-label", "Switch channel or stage");
  pick.setAttribute("aria-haspopup", "dialog");
  titles.appendChild(title); titles.appendChild(pick);
  const stagesBtn = mk("button", "secondary chat-stages", "Stages");
  stagesBtn.type = "button";
  stagesBtn.setAttribute("aria-label", "See the stages of this project");
  stagesBtn.onclick = function () {
    if (!cur) return;
    const stageId = cur.tid && isStageTid(cur.p, cur.tid) ? cur.tid : "";
    showProjectSheet(stageId);
  };
  const findBtn = mk("button", "secondary chat-find");
  findBtn.type = "button";
  findBtn.setAttribute("aria-label", "Search and pinned messages");
  findBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>';
  findBtn.onclick = function () { if (cur) openFind("search"); };
  head.appendChild(back); head.appendChild(titles); head.appendChild(findBtn); head.appendChild(stagesBtn);
  // Phones: swipe right on the header to open the channel list, swipe left to close it
  let hx = 0, hy = 0, hs = false, swipedAt = 0;
  head.addEventListener("pointerdown", function (e) { if (e.pointerType !== "touch") { hs = false; return; } hx = e.clientX; hy = e.clientY; hs = true; });
  head.addEventListener("pointerup", function (e) {
    if (!hs) return;
    hs = false;
    const dx = e.clientX - hx, dy = Math.abs(e.clientY - hy);
    if (!cur || WIDE.matches || dy > 40 || Math.abs(dx) < 70) return;
    swipedAt = Date.now();
    if (dx > 0) setHome(true);
  });
  head.addEventListener("click", function (e) { if (Date.now() - swipedAt < 400) { e.stopPropagation(); e.preventDefault(); } }, true);

  const list = mk("div", "chat-list");
  list.setAttribute("role", "log");
  list.setAttribute("aria-live", "polite");

  const note = mk("p", "hint chat-note");
  note.hidden = true;

  const form = mk("form", "chat-form");
  form.autocomplete = "off";
  const box = mk("textarea", "field chat-input");
  box.rows = 1; box.maxLength = MAX_LEN;
  box.placeholder = "Message";
  box.setAttribute("aria-label", "Message");
  const plus = mk("button", "chat-plus", "+");
  plus.type = "button";
  plus.setAttribute("aria-label", "More actions");
  plus.setAttribute("aria-haspopup", "menu");
  const send = mk("button", "chat-send", "\u2191");
  send.type = "submit";
  send.setAttribute("aria-label", "Send message");
  const sheet = mk("div", "chat-sheet");
  sheet.hidden = true;
  sheet.setAttribute("role", "menu");
  const suggest = mk("div", "chat-suggest");
  suggest.hidden = true;
  suggest.setAttribute("role", "listbox");
  suggest.setAttribute("aria-label", "People to mention");
  const jump = mk("button", "chat-jump");
  jump.type = "button"; jump.hidden = true;
  jump.setAttribute("aria-label", "Jump to the latest messages");
  form.appendChild(suggest); form.appendChild(sheet); form.appendChild(jump);
  const rbar = mk("div", "chat-replybar");
  rbar.hidden = true;
  const rtxt = mk("span", "chat-replybar-txt");
  const rclose = mk("button", "chat-replybar-x", "\u00d7");
  rclose.type = "button";
  rclose.setAttribute("aria-label", "Cancel");
  rclose.onclick = function () { if (cur) { cur.reply = null; cur.edit = null; renderBar(); } };
  rbar.appendChild(rtxt); rbar.appendChild(rclose);
  form.appendChild(rbar);
  form.appendChild(plus); form.appendChild(box); form.appendChild(send);

  const drawer = mk("div", "chat-drawer chat-channels");
  drawer.hidden = true;
  const scrim = mk("button", "chat-scrim");
  scrim.type = "button";
  scrim.setAttribute("aria-label", "Close channel list");
  const panel = mk("div", "chat-drawer-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Channels and stages");
  drawer.appendChild(scrim); drawer.appendChild(panel);

  const proj = mk("div", "chat-drawer");
  proj.hidden = true;
  const jscrim = mk("button", "chat-scrim");
  jscrim.type = "button";
  jscrim.setAttribute("aria-label", "Close project");
  const jpanel = mk("div", "chat-drawer-panel chat-project-panel");
  jpanel.setAttribute("role", "dialog");
  jpanel.setAttribute("aria-label", "Project stages and settings");
  proj.appendChild(jscrim); proj.appendChild(jpanel);
  jscrim.onclick = function () { proj.hidden = true; };

  function sheetBox(extra, label, closer) {
    const box = mk("div", "chat-drawer " + extra);
    box.hidden = true;
    const sc = mk("button", "chat-scrim");
    sc.type = "button"; sc.setAttribute("aria-label", "Close"); sc.onclick = closer;
    const pn = mk("div", "chat-drawer-panel " + extra + "-panel");
    pn.setAttribute("role", "dialog"); pn.setAttribute("aria-label", label);
    box.appendChild(sc); box.appendChild(pn);
    return { box: box, panel: pn };
  }
  const fb = sheetBox("chat-findbox", "Find in this channel", function () { closeFind(); });
  const sb = sheetBox("chat-switchbox", "Jump to a channel or stage", function () { closeSwitch(); });
  const people = mk("aside", "chat-people");
  people.setAttribute("aria-label", "People in this project");
  root.appendChild(head); root.appendChild(list); root.appendChild(note); root.appendChild(form); root.appendChild(drawer); root.appendChild(proj); root.appendChild(fb.box); root.appendChild(sb.box); root.appendChild(people);
  const prail = mk("nav", "chat-prail");
  prail.setAttribute("aria-label", "Projects");
  root.appendChild(prail);
  document.body.appendChild(root);

  back.onclick = function () { if (cur && !WIDE.matches && !homeMode) setHome(true); else close(); };
  pick.onclick = function () { if (!cur) return; if (!WIDE.matches) setHome(true); else toggleDrawer(); };
  scrim.onclick = function () { toggleDrawer(false); };
  plus.onclick = function () { toggleSheet(); };
  form.onsubmit = function (e) { e.preventDefault(); submit(); };
  box.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && cur && (cur.reply || cur.edit)) { e.stopPropagation(); cur.reply = null; cur.edit = null; renderBar(); return; }
    if (e.key === "ArrowUp" && !box.value && FINE.matches && cur && !cur.edit) {
      const own = Array.from(cur.msgs.values()).filter(function (x) { return me && x.uid === me.uid && !x.kind; }).sort(function (a, b) { return b.t - a.t; })[0];
      if (own) { e.preventDefault(); startEdit(own); return; }
    }
    if (e.key === "Enter" && !e.isComposing && ((e.ctrlKey || e.metaKey) || (!e.shiftKey && FINE.matches))) { e.preventDefault(); submit(); }
  });
  box.addEventListener("input", function () {
    box.style.height = "auto";
    box.style.height = Math.min(box.scrollHeight, 120) + "px";
    showSuggest();
  });
  box.addEventListener("click", showSuggest);
  list.addEventListener("scroll", function () { updateJump(); }, { passive: true });
  jump.onclick = function () {
    if (!cur) return;
    cur.below = 0;
    try { list.scrollTo({ top: list.scrollHeight, behavior: "smooth" }); } catch (e) { list.scrollTop = list.scrollHeight; }
    updateJump();
  };
  box.addEventListener("blur", function () { setTimeout(hideSuggest, 150); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !root.hidden) { if (!sb.box.hidden) closeSwitch(); else if (!fb.box.hidden) closeFind(); else if (!proj.hidden) proj.hidden = true; else if (!drawer.hidden) toggleDrawer(false); else if (!sheet.hidden) toggleSheet(false); else close(); } });

  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === "k" && !root.hidden && cur) {
      e.preventDefault();
      if (sb.box.hidden) openSwitch(); else closeSwitch();
    }
  });
  ui = { prail: prail, find: fb.box, fpanel: fb.panel, sw: sb.box, spanel: sb.panel, rbar: rbar, rtxt: rtxt, jump: jump, people: people, suggest: suggest, root: root, title: title, pick: pick, list: list, note: note, box: box, send: send, back: back, plus: plus, sheet: sheet, drawer: drawer, panel: panel, proj: proj, jpanel: jpanel };
  return ui;
}

function showProjectSheet(stageId) {
  if (!cur || !sp() || !sp().panel) return;
  toggleDrawer(false); toggleSheet(false);
  ui.proj.hidden = false;
  renderProjectSheet(stageId || "");
  if (stageId) {
    const t = ui.jpanel.querySelector('[data-stage="' + stageId + '"]');
    if (t) t.scrollIntoView({ block: "center" });
  }
}

function renderProjectSheet(focus) {
  if (!cur) return;
  const p = cur.p;
  const panel = ui.jpanel;
  const keep = panel.scrollTop;
  panel.textContent = "";
  panel.appendChild(mk("div", "chat-drawer-grip"));
  const head = mk("div", "chat-proj-head");
  head.appendChild(mk("h3", "chat-drawer-title", p.name));
  const done = mk("button", "secondary chat-proj-close", "Done");
  done.type = "button";
  done.onclick = function () { ui.proj.hidden = true; };
  head.appendChild(done);
  panel.appendChild(head);
  const total = p.stages.length;
  const dn = p.stages.filter(function (s) { return s.status === "Done"; }).length;
  const pct = total ? Math.round(dn / total * 100) : 0;
  const bar = mk("div", "chat-card-bar");
  const fill = mk("span", "chat-card-fill");
  fill.style.width = pct + "%";
  bar.appendChild(fill);
  panel.appendChild(bar);
  panel.appendChild(mk("small", "chat-proj-sum", total ? dn + " of " + total + " stages done \u00b7 " + pct + "%" : "No stages yet"));
  const note = mk("p", "hint chat-proj-note");
  note.hidden = true;
  panel.appendChild(note);
  panel.appendChild(sp().panel(p, focus));
  panel.scrollTop = keep;
}

// Messages from sharedprojects.js (errors, "Code copied") appear here while the project sheet is open
function notice(text) {
  if (!ui || ui.proj.hidden) return false;
  const n = ui.jpanel.querySelector(".chat-proj-note");
  if (!n) return false;
  n.textContent = text; n.hidden = !text;
  return true;
}

window.addEventListener("cadence:sharedprojects:changed", function () {
  if (!cur || !sp() || !sp().list) return;
  const fresh = sp().list().filter(function (x) { return x.id === cur.p.id; })[0];
  if (!fresh) { if (ui && !ui.root.hidden) close(); return; }
  cur.p = fresh;
  if (ui && !ui.root.hidden) {
    setTitle();
    ui.root.querySelector(".chat-stages").textContent = "Stages (" + fresh.stages.length + ")";
    fillPicker();
    if (!ui.proj.hidden) renderProjectSheet("");
  }
});

// The header names the channel or stage being viewed (the project name lives in the channel list)
function titleName() {
  return (isStageTid(cur.p, cur.tid) ? "" : "# ") + threadLabel(cur.tid).replace(/^# /, "");
}
function setTitle() {
  const n = cur.p.members.length;
  ui.title.textContent = "";
  ui.title.appendChild(mk("span", "chat-title-name", titleName()));
  ui.title.appendChild(mk("small", "chat-title-sub", n + (n === 1 ? " person" : " people") + " \u203a"));
  renderPeople();
}

function tapProfile(el, uid, name) {
  if (!uid) return el;
  el.classList.add("tap");
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", "View " + name + "'s profile");
  el.removeAttribute("aria-hidden");
  const go = function (e) { e.stopPropagation(); if (window.CadenceProfile) window.CadenceProfile.open(uid, name); };
  el.onclick = go;
  el.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } };
  return el;
}

// People list on the right (wide landscape screens only)
function renderPeople() {
  if (!cur || !ui) return;
  const p = cur.p, box = ui.people;
  box.textContent = "";
  const others = p.members.filter(function (uid) { return !(me && uid === me.uid); });
  box.appendChild(mk("h3", "chat-people-title", "People \u00b7 " + others.length));
  others.forEach(function (uid) {
    const name = (p.names && p.names[uid]) || "Member";
    const r = mk("div", "chat-person");
    r.appendChild(tapProfile(avatarFor(uid, name, "chat-ava"), uid, name));
    r.appendChild(tapProfile(mk("span", "chat-person-name", me && uid === me.uid ? name + " (you)" : name), uid, name));
    if (uid === p.createdBy) r.appendChild(mk("small", "chat-person-tag", "Owner"));
    box.appendChild(r);
  });
}

function threadLabel(tid) {
  const t = threadsOf(cur.p).filter(function (x) { return x.id === tid; })[0];
  return t ? t.label.replace(/^Stage: /, "") : "General";
}

function drawerRow(t, u, kind) {
  const on = t.id === cur.tid;
  const b = mk("button", "chat-drawer-row" + (on ? " on" : "") + (u.threads.has(t.id) && !on ? " unread" : ""));
  b.type = "button";
  if (kind === "stage") {
    const s = cur.p.stages.filter(function (x) { return x.id === t.id; })[0] || { status: "To do" };
    const dot = mk("span", "chat-dot chat-dot-" + String(s.status).toLowerCase().replace(/[^a-z]+/g, "-"));
    dot.setAttribute("aria-hidden", "true");
    b.appendChild(dot);
    const txt = mk("span", "chat-drawer-txt");
    txt.appendChild(mk("span", "chat-drawer-name", t.label.replace(/^Stage: /, "")));
    const who = s.assignee ? (cur.p.names && cur.p.names[s.assignee]) || "" : "";
    txt.appendChild(mk("small", "", s.status + (who ? " \u00b7 " + who : "")));
    b.appendChild(txt);
  } else {
    b.appendChild(mk("span", "chat-hash", "#"));
    b.appendChild(mk("span", "chat-drawer-name", t.label.replace(/^# /, "")));
  }
  if (u.threads.has(t.id) && !on) b.appendChild(mk("span", "chat-badge", "\u25cf"));
  b.onclick = function () {
    toggleDrawer(false);
    const wasHome = homeMode;
    if (wasHome) { homeMode = false; ui.root.classList.remove("chat-home"); }
    if (!on) switchTo(t.id);
    else if (wasHome) { markSeen(cur.p.id, cur.tid); fillPicker(); render(true); }
  };
  return b;
}


// ---- Setup Progress: four first steps for a new project (owner only) ----
function setupSkipKey(p) { return "cadence:setupSkip:" + p.id; }
function setupSteps(p) {
  const has = function (o) { return !!o && typeof o === "object" && Object.keys(o).length > 0; };
  return [
    { ico: "\ud83d\udce8", label: "Invite your friends", done: p.members.length > 1 || !!p.inviteCode, run: function () { if (sp() && sp().invite) sp().invite(p.id); } },
    { ico: "\ud83d\uddbc\ufe0f", label: "Upload a project icon", done: !!p.icon, run: function () { if (sp() && sp().settings) sp().settings(p.id); } },
    { ico: "\u2708\ufe0f", label: "Send your first message", done: has(p.chatAt), run: function () { const t = threadsOf(p)[0]; if (t) switchTo(t.id); } },
    { ico: "\ud83d\udcc5", label: "Set a due date", done: !!p.due, run: function () { if (sp() && sp().settings) sp().settings(p.id); } }
  ];
}
function closeSetup() { const o = document.querySelector(".chat-setup-ov"); if (o) o.remove(); }
function showSetup(p) {
  closeSetup();
  const ov = mk("div", "chat-setup-ov");
  ov.onclick = function (e) { if (e.target === ov) closeSetup(); };
  const sheet = mk("div", "chat-setup-sheet");
  sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-label", "Finish setting up your project");
  sheet.appendChild(mk("div", "chat-drawer-grip"));
  const steps = setupSteps(p);
  const n = steps.filter(function (x) { return x.done; }).length;
  sheet.appendChild(mk("h3", "chat-setup-h", "Finish setting up your project!"));
  sheet.appendChild(mk("p", "hint chat-setup-sub", "You have completed " + n + " of " + steps.length + " steps."));
  steps.forEach(function (st) {
    const b = mk("button", "chat-setup-row" + (st.done ? " done" : ""));
    b.type = "button";
    b.appendChild(mk("span", "chat-setup-ico", st.ico));
    b.appendChild(mk("span", "chat-setup-lbl", st.label));
    b.appendChild(mk("span", "chat-setup-go", st.done ? "\u2713" : "\u203a"));
    b.onclick = function () { closeSetup(); st.run(); };
    sheet.appendChild(b);
  });
  const skip = mk("button", "chat-setup-skip", "Skip these steps");
  skip.type = "button";
  skip.onclick = function () { try { localStorage.setItem(setupSkipKey(p), "1"); } catch (e) {} closeSetup(); if (ui && cur) fillPicker(); };
  sheet.appendChild(skip);
  ov.appendChild(sheet);
  document.body.appendChild(ov);
}
function setupCard(p) {
  if (!manage(p)) return null;
  try { if (localStorage.getItem(setupSkipKey(p))) return null; } catch (e) {}
  const steps = setupSteps(p);
  const n = steps.filter(function (x) { return x.done; }).length;
  if (n >= steps.length) return null;
  const next = steps.filter(function (x) { return !x.done; })[0];
  const b = mk("button", "chat-setup-card");
  b.type = "button";
  b.setAttribute("aria-label", "Setup progress, " + n + " of " + steps.length + " steps done");
  b.appendChild(mk("span", "chat-setup-wand", "\u2728"));
  const tx = mk("span", "chat-setup-tx");
  tx.appendChild(mk("strong", "", "Setup Progress"));
  tx.appendChild(mk("small", "", "Step " + (n + 1) + " of " + steps.length + ": " + next.label));
  b.appendChild(tx);
  const ring = mk("span", "chat-setup-ring"); ring.style.setProperty("--pct", String(Math.round(n / steps.length * 100)));
  b.appendChild(ring);
  b.onclick = function () { showSetup(p); };
  return b;
}

function fillPicker() {
  const u = unreadFor(cur.p);
  const others = threadsOf(cur.p).some(function (t) { return u.threads.has(t.id) && t.id !== cur.tid; });
  const isStage = isStageTid(cur.p, cur.tid);
  ui.pick.textContent = "";
  ui.pick.appendChild(mk("span", "chat-pick-label", (isStage ? "" : "# ") + threadLabel(cur.tid).replace(/^# /, "")));
  ui.pick.appendChild(mk("span", "chat-pick-caret", "\u25be"));
  if (others) ui.pick.appendChild(mk("span", "chat-badge", "\u25cf"));
  const tn = ui.title.querySelector(".chat-title-name");
  if (tn) tn.textContent = titleName();
  ui.back.classList.toggle("has-unread", others);
  const can = manage(cur.p);
  const panel = ui.panel;
  panel.textContent = "";
  panel.appendChild(mk("div", "chat-drawer-grip"));
  const ttl = mk("h3", "chat-drawer-title");
  const phd = mk("button", "chat-proj-hd");
  phd.type = "button";
  phd.setAttribute("aria-label", cur.p.name + " settings");
  const pico = mk("span", "chat-proj-ico");
  if (typeof cur.p.icon === "string" && cur.p.icon.indexOf("data:image/") === 0) { pico.style.backgroundImage = "url(" + cur.p.icon + ")"; pico.classList.add("has-icon"); }
  else pico.textContent = (cur.p.name.trim().charAt(0) || "?").toUpperCase();
  const ptx = mk("span", "chat-proj-ttl");
  ptx.appendChild(mk("strong", "", cur.p.name));
  const pmem = cur.p.members.length;
  ptx.appendChild(mk("small", "", pmem + (pmem === 1 ? " member" : " members")));
  phd.appendChild(pico); phd.appendChild(ptx); phd.appendChild(mk("span", "chat-proj-caret", "\u203a"));
  phd.onclick = function () { if (sp() && sp().settings) sp().settings(cur.p.id); };
  ttl.appendChild(phd);
  panel.appendChild(ttl);
  // Progress sits above the channels
  const nStages = cur.p.stages.length;
  const nDone = cur.p.stages.filter(function (s) { return s.status === "Done"; }).length;
  const pct = nStages ? Math.round(nDone / nStages * 100) : 0;
  const prog = mk("div", "chat-prog");
  prog.appendChild(mk("span", "chat-prog-text", nStages ? nDone + " of " + nStages + " stages done" : "No stages yet"));
  const pbar = mk("span", "chat-prog-bar");
  pbar.setAttribute("role", "progressbar");
  pbar.setAttribute("aria-valuemin", "0"); pbar.setAttribute("aria-valuemax", "100"); pbar.setAttribute("aria-valuenow", String(pct));
  pbar.setAttribute("aria-label", cur.p.name + " progress");
  const pfill = mk("span"); pfill.style.width = pct + "%";
  pbar.appendChild(pfill);
  prog.appendChild(pbar);
  panel.appendChild(prog);
  const setupEl = setupCard(cur.p);
  if (setupEl) panel.appendChild(setupEl);
  // Portrait home screen only (hidden by CSS elsewhere)
  const hacts = mk("div", "chat-home-acts");
  const hSt = mk("button", "secondary", "Stages (" + nStages + ")");
  hSt.type = "button";
  hSt.onclick = function () { showProjectSheet(""); };
  const nPeople = cur.p.members.length;
  const hPe = mk("button", "secondary", nPeople + (nPeople === 1 ? " person" : " people"));
  hPe.type = "button";
  hPe.onclick = function () { showProjectSheet(""); const m = ui.jpanel && ui.jpanel.querySelector(".sp-members"); if (m) m.scrollIntoView({ block: "start" }); };
  const hFi = mk("button", "secondary", "Search");
  hFi.type = "button";
  hFi.onclick = function () { openFind("search"); };
  const hIn = mk("button", "secondary", "Invite");
  hIn.type = "button";
  hIn.onclick = function () { if (sp() && sp().invite) sp().invite(cur.p.id); };
  hPe.onclick = function () { if (sp() && sp().settings) sp().settings(cur.p.id); };
  hacts.appendChild(hIn); hacts.appendChild(hFi); hacts.appendChild(hSt); hacts.appendChild(hPe);
  panel.appendChild(hacts);
  const jt = mk("button", "chat-jumpto");
  jt.type = "button";
  jt.appendChild(mk("span", "", "Jump to\u2026"));
  jt.appendChild(mk("kbd", "", "Ctrl K"));
  jt.onclick = openSwitch;
  panel.appendChild(jt);
  panel.appendChild(mk("p", "chat-drawer-sec", "Channels"));
  threadsOf(cur.p).filter(function (t) { return !isStageTid(cur.p, t.id); }).forEach(function (t) {
    if (!t.custom || !can) { panel.appendChild(drawerRow(t, u, "channel")); return; }
    const wrap = mk("div", "chat-drawer-wrap");
    wrap.appendChild(drawerRow(t, u, "channel"));
    const g = mk("button", "chat-chan-gear", "\u22ef");
    g.type = "button";
    g.setAttribute("aria-label", "Options for " + t.label);
    g.setAttribute("aria-expanded", cur.chMenu === t.id ? "true" : "false");
    g.onclick = function () { cur.chMenu = cur.chMenu === t.id ? "" : t.id; cur.chNew = false; cur.chErr = ""; fillPicker(); };
    wrap.appendChild(g);
    panel.appendChild(wrap);
    if (cur.chMenu === t.id) panel.appendChild(chanForm(chansOf(cur.p).filter(function (c) { return c.id === t.id; })[0]));
  });
  if (can) {
    if (cur.chNew) panel.appendChild(chanForm(null));
    else if (chansOf(cur.p).length < MAX_CHANNELS) {
      const add = mk("button", "chat-drawer-row chat-chan-add");
      add.type = "button";
      add.appendChild(mk("span", "chat-hash", "+"));
      add.appendChild(mk("span", "chat-drawer-name", "New channel"));
      add.onclick = function () {
        cur.chNew = true; cur.chMenu = ""; cur.chErr = ""; fillPicker();
        const i = ui.panel.querySelector(".chat-chan-input"); if (i) i.focus();
      };
      panel.appendChild(add);
    }
  }
  if (cur.chErr) panel.appendChild(mk("p", "hint chat-chan-err", cur.chErr));
  if (cur.p.stages.length) {
    panel.appendChild(mk("p", "chat-drawer-sec", "Stages"));
    STAGE_CATS.forEach(function (cat) {
      const list = cur.p.stages.filter(function (s) { return cat.has.indexOf(s.status) >= 0; });
      if (!list.length) return;
      const hasCurrent = list.some(function (s) { return s.id === cur.tid; });
      const shut = catShut.has(cat.name) && !hasCurrent;
      const head = mk("button", "chat-cat" + (shut ? " shut" : ""));
      head.type = "button";
      head.setAttribute("aria-expanded", shut ? "false" : "true");
      head.appendChild(mk("span", "chat-cat-caret", "\u25be"));
      head.appendChild(mk("span", "chat-cat-name", cat.name));
      head.appendChild(mk("span", "chat-cat-count", String(list.length)));
      head.onclick = function () { if (catShut.has(cat.name)) catShut.delete(cat.name); else catShut.add(cat.name); fillPicker(); };
      panel.appendChild(head);
      if (!shut) list.forEach(function (s) { panel.appendChild(drawerRow({ id: s.id, label: "Stage: " + s.name }, u, "stage")); });
    });
  }
  // Docked profile card (landscape only; hidden by CSS elsewhere)
  const card = mk("div", "chat-me");
  const who = (me && ((cur.p.names && cur.p.names[me.uid]) || me.displayName)) || "You";
  card.appendChild(avatarFor(me ? me.uid : "", who, "chat-me-ava"));
  const txt = mk("span", "chat-me-txt");
  txt.appendChild(mk("strong", "", who));
  txt.appendChild(mk("small", "", cur.p.name));
  card.appendChild(txt);
  const x = mk("button", "secondary chat-me-bell");
  x.type = "button";
  x.setAttribute("aria-label", "Notifications");
  x.setAttribute("aria-haspopup", "dialog");
  x.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg><span class="chat-me-bell-count" hidden></span>';
  x.onclick = function (e) { e.stopPropagation(); toggleNotifFromChat(); };
  card.appendChild(x);
  panel.appendChild(card);
  syncBellCount();
}

// ---- Notifications from inside the workspace ----
// The page's own notification panel is reused: it is moved to the body while the workspace is open
let notifHome = null, notifWatch = null;
function syncBellCount() {
  const src = document.getElementById("bellCount");
  const n = src && !src.hidden ? src.textContent.trim() : "";
  document.querySelectorAll(".chat-me-bell-count").forEach(function (b) { b.textContent = n; b.hidden = !n; });
}
function toggleNotifFromChat() {
  const panel = document.getElementById("notifPanel"), bell = document.getElementById("bellBtn");
  if (!panel || !bell) return;
  if (!notifHome) notifHome = panel.parentNode;
  const wasOpen = !panel.hidden;
  bell.click(); // runs the page's own open/close logic
  if (wasOpen || panel.hidden) return;
  panel.classList.add("in-chat");
  document.body.appendChild(panel);
  if (!notifWatch) {
    notifWatch = new MutationObserver(function () {
      if (!panel.hidden) return;
      panel.classList.remove("in-chat");
      if (notifHome && panel.parentNode !== notifHome) notifHome.appendChild(panel);
    });
    notifWatch.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    // opening something from a notification leaves the workspace so the result is visible
    panel.addEventListener("click", function (e) {
      if (panel.classList.contains("in-chat") && e.target.closest && e.target.closest(".notif-act.primary")) close();
    }, true);
  }
}
(function () {
  const src = document.getElementById("bellCount");
  if (src) new MutationObserver(syncBellCount).observe(src, { childList: true, characterData: true, subtree: true, attributes: true });
})();
const STAGE_CATS = [
  { name: "To do", has: ["To do"] },
  { name: "In progress", has: ["In progress", "Review", "Needs changes"] },
  { name: "Done", has: ["Done"] }
];
const catShut = new Set(["Done"]);

// ---- Channel management (project owner or admin) ----
function chanSlug(v) { return String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24); }

function chanForm(c) {
  const f = mk("form", "chat-chan-form");
  f.autocomplete = "off";
  const inp = mk("input", "field chat-chan-input");
  inp.type = "text"; inp.maxLength = 24;
  inp.placeholder = "channel-name";
  inp.value = c ? c.name : "";
  inp.setAttribute("aria-label", c ? "Channel name" : "New channel name");
  const row = mk("div", "chat-chan-btns");
  const ok = mk("button", "chat-chan-ok", c ? "Rename" : "Create");
  ok.type = "submit";
  const no = mk("button", "secondary", "Cancel");
  no.type = "button";
  no.onclick = function () { cur.chNew = false; cur.chMenu = ""; cur.chErr = ""; fillPicker(); };
  row.appendChild(ok); row.appendChild(no);
  if (c) {
    const del = mk("button", "chat-act danger", "Delete");
    del.type = "button";
    del.onclick = function () { deleteChannel(c); };
    row.appendChild(del);
  }
  f.appendChild(inp); f.appendChild(row);
  f.onsubmit = function (e) { e.preventDefault(); if (c) renameChannel(c, inp.value); else createChannel(inp.value); };
  return f;
}

function chanProblem(name, selfId) {
  if (name.length < 2) return "Use at least 2 letters or numbers.";
  if (name === "general" || name === "announcements") return "That name is already used.";
  if (chansOf(cur.p).some(function (c) { return c.name === name && c.id !== selfId; })) return "A channel with that name already exists.";
  return "";
}

async function saveChannels(list) {
  const p = cur.p;
  try {
    await updateDoc(doc(db, "sharedProjects", p.id), { channels: list, updatedAt: Date.now() });
    p.channels = list;
    return true;
  } catch (e) {
    if (cur && cur.p === p) { cur.chErr = "Couldn't save channels. Check your connection, and that your Firebase rules let the project owner edit the project."; fillPicker(); }
    return false;
  }
}

async function createChannel(raw) {
  const name = chanSlug(raw);
  const bad = chanProblem(name, "");
  if (bad) { cur.chErr = bad; fillPicker(); return; }
  const id = "ch" + Math.random().toString(36).slice(2, 8);
  if (!(await saveChannels(chansOf(cur.p).concat([{ id: id, name: name }])))) return;
  toggleDrawer(false);
  switchTo(id);
}

async function renameChannel(c, raw) {
  const name = chanSlug(raw);
  const bad = chanProblem(name, c.id);
  if (bad) { cur.chErr = bad; fillPicker(); return; }
  const list = chansOf(cur.p).map(function (x) { return x.id === c.id ? { id: x.id, name: name } : x; });
  if (!(await saveChannels(list))) return;
  cur.chMenu = ""; cur.chErr = "";
  fillPicker(); setComposer();
}

async function wipeThread(pid, tid) {
  try {
    for (let i = 0; i < 5; i++) {
      const s = await getDocs(query(collection(db, "sharedProjects", pid, "threads", tid, "messages"), limit(100)));
      if (s.empty) break;
      await Promise.all(s.docs.map(function (d) { return deleteDoc(d.ref).catch(function () {}); }));
      if (s.docs.length < 100) break;
    }
  } catch (e) {}
}

async function deleteChannel(c) {
  if (!confirm("Delete # " + c.name + " and all its messages? This can't be undone.")) return;
  const p = cur.p, wasHere = cur.tid === c.id;
  if (!(await saveChannels(chansOf(p).filter(function (x) { return x.id !== c.id; })))) return;
  wipeThread(p.id, c.id);
  if (cur && cur.p === p) {
    if (wasHere) { toggleDrawer(false); switchTo("general"); }
    else { cur.chMenu = ""; cur.chErr = ""; fillPicker(); }
  }
}

function toggleDrawer(force) {
  const open = force === undefined ? ui.drawer.hidden : force;
  if (open) toggleSheet(false);
  ui.drawer.hidden = !open;
  ui.pick.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) { const on = ui.panel.querySelector(".chat-drawer-row.on"); if (on) on.scrollIntoView({ block: "nearest" }); }
}

function insertText(t) {
  const b = ui.box;
  const a = b.selectionStart == null ? b.value.length : b.selectionStart;
  const z = b.selectionEnd == null ? a : b.selectionEnd;
  const pre = b.value.slice(0, a), post = b.value.slice(z);
  const sp1 = pre && !/\s$/.test(pre) ? " " : "";
  b.value = (pre + sp1 + t + post).slice(0, MAX_LEN);
  const pos = (pre + sp1 + t).length;
  b.focus(); b.setSelectionRange(pos, pos);
  b.dispatchEvent(new Event("input"));
}

async function shareCard() {
  if (!cur || !canPost()) return;
  const p = cur.p, tid = cur.tid, mine = cur;
  try {
    await addDoc(collection(db, "sharedProjects", p.id, "threads", tid, "messages"),
      { uid: me.uid, name: myName(p), text: p.name, kind: "card", createdAt: serverTimestamp() });
    markSeen(p.id, tid);
    bump(p, tid, []);
    say("");
  } catch (e) {
    if (cur === mine) say("Couldn't share the card. If your chat rules only allow certain message kinds, add \"card\" next to \"system\" and publish them.");
  }
}

function showSavedPicker() {
  ui.sheet.textContent = "";
  readSaved().slice(-8).reverse().forEach(function (it) {
    const b = mk("button", "chat-sheet-item");
    b.type = "button"; b.setAttribute("role", "menuitem");
    b.appendChild(mk("span", "chat-sheet-ico", "\ud83d\udd16"));
    const t = mk("span", "chat-sheet-txt");
    t.appendChild(mk("strong", "chat-saved-pick", it.text.length > 70 ? it.text.slice(0, 70) + "\u2026" : it.text));
    t.appendChild(mk("small", "", ago(it.t)));
    b.appendChild(t);
    b.onclick = function () { toggleSheet(false); insertText(it.text); };
    ui.sheet.appendChild(b);
  });
}

function toggleSheet(force) {
  const open = force === undefined ? ui.sheet.hidden : force;
  ui.sheet.hidden = !open;
  ui.plus.classList.toggle("open", !!open);
  ui.plus.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) return;
  ui.sheet.textContent = "";
  const items = [["@", "Mention someone", "Pick a teammate", function () { insertText("@"); }]];
  if (cur && manage(cur.p)) items.push(["\ud83d\udce3", "Mention everyone", "Notify the whole project", function () { insertText("@everyone "); }]);
  const nSaved = readSaved().length;
  if (nSaved) items.push(["\ud83d\udd16", "From Saved", nSaved + (nSaved === 1 ? " note" : " notes") + " to drop in", showSavedPicker]);
  items.push(["\ud83d\udcca", "Share project card", "Post progress for everyone", shareCard]);
  items.push(["\ud83d\udd17", "Add a link", "Paste a URL into your message", function () {
    const u = (prompt("Paste a link") || "").trim();
    if (/^https?:\/\//i.test(u)) insertText(u + " "); else if (u) say("Links need to start with http:// or https://");
  }]);
  items.forEach(function (it) {
    const b = mk("button", "chat-sheet-item");
    b.type = "button"; b.setAttribute("role", "menuitem");
    b.appendChild(mk("span", "chat-sheet-ico", it[0]));
    const t = mk("span", "chat-sheet-txt");
    t.appendChild(mk("strong", "", it[1])); t.appendChild(mk("small", "", it[2]));
    b.appendChild(t);
    b.onclick = function () { if (it[3] === showSavedPicker) { showSavedPicker(); return; } toggleSheet(false); it[3](); };
    ui.sheet.appendChild(b);
  });
}

function manage(p) { return admin || (!!me && p.createdBy === me.uid); }
function canPost() { return cur.tid !== "announcements" || manage(cur.p); }

function setComposer() {
  const ok = canPost();
  ui.box.disabled = !ok; ui.send.disabled = !ok;
  ui.note.hidden = ok;
  if (!ok) ui.note.textContent = "Only admins can post in Announcements.";
  const nm = threadLabel(cur.tid).replace(/^# /, "");
  renderBar();
  ui.box.placeholder = ok ? "Message " + (isStageTid(cur.p, cur.tid) ? nm : "# " + nm) : "Only admins can post here";
}

function say(text) {
  ui.note.textContent = text || "";
  ui.note.hidden = !text && canPost();
  if (!text && !canPost()) ui.note.textContent = "Only admins can post in Announcements.";
}

function msgsRef() { return collection(db, "sharedProjects", cur.p.id, "threads", cur.tid, "messages"); }

function dayLabel(t) { return new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }
// ---- @ suggestions: members of this project, chosen from a list ----
function hideSuggest() { if (ui) ui.suggest.hidden = true; }
function mentionToken() {
  const upto = ui.box.value.slice(0, ui.box.selectionStart);
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(upto);
  return m ? { start: upto.length - m[2].length - 1, query: m[2].toLowerCase() } : null;
}
function showSuggest() {
  if (!cur || !canPost()) { hideSuggest(); return; }
  const tok = mentionToken();
  if (!tok) { hideSuggest(); return; }
  const p = cur.p;
  const list = [];
  if (manage(p) && "everyone".indexOf(tok.query) === 0) list.push({ uid: "", name: "everyone", label: "Everyone in this project" });
  p.members.forEach(function (uid) {
    if (me && uid === me.uid) return;
    const name = (p.names && p.names[uid]) || "";
    if (name && name.toLowerCase().indexOf(tok.query) >= 0) list.push({ uid: uid, name: name, label: name });
  });
  ui.suggest.textContent = "";
  if (!list.length) { ui.suggest.hidden = true; return; }
  list.slice(0, 6).forEach(function (it) {
    const b = mk("button", "chat-suggest-item");
    b.type = "button";
    b.setAttribute("role", "option");
    if (it.uid) b.appendChild(avatarFor(it.uid, it.name, "chat-ava"));
    else b.appendChild(mk("span", "chat-ava chat-ava-all", "@"));
    b.appendChild(mk("span", "", it.label));
    b.addEventListener("pointerdown", function (e) { e.preventDefault(); });
    b.onclick = function () { pickMention(it, tok); };
    ui.suggest.appendChild(b);
  });
  ui.suggest.hidden = false;
}
function pickMention(it, tok) {
  const v = ui.box.value;
  const end = ui.box.selectionStart;
  const ins = "@" + it.name + " ";
  ui.box.value = v.slice(0, tok.start) + ins + v.slice(end);
  const pos = tok.start + ins.length;
  ui.box.setSelectionRange(pos, pos);
  if (it.uid) picked.set(it.uid, it.name);
  hideSuggest();
  ui.box.focus();
}
function esc(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function timeLabel(t) { return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }

function bodyNode(m) {
  const text = m.text;
  const p = mk("p", "chat-text");
  const names = (m.mentions || []).map(function (u) { return cur.p.names && cur.p.names[u]; })
    .filter(Boolean).sort(function (x, y) { return y.length - x.length; }).map(esc);
  if (m.everyone) names.push("everyone");
  const re = new RegExp("@(" + names.concat(["[a-z0-9_]{3,20}"]).join("|") + ")", "gi");
  let last = 0, hit;
  while ((hit = re.exec(text)) !== null) {
    if (hit.index > last) p.appendChild(document.createTextNode(text.slice(last, hit.index)));
    p.appendChild(mk("span", "chat-mention", hit[0]));
    last = hit.index + hit[0].length;
  }
  if (last < text.length) p.appendChild(document.createTextNode(text.slice(last)));
  return p;
}

function dueText(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ""))) return "";
  return new Date(v + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Live project card: always reflects the project's current state, so it never needs refreshing.
function cardNode(m, mine) {
  const p = cur.p;
  const total = p.stages.length;
  const done = p.stages.filter(function (s) { return s.status === "Done"; }).length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const now = p.stages.filter(function (s) { return s.status !== "Done"; })[0] || null;
  const box = mk("div", "chat-card" + (mine ? " chat-card-mine" : ""));
  const top = mk("div", "chat-card-top");
  top.appendChild(mk("small", "", (mine ? "You" : (m.name || "Member")) + " shared a project \u00b7 " + timeLabel(m.t)));
  if (mine || manage(p)) {
    const x = mk("button", "chat-dots", "\u22ef");
    x.type = "button";
    x.setAttribute("aria-label", "Card actions");
    x.setAttribute("aria-expanded", cur.menu === m.id ? "true" : "false");
    x.onclick = function () { cur.menu = cur.menu === m.id ? "" : m.id; render(false); };
    top.appendChild(x);
  }
  box.appendChild(top);
  box.appendChild(mk("strong", "chat-card-name", p.name));
  const bar = mk("div", "chat-card-bar");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100"); bar.setAttribute("aria-valuenow", String(pct));
  const fill = mk("span", "chat-card-fill");
  fill.style.width = pct + "%";
  bar.appendChild(fill);
  box.appendChild(bar);
  const facts = mk("div", "chat-card-facts");
  facts.appendChild(mk("span", "", done + " of " + total + " stages done \u00b7 " + pct + "%"));
  const due = dueText(p.due);
  if (due) facts.appendChild(mk("span", "", "Due " + due));
  box.appendChild(facts);
  if (now) {
    const who = now.assignee ? (p.names && p.names[now.assignee]) || "" : "";
    const row = mk("div", "chat-card-now");
    row.appendChild(mk("span", "chat-dot chat-dot-" + String(now.status).toLowerCase().replace(/[^a-z]+/g, "-")));
    row.appendChild(mk("span", "", "Now: " + now.name + " \u00b7 " + now.status + (who ? " \u00b7 " + who : "")));
    box.appendChild(row);
  } else if (total) box.appendChild(mk("div", "chat-card-now", "\u2705 All stages done"));
  const btns = mk("div", "chat-card-btns");
  const open = mk("button", "secondary", "Open project");
  open.type = "button";
  open.onclick = function () { showProjectSheet(""); };
  btns.appendChild(open);
  if (now) {
    const chat = mk("button", "secondary", "Chat about " + now.name);
    chat.type = "button";
    chat.onclick = function () { switchTo(now.id); };
    btns.appendChild(chat);
  }
  box.appendChild(btns);
  if (cur.menu === m.id) {
    const acts = mk("div", "chat-actions");
    const d = mk("button", "chat-act danger", "Delete card");
    d.type = "button";
    d.onclick = function () { cur.menu = ""; removeMsg(m.id); };
    acts.appendChild(d);
    box.appendChild(acts);
  }
  return box;
}

function render(stick) {
  const list = ui.list;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const keepTop = list.scrollTop;
  list.textContent = "";
  cur.newEl = null;
  if (cur.pins.size) {
    const box = mk("div", "chat-pins");
    cur.pins.forEach(function (pin, id) {
      const row = mk("div", "chat-pin");
      const ptxt = mk("span", "chat-pin-txt", "\ud83d\udccc " + (pin.name ? pin.name + ": " : "") + (pin.text.length > 140 ? pin.text.slice(0, 140) + "\u2026" : pin.text));
      ptxt.onclick = function () { jumpTo(id); };
      row.appendChild(ptxt);
      if (manage(cur.p)) {
        const un = mk("button", "chat-del", "Unpin");
        un.type = "button";
        un.onclick = function () { setPin(id, false); };
        row.appendChild(un);
      }
      box.appendChild(row);
    });
    list.appendChild(box);
  }
  if (TOUCH.matches && !tipSeen()) {
    const tip = mk("div", "chat-tip");
    tip.appendChild(mk("span", "", "Tip: press and hold a message to react, copy, save or delete it."));
    const ok = mk("button", "secondary", "Got it");
    ok.type = "button";
    ok.onclick = function () { try { localStorage.setItem("cadence.chatTip", "1"); } catch (e) {} tip.remove(); };
    tip.appendChild(ok);
    list.appendChild(tip);
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
  let prev = null;
  items.forEach(function (m, i) {
    const d = dayLabel(m.t);
    if (d !== day) { day = d; prev = null; list.appendChild(mk("div", "chat-day", d)); }
    if (m.kind === "system") {
      prev = null;
      const isStage = isStageTid(cur.p, cur.tid);
      if (!isStage) { list.appendChild(mk("div", "chat-system", m.text)); return; }
      const st = /\bto (To do|In progress|Review|Needs changes|Done)$/.exec(m.text);
      const sb = mk("button", "chat-system chat-system-btn");
      sb.type = "button";
      if (st) sb.appendChild(mk("span", "chat-dot chat-dot-" + st[1].toLowerCase().replace(/[^a-z]+/g, "-")));
      sb.appendChild(mk("span", "", m.text));
      sb.appendChild(mk("small", "", timeLabel(m.t) + " \u00b7 Open stage \u203a"));
      sb.setAttribute("aria-label", m.text + ". Open this stage in the project.");
      const pid = cur.p.id, sid = cur.tid;
      sb.onclick = function () { showProjectSheet(sid); };
      list.appendChild(sb);
      return;
    }
    if (m.kind === "card") {
      prev = null;
      const cw = mk("div", "chat-card-row");
      cw.appendChild(cardNode(m, me && m.uid === me.uid));
      list.appendChild(cw);
      return;
    }
    if (cur.seenAt && !cur.newEl && m.t > cur.seenAt && !(me && m.uid === me.uid)) {
      const nd = mk("div", "chat-new");
      nd.appendChild(mk("span", "", "New messages"));
      list.appendChild(nd);
      cur.newEl = nd; prev = null;
    }
    const next = items[i + 1];
    const joins = function (x, y) { return x && y && y.kind !== "system" && y.kind !== "card" && x.uid === y.uid && dayLabel(x.t) === dayLabel(y.t) && Math.abs(y.t - x.t) < 5 * 60 * 1000; };
    const cont = joins(prev, m);
    const lastOfGroup = !joins(m, next);
    prev = m;
    const mine = me && m.uid === me.uid;
    const tagged = me && Array.isArray(m.mentions) && m.mentions.indexOf(me.uid) >= 0;
    const wrap = mk("div", "chat-row" + (mine ? " chat-row-mine" : "") + (cont ? " chat-cont" : ""));
    // Two avatar slots: the bubble layout (phones) uses the lower one, the flat layout (wide screens) the upper one
    const slotB = mk("span", "chat-slot chat-slot-b");
    if (lastOfGroup) slotB.appendChild(tapProfile(avatarFor(m.uid, m.name, "chat-ava"), m.uid, m.name || "Member"));
    const slotT = mk("span", "chat-slot chat-slot-t");
    if (!cont) slotT.appendChild(tapProfile(avatarFor(m.uid, m.name, "chat-ava"), m.uid, m.name || "Member"));
    wrap.appendChild(slotB); wrap.appendChild(slotT);
    wrap.dataset.mid = m.id;
    const row = mk("div", "chat-msg" + (mine ? " chat-mine" : "") + (tagged || (m.everyone && !mine) ? " chat-tagged" : ""));
    if (!cont) {
      const meta = mk("div", "chat-meta");
      meta.appendChild(tapProfile(mk("strong", "", mine ? "You" : (m.name || "Member")), m.uid, m.name || "Member"));
      meta.appendChild(mk("small", "", timeLabel(m.t)));
      row.appendChild(meta);
    }
    const canDel = mine || manage(cur.p);
    const canPin = manage(cur.p);
    const open = cur.menu === m.id;
    if (canDel || canPin || true) {
      const dots = mk("button", "chat-dots", "\u22ef");
      dots.type = "button";
      dots.setAttribute("aria-label", "Message actions");
      dots.setAttribute("aria-expanded", open ? "true" : "false");
      dots.onclick = function () { cur.menu = open ? "" : m.id; cur.picker = ""; render(false); };
      row.appendChild(dots);
    }
    row.addEventListener("contextmenu", function (e) { e.preventDefault(); cur.menu = m.id; render(false); });
    if (m.replyTo) row.appendChild(quoteNode(m.replyTo));
    const body = bodyNode(m);
    if (m.edited) body.appendChild(mk("small", "chat-edited", " (edited)"));
    row.appendChild(body);
    if (m.pending) { row.classList.add("chat-pending"); row.appendChild(mk("small", "chat-sending", "Sending\u2026")); }
    if (cont) { row.classList.add("chat-msg-cont"); row.appendChild(mk("small", "chat-time-cont", timeLabel(m.t))); }
    row.appendChild(reactionRow(m));
    row.addEventListener("click", function (e) { if (!e.target.closest("a,button")) row.classList.toggle("show-time"); });
    pressToOpen(row, m);
    if (open) {
      const bar = mk("div", "chat-actions");
      const act = function (label, fn, danger) {
        const x = mk("button", "chat-act" + (danger ? " danger" : ""), label);
        x.type = "button";
        x.onclick = function () { cur.menu = ""; render(false); fn(); };
        bar.appendChild(x);
      };
      REACTIONS.forEach(function (r) {
        const who = Array.isArray(m.reactions[r[0]]) ? m.reactions[r[0]] : [];
        const x = mk("button", "chat-act chat-act-rx" + (me && who.indexOf(me.uid) >= 0 ? " on" : ""), r[1]);
        x.type = "button";
        x.setAttribute("aria-label", "React " + r[0]);
        x.onclick = function () { cur.menu = ""; react(m, r[0]); };
        bar.appendChild(x);
      });
      if (canPost()) act("Reply", function () { startReply(m); });
      if (mine && !m.kind) act("Edit", function () { startEdit(m); });
      act("Copy", function () { if (navigator.clipboard) navigator.clipboard.writeText(m.text).catch(function () {}); });
      act("Save", function () { say(addSaved(m.text, cur.p.name + " \u00b7 " + threadLabel(cur.tid), cur.p.id) ? "Saved to your notes." : "Couldn't save. This browser may be blocking storage."); });
      if (canPin) act(cur.pins.has(m.id) ? "Unpin" : "Pin", function () { setPin(m.id, !cur.pins.has(m.id)); });
      if (canDel) act("Delete", function () { removeMsg(m.id); }, true);
      act("Close", function () {});
      row.appendChild(bar);
    }
    wrap.appendChild(row);
    list.appendChild(wrap);
  });
  if (stick || nearBottom) list.scrollTop = list.scrollHeight;
  else list.scrollTop = keepTop;
  updateJump();
}

// Bursts of live updates (reactions, edits) are batched and drawn once per frame
let rq = 0;
function renderSoon() {
  if (rq) return;
  rq = requestAnimationFrame(function () { rq = 0; if (cur && ui && !ui.root.hidden) render(false); });
}

function tipSeen() { try { return localStorage.getItem("cadence.chatTip") === "1"; } catch (e) { return true; } }

function cleanReply(r) {
  return r && typeof r === "object" && typeof r.id === "string"
    ? { id: r.id.slice(0, 40), name: String(r.name || "").slice(0, 30), text: String(r.text || "").slice(0, 120) } : null;
}
function snip(t, n) { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "\u2026" : t; }

function renderBar() {
  if (!ui || !cur) return;
  const r = cur.reply, e = cur.edit;
  ui.rbar.hidden = !(r || e);
  ui.rtxt.textContent = "";
  if (e) ui.rtxt.appendChild(mk("strong", "", "Editing message"));
  else if (r) { ui.rtxt.appendChild(mk("strong", "", "Replying to " + (r.name || "Member"))); ui.rtxt.appendChild(mk("small", "", r.text)); }
  if (!e && ui.box.dataset.editing) { delete ui.box.dataset.editing; ui.box.value = ""; ui.box.style.height = "auto"; }
}
function startReply(m) {
  if (!cur || !canPost()) return;
  cur.edit = null;
  cur.reply = { id: m.id, name: m.name || "Member", text: snip(m.text, 80) };
  renderBar();
  ui.box.focus();
}
function startEdit(m) {
  if (!cur) return;
  cur.reply = null;
  cur.edit = { id: m.id };
  ui.box.dataset.editing = "1";
  ui.box.value = m.text;
  ui.box.dispatchEvent(new Event("input"));
  renderBar();
  ui.box.focus();
}
function quoteNode(r) {
  const q = mk("button", "chat-quote");
  q.type = "button";
  q.appendChild(mk("strong", "", r.name || "Member"));
  q.appendChild(mk("span", "", r.text));
  q.onclick = function (e) { e.stopPropagation(); jumpTo(r.id); };
  return q;
}
function jumpTo(id) {
  const el = ui.list.querySelector('[data-mid="' + String(id).replace(/[^A-Za-z0-9_-]/g, "") + '"]');
  if (!el) { say("That message is further back. Load older messages to see it."); return; }
  try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { el.scrollIntoView(); }
  el.classList.add("chat-flash");
  setTimeout(function () { el.classList.remove("chat-flash"); }, 1600);
}

// Touch: press and hold opens the message actions, swipe right to reply
function pressToOpen(el, m) {
  let t = null, x = 0, y = 0, dx = 0, drag = false;
  const rowEl = function () { return el.parentNode || el; };
  const stop = function () { if (t) { clearTimeout(t); t = null; } };
  const reset = function () { const r = rowEl(); r.style.transition = "transform 0.15s"; r.style.transform = ""; drag = false; dx = 0; };
  el.addEventListener("pointerdown", function (e) {
    if (e.pointerType !== "touch" || e.target.closest("a,button")) return;
    x = e.clientX; y = e.clientY; dx = 0; drag = false; stop();
    rowEl().style.transition = "none";
    t = setTimeout(function () {
      t = null;
      if (!cur) return;
      cur.menu = m.id; cur.picker = "";
      try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) {}
      render(false);
    }, 450);
  });
  el.addEventListener("pointermove", function (e) {
    if (e.pointerType !== "touch") return;
    const mx = e.clientX - x, my = e.clientY - y;
    if (!drag && t && (Math.abs(my) > 10 || Math.abs(mx) > 8)) stop();
    if (Math.abs(my) < 24 && mx > 12 && (drag || mx > Math.abs(my) * 1.5)) {
      drag = true; dx = Math.min(mx, 72);
      rowEl().style.transform = "translateX(" + dx + "px)";
    }
  });
  el.addEventListener("pointerup", function () {
    stop();
    const go = drag && dx >= 56;
    reset();
    if (go && cur && canPost()) { try { if (navigator.vibrate) navigator.vibrate(10); } catch (err) {} startReply(m); }
  });
  ["pointercancel", "pointerleave"].forEach(function (ev) { el.addEventListener(ev, function () { stop(); if (drag) reset(); }); });
}

// ---- Find: search the loaded messages in this channel, plus a list of pinned messages ----
function openFind(mode) {
  if (!cur) return;
  toggleDrawer(false); toggleSheet(false);
  cur.findMode = mode || "search";
  ui.find.hidden = false;
  buildFind();
}
function closeFind() { if (ui) ui.find.hidden = true; }

function buildFind() {
  const panel = ui.fpanel;
  panel.textContent = "";
  panel.appendChild(mk("div", "chat-drawer-grip"));
  const head = mk("div", "chat-proj-head");
  head.appendChild(mk("h3", "chat-drawer-title", "Find in " + threadLabel(cur.tid)));
  const done = mk("button", "secondary chat-proj-close", "Done");
  done.type = "button"; done.onclick = closeFind;
  head.appendChild(done);
  panel.appendChild(head);
  const tabs = mk("div", "chat-find-tabs");
  [["search", "Search"], ["pins", "Pinned (" + cur.pins.size + ")"]].forEach(function (t) {
    const b = mk("button", "chat-find-tab" + (cur.findMode === t[0] ? " on" : ""), t[1]);
    b.type = "button";
    b.setAttribute("aria-pressed", cur.findMode === t[0] ? "true" : "false");
    b.onclick = function () { cur.findMode = t[0]; buildFind(); };
    tabs.appendChild(b);
  });
  panel.appendChild(tabs);
  const res = mk("div", "chat-find-res");
  if (cur.findMode === "search") {
    const inp = mk("input", "field chat-find-input");
    inp.type = "search"; inp.maxLength = 60; inp.value = fq;
    inp.placeholder = "Search this channel";
    inp.setAttribute("aria-label", "Search messages");
    inp.oninput = function () { fq = inp.value; fillFind(res); };
    panel.appendChild(inp);
    setTimeout(function () { inp.focus(); }, 30);
  }
  panel.appendChild(res);
  fillFind(res);
}

function findRow(id, name, t, text, q) {
  const b = mk("button", "chat-find-row");
  b.type = "button";
  const top = mk("span", "chat-find-top");
  top.appendChild(mk("strong", "", name || "Member"));
  if (t) top.appendChild(mk("small", "", dayLabel(t) + " \u00b7 " + timeLabel(t)));
  b.appendChild(top);
  const sn = mk("span", "chat-find-snip");
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  const start = i > 40 ? i - 30 : 0;
  const seg = (start ? "\u2026" : "") + text.slice(start, start + 160);
  if (i >= 0) {
    const j = i - start + (start ? 1 : 0);
    sn.appendChild(document.createTextNode(seg.slice(0, j)));
    sn.appendChild(mk("mark", "", seg.slice(j, j + q.length)));
    sn.appendChild(document.createTextNode(seg.slice(j + q.length)));
  } else sn.textContent = seg;
  b.appendChild(sn);
  b.onclick = function () { closeFind(); jumpTo(id); };
  return b;
}

function fillFind(res) {
  res.textContent = "";
  if (cur.findMode === "pins") {
    if (!cur.pins.size) { res.appendChild(mk("p", "hint", "No pinned messages here yet." + (manage(cur.p) ? " Open a message's menu and choose Pin." : ""))); return; }
    cur.pins.forEach(function (pin, id) { res.appendChild(findRow(id, pin.name, 0, pin.text, "")); });
    return;
  }
  const q = fq.trim().toLowerCase();
  const all = Array.from(cur.msgs.values()).filter(function (m) { return !m.kind; });
  if (q.length < 2) res.appendChild(mk("p", "hint", "Type at least 2 characters. This searches the " + all.length + " messages loaded in this channel."));
  else {
    const hits = all.filter(function (m) { return m.text.toLowerCase().indexOf(q) >= 0 || (m.name || "").toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) { return b.t - a.t; });
    if (!hits.length) res.appendChild(mk("p", "hint", "No matches in the loaded messages."));
    hits.slice(0, 40).forEach(function (m) { res.appendChild(findRow(m.id, m.name, m.t, m.text, q)); });
    if (hits.length > 40) res.appendChild(mk("p", "hint", "Showing the 40 newest of " + hits.length + " matches."));
  }
  if (cur.hasMore) {
    const more = mk("button", "secondary chat-find-more", "Search older messages");
    more.type = "button";
    more.onclick = async function () {
      more.disabled = true; more.textContent = "Loading\u2026";
      await loadOlder();
      if (cur && !ui.find.hidden) fillFind(res);
    };
    res.appendChild(more);
  }
}

// ---- Ctrl+K: jump to a channel or stage by name ----
function closeSwitch() { if (ui) ui.sw.hidden = true; }
function openSwitch() {
  if (!cur) return;
  closeFind(); toggleSheet(false);
  ui.sw.hidden = false;
  const panel = ui.spanel;
  panel.textContent = "";
  panel.appendChild(mk("div", "chat-drawer-grip"));
  const inp = mk("input", "field chat-find-input");
  inp.type = "search"; inp.placeholder = "Jump to a channel or stage"; inp.maxLength = 40;
  inp.setAttribute("aria-label", "Jump to a channel or stage");
  const list = mk("div", "chat-switch-list");
  panel.appendChild(inp); panel.appendChild(list);
  const u = unreadFor(cur.p);
  let sel = 0, items = [];
  const go = function (id) { closeSwitch(); if (id !== cur.tid) switchTo(id); };
  const draw = function () {
    list.textContent = "";
    const q = inp.value.trim().toLowerCase();
    items = threadsOf(cur.p).filter(function (t) { return !q || t.label.toLowerCase().indexOf(q) >= 0; });
    if (sel >= items.length) sel = Math.max(0, items.length - 1);
    items.forEach(function (t, i) {
      const b = mk("button", "chat-switch-row" + (i === sel ? " on" : ""));
      b.type = "button";
      b.appendChild(mk("span", "chat-hash", isStageTid(cur.p, t.id) ? "\u25c6" : "#"));
      b.appendChild(mk("span", "chat-drawer-name", t.label.replace(/^(# |Stage: )/, "")));
      if (u.threads.has(t.id) && t.id !== cur.tid) b.appendChild(mk("span", "chat-badge", "\u25cf"));
      b.onclick = function () { go(t.id); };
      list.appendChild(b);
    });
    if (!items.length) list.appendChild(mk("p", "hint", "No match."));
    const on = list.querySelector(".on");
    if (on) on.scrollIntoView({ block: "nearest" });
  };
  inp.oninput = function () { sel = 0; draw(); };
  inp.onkeydown = function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); if (items.length) { sel = (sel + 1) % items.length; draw(); } }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (items.length) { sel = (sel - 1 + items.length) % items.length; draw(); } }
    else if (e.key === "Enter") { e.preventDefault(); if (items[sel]) go(items[sel].id); }
    else if (e.key === "Escape") { e.stopPropagation(); closeSwitch(); }
  };
  draw();
  setTimeout(function () { inp.focus(); }, 30);
}

// "Jump to latest" pill: appears when scrolled up and counts the messages that arrive meanwhile
function updateJump() {
  if (!ui || !cur) return;
  const l = ui.list;
  const far = l.scrollHeight - l.scrollTop - l.clientHeight;
  if (far < 120) cur.below = 0;
  ui.jump.hidden = !(far > 240 || cur.below > 0);
  ui.jump.textContent = cur.below > 0 ? "\u2193 " + cur.below + " new" : "\u2193 Latest";
}

function focusNew() {
  if (!cur || !cur.newEl) return;
  const l = ui.list;
  l.scrollTop = Math.max(0, cur.newEl.getBoundingClientRect().top - l.getBoundingClientRect().top + l.scrollTop - 48);
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
  if (cur.picker === m.id) {
    const add = mk("button", "chat-rx-chip chat-rx-add", "\u00d7");
    add.type = "button";
    add.setAttribute("aria-label", "Close reactions");
    add.onclick = function () { cur.picker = ""; render(false); };
    rx.appendChild(add);
  }
  rx.hidden = !rx.childNodes.length;
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
    kind: d.kind || "", everyone: d.everyone === true, reactions: d.reactions && typeof d.reactions === "object" ? d.reactions : {}, pinned: !!d.pinned, mentions: Array.isArray(d.mentions) ? d.mentions : [], edited: d.edited === true, pending: docSnap.metadata.hasPendingWrites === true, replyTo: cleanReply(d.replyTo), t: ms(d.createdAt) || Date.now()
  });
}

function tOf(docSnap) { return ms(docSnap.data({ serverTimestamps: "estimate" }).createdAt); }
function syncPin(docSnap) {
  const d = docSnap.data();
  if (d.pinned === true) cur.pins.set(docSnap.id, { name: String(d.name || ""), text: String(d.text || "") });
  else cur.pins.delete(docSnap.id);
}

async function switchTo(tid) {
  fq = "";
  if (cur && cur.unsub) { cur.unsub(); cur.unsub = null; }
  const p = cur.p;
  cur = { p: p, tid: tid, msgs: new Map(), pins: new Map(), picker: "", menu: "", unsub: null, oldest: null, hasMore: false, seenAt: (readSeen()[p.id] || {})[tid] || 0, below: 0, newEl: null, loadedAt: 0 };
  fillPicker(); setComposer();
  ui.list.textContent = "";
  ui.list.appendChild(mk("p", "hint chat-empty", "Loading\u2026"));
  const mine = cur;
  let ready = false;
  // One live listener on the newest messages, covering new messages, edits, reactions, pins and deletes.
  cur.unsub = onSnapshot(query(msgsRef(), orderBy("createdAt", "desc"), limit(PAGE)), { includeMetadataChanges: true }, function (snap) {
    if (cur !== mine) return;
    if (!ready) {
      ready = true;
      snap.docs.forEach(function (d) { ingest(d); syncPin(d); });
      if (snap.docs.length) cur.oldest = snap.docs[snap.docs.length - 1];
      cur.hasMore = snap.docs.length === PAGE;
      cur.loadedAt = snap.docs.reduce(function (a, d) { return Math.max(a, tOf(d)); }, 0);
      if (!homeMode) markSeen(p.id, tid);
      fillPicker();
      render(true);
      focusNew(); updateJump();
      // Pinned messages older than the live window
      getDocs(query(msgsRef(), where("pinned", "==", true), limit(3))).then(function (ps) {
        if (cur !== mine) return;
        ps.docs.forEach(function (d) { if (cur.pins.size < 3) syncPin(d); });
        render(false);
      }).catch(function () {});
      return;
    }
    if (!cur.oldest && snap.docs.length) { cur.oldest = snap.docs[snap.docs.length - 1]; cur.hasMore = snap.docs.length === PAGE; }
    const l = ui.list;
    const near = l.scrollHeight - l.scrollTop - l.clientHeight < 80;
    const full = snap.docs.length >= PAGE;
    const oldestT = snap.docs.length ? tOf(snap.docs[snap.docs.length - 1]) : 0;
    snap.docChanges({ includeMetadataChanges: true }).forEach(function (c) {
      const id = c.doc.id;
      if (c.type === "removed") {
        // A message that slides out of the live window stays visible. Only a real delete removes it.
        if (full && tOf(c.doc) < oldestT) return;
        cur.msgs.delete(id); cur.pins.delete(id);
        return;
      }
      if (c.type === "added" && !cur.msgs.has(id) && !near && !c.doc.metadata.hasPendingWrites && c.doc.data().uid !== (me && me.uid) && tOf(c.doc) > cur.loadedAt) cur.below++;
      ingest(c.doc); syncPin(c.doc);
    });
    markSeen(p.id, tid);
    renderSoon();
  }, function () {
    if (cur !== mine) return;
    if (!ready) {
      ui.list.textContent = "";
      ui.list.appendChild(mk("p", "hint chat-empty", "Couldn't load this chat. Check your connection, and that the chat rules are published in Firebase."));
    } else say("Lost connection to the chat. Close it and open it again.");
  });
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
  // People picked from the @ list (their name must still appear in the text)
  picked.forEach(function (name, uid) {
    if (text.toLowerCase().indexOf("@" + name.toLowerCase()) >= 0 && p.members.indexOf(uid) >= 0) uids.push(uid);
  });
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

// Flag the thread as having new activity so other members see an unread dot
async function bump(p, tid, mentionUids, everyone) {
  const fields = {};
  fields["chatAt." + tid] = Date.now();
  if (everyone) p.members.forEach(function (uid) { if (uid !== me.uid) fields["chatMention." + uid] = { t: Date.now(), thread: tid }; });
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
  if (cur.edit) {
    const eid = cur.edit.id;
    try {
      await updateDoc(doc(db, "sharedProjects", p.id, "threads", tid, "messages", eid), { text: text, edited: true });
      if (cur === mine) {
        const em = cur.msgs.get(eid);
        if (em) { em.text = text; em.edited = true; }
        cur.edit = null; ui.box.value = ""; ui.box.style.height = "auto";
        renderBar(); render(false); say("");
      }
    } catch (e) { if (cur === mine) say("Couldn't save the edit. Make sure the updated chat rules are published in Firebase."); }
    if (cur === mine) setComposer();
    return;
  }
  try {
    const mentions = await resolveMentions(p, text);
    const data = { uid: me.uid, name: myName(p), text: text, createdAt: serverTimestamp() };
    if (mentions.length) data.mentions = mentions.slice(0, 10);
    const everyone = manage(p) && /(^|\s)@everyone\b/i.test(text);
    if (everyone) data.everyone = true;
    if (cur === mine && cur.reply) data.replyTo = { id: String(cur.reply.id).slice(0, 40), name: String(cur.reply.name || "").slice(0, 30), text: String(cur.reply.text || "").slice(0, 120) };
    // Optimistic send: the message appears at once as "Sending…" and the box clears.
    // If the send fails, the text goes back into the box.
    const sending = addDoc(collection(db, "sharedProjects", p.id, "threads", tid, "messages"), data);
    if (cur === mine) { cur.reply = null; renderBar(); ui.box.value = ""; ui.box.style.height = "auto"; }
    picked.clear(); hideSuggest();
    say("");
    markSeen(p.id, tid);
    sending.then(function () { bump(p, tid, mentions, everyone); }).catch(function () {
      if (cur !== mine) return;
      if (!ui.box.value) { ui.box.value = text; ui.box.dispatchEvent(new Event("input")); }
      say("Couldn't send. Your message is back in the box. Check your connection, then tap send to try again.");
    });
  } catch (e) {
    if (cur === mine) say("Couldn't send. Check your connection, and that the chat rules are published in Firebase.");
  }
  if (cur === mine) setComposer();
}


// Landscape project rail: one tile per project, like servers in Discord
function railColor(name) {
  const cols = ["#5FB8A0", "#7657E8", "#D9A95B", "#E58A85", "#B98FDF", "#62B5D1"];
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return cols[h % cols.length];
}
function drawRail() {
  if (!ui || !ui.prail || !cur || !sp() || !sp().list) return;
  const rail = ui.prail;
  rail.textContent = "";
  const logo = mk("button", "chat-rail-btn chat-rail-logo");
  const hubOn = !!(window.CadenceHub && window.CadenceHub.isOpen && window.CadenceHub.isOpen());
  if (hubOn) { logo.classList.add("on"); logo.setAttribute("aria-current", "true"); }
  logo.type = "button"; logo.title = "Friends and messages"; logo.setAttribute("aria-label", "Friends and messages");
  const li = document.createElement("img"); li.src = "logo.png"; li.alt = ""; logo.appendChild(li);
  const hb = window.CadenceHub ? window.CadenceHub.badge() : 0;
  if (hb) logo.appendChild(mk("span", "chat-ptile-badge", hb > 99 ? "99+" : String(hb)));
  logo.onclick = function () { if (window.CadenceHub) window.CadenceHub.open(); };
  rail.appendChild(logo);
  rail.appendChild(mk("div", "chat-rail-sep"));
  const all = sp().list();
  all.forEach(function (p) {
    const b = mk("button", "chat-ptile" + (p.id === cur.p.id && !hubOn ? " on" : ""));
    b.type = "button";
    b.title = p.name;
    b.setAttribute("aria-label", p.name);
    if (p.id === cur.p.id && !hubOn) b.setAttribute("aria-current", "true");
    const c = railColor(p.name);
    b.style.color = c;
    b.style.backgroundColor = "color-mix(in srgb, " + c + " 22%, var(--panel))";
    if (typeof p.icon === "string" && p.icon.indexOf("data:image/") === 0) {
      b.classList.add("has-icon");
      b.style.backgroundImage = "url(" + p.icon + ")";
    } else b.appendChild(mk("span", "chat-ptile-ltr", (p.name.trim().charAt(0) || "?").toUpperCase()));
    const n = unreadFor(p).threads.size;
    if (n && p.id !== cur.p.id) b.appendChild(mk("span", "chat-ptile-badge", n > 99 ? "99+" : String(n)));
    b.onclick = function () { if (p.id !== cur.p.id) openChat(p, ""); else hubClose(); };
    rail.appendChild(b);
  });
  const priv = window.CadencePrivate ? window.CadencePrivate.list() : [];
  if (priv.length) {
    rail.appendChild(mk("div", "chat-rail-sep"));
    priv.forEach(function (pp) {
      const b = mk("button", "chat-ptile chat-ptile-priv");
      b.type = "button";
      b.title = "Private: " + pp.name;
      b.setAttribute("aria-label", "Private project " + pp.name);
      const c = railColor(pp.name);
      b.style.color = c;
      b.style.backgroundColor = "color-mix(in srgb, " + c + " 14%, var(--panel))";
      b.appendChild(mk("span", "chat-ptile-ltr", (pp.name.trim().charAt(0) || "?").toUpperCase()));
      const lock = mk("span", "chat-ptile-lock");
      lock.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
      b.appendChild(lock);
      b.onclick = function () { openPrivate(pp.id); };
      rail.appendChild(b);
    });
  }
  const ICO = function (d) { return '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'; };
  const add = mk("button", "chat-rail-btn chat-rail-add");
  add.type = "button";
  add.title = "New project";
  add.setAttribute("aria-label", "New project");
  add.innerHTML = ICO('<path d="M12 5v14M5 12h14"/>');
  add.onclick = function () {
    // New project opens as a sheet over the chat, no page change
    if (window.CadenceSharedProjects && window.CadenceSharedProjects.newProject) { window.CadenceSharedProjects.newProject(); return; }
    close();
    if (window.showTab) window.showTab("projects", true);
    setTimeout(function () { const n = document.getElementById("sharedNewBtn"); if (n) n.click(); }, 60);
  };
  rail.appendChild(add);
  const home = mk("button", "chat-rail-btn chat-rail-home");
  home.type = "button";
  home.title = "Home";
  home.setAttribute("aria-label", "Home");
  home.innerHTML = ICO('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>');
  home.onclick = function () { close(); if (window.showTab) window.showTab("home"); };
  rail.appendChild(home);
}

function hubClose() { if (window.CadenceHub) window.CadenceHub.close(); }
function hostEl() { return ui && cur && !ui.root.hidden ? ui.root : null; }
// Open the last used project so the Friends hub has a chat panel to sit in. False when there are no projects.
function openAny() {
  if (!me || !sp() || !sp().list) return false;
  const all = sp().list();
  if (!all.length) return false;
  let id = ""; try { id = localStorage.getItem("cadence:lastProject") || ""; } catch (e) {}
  openChat(all.filter(function (x) { return x.id === id; })[0] || all[0], "");
  return true;
}
function openChat(p, tid) {
  if (!me) return;
  hubClose();
  build();
  cur = { p: p, tid: "", msgs: new Map(), pins: new Map(), picker: "", menu: "", unsub: null, oldest: null, hasMore: false };
  setTitle();
  ui.root.querySelector(".chat-stages").textContent = "Stages (" + p.stages.length + ")";
  ui.proj.hidden = true;
  homeMode = !tid && !WIDE.matches;
  ui.root.classList.toggle("chat-home", homeMode);
  ui.root.hidden = false;
  document.body.classList.add("chat-open");
  try { localStorage.setItem("cadence:lastProject", p.id); } catch (e) {}
  const start = tid && threadsOf(p).some(function (t) { return t.id === tid; }) ? tid : "general";
  switchTo(start);
  drawRail();
  ui.back.focus();
}

function close() {
  hubClose();
  flushSeen();
  picked.clear();
  if (cur && cur.unsub) cur.unsub();
  cur = null;
  if (ui) { ui.find.hidden = true; ui.sw.hidden = true; ui.jump.hidden = true; ui.root.hidden = true; ui.drawer.hidden = true; ui.proj.hidden = true; ui.sheet.hidden = true; }
  document.body.classList.remove("chat-open");
  homeMode = false;
  if (ui) ui.root.classList.remove("chat-home");
  if (sp() && sp().rerender) sp().rerender();
  // The Projects page is only for New / Join now, so closing the chat goes Home
  if (location.hash === "#projects" && window.showTab) window.showTab("home");
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

// ---- Buttons used by sharedprojects.js ----
function button(p) {
  const u = unreadFor(p);
  const b = mk("button", "secondary chat-open-btn");
  b.type = "button";
  b.appendChild(mk("span", "", "Team chat"));
  if (u.threads.size) b.appendChild(mk("span", "chip sp-ready", u.mention ? "@ you \u00b7 " + u.threads.size + " new" : u.threads.size + " new"));
  b.onclick = function () { openChat(p, ""); };
  return b;
}
function stageButton(p, stage) {
  const u = unreadFor(p);
  const b = mk("button", "secondary chat-stage-btn", u.threads.has(stage.id) ? "Chat about this stage \u25cf" : "Chat about this stage");
  b.type = "button";
  b.setAttribute("aria-label", "Open the chat thread for " + stage.name);
  b.onclick = function () { openChat(p, stage.id); };
  return b;
}

// ---- Saved: a private notes space for each person, kept on this device ----
const SAVED_MAX = 100;
let sv = null;
function savedKey() { return "cadence.saved." + (me ? me.uid : "anon"); }
function readSaved() {
  try {
    const a = JSON.parse(localStorage.getItem(savedKey()) || "[]");
    return Array.isArray(a) ? a.filter(function (x) { return x && typeof x.text === "string"; }) : [];
  } catch (e) { return []; }
}
function writeSaved(a) { try { localStorage.setItem(savedKey(), JSON.stringify(a.slice(-SAVED_MAX))); return true; } catch (e) { return false; } }
function addSaved(text, from, pid) {
  const t = String(text || "").trim().slice(0, MAX_LEN);
  if (!t) return false;
  const a = readSaved();
  a.push({ id: Math.random().toString(36).slice(2, 9), text: t, t: Date.now(), from: from ? String(from).slice(0, 60) : "", pid: pid ? String(pid).slice(0, 40) : "" });
  return writeSaved(a);
}
const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
function linkify(text) {
  const p = mk("p", "chat-text");
  text.split(URL_RE).forEach(function (part, i) {
    if (i % 2) {
      const a = mk("a", "", part);
      a.href = part; a.target = "_blank"; a.rel = "noopener noreferrer";
      p.appendChild(a);
    } else if (part) p.appendChild(document.createTextNode(part));
  });
  return p;
}
function buildSaved() {
  if (sv) return sv;
  const root = mk("div", "chat-overlay chat-saved");
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Saved");
  const head = mk("div", "chat-head");
  const back = mk("button", "secondary chat-back", "\u2190");
  back.type = "button"; back.setAttribute("aria-label", "Close Saved");
  const titles = mk("div", "chat-titles");
  titles.appendChild(mk("strong", "chat-title", "Saved"));
  titles.appendChild(mk("small", "chat-title-sub", "Only you can see this, on this device"));
  head.appendChild(back); head.appendChild(titles);
  const list = mk("div", "chat-list");
  const form = mk("form", "chat-form");
  form.autocomplete = "off";
  const box = mk("textarea", "field chat-input");
  box.rows = 1; box.maxLength = MAX_LEN; box.placeholder = "Jot something down";
  box.setAttribute("aria-label", "Note");
  const send = mk("button", "chat-send", "\u2191");
  send.type = "submit"; send.setAttribute("aria-label", "Save note");
  form.appendChild(box); form.appendChild(send);
  root.appendChild(head); root.appendChild(list); root.appendChild(form);
  document.body.appendChild(root);
  box.addEventListener("input", function () { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, 120) + "px"; });
  form.onsubmit = function (e) {
    e.preventDefault();
    if (!box.value.trim()) return;
    if (!addSaved(box.value, "")) { alert("Couldn't save. This browser may be blocking storage."); return; }
    box.value = ""; box.style.height = "auto";
    renderSaved(true);
  };
  back.onclick = closeSaved;
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !root.hidden) closeSaved(); });
  sv = { root: root, list: list, box: box, open: "" };
  return sv;
}
function renderSaved(stick) {
  const list = sv.list;
  list.textContent = "";
  const items = readSaved();
  if (!items.length) list.appendChild(mk("p", "hint chat-empty", "Nothing saved yet. Jot a note below, or choose Save on any chat message."));
  let day = "";
  items.forEach(function (it) {
    const d = dayLabel(it.t);
    if (d !== day) { day = d; list.appendChild(mk("div", "chat-day", d)); }
    const wrap = mk("div", "chat-row chat-row-mine");
    const row = mk("div", "chat-msg chat-mine");
    const meta = mk("div", "chat-meta");
    meta.appendChild(mk("small", "", timeLabel(it.t) + (it.from ? " \u00b7 from " + it.from : "")));
    row.appendChild(meta);
    const dots = mk("button", "chat-dots", "\u22ef");
    dots.type = "button"; dots.setAttribute("aria-label", "Note actions");
    dots.setAttribute("aria-expanded", sv.open === it.id ? "true" : "false");
    dots.onclick = function () { sv.open = sv.open === it.id ? "" : it.id; renderSaved(false); };
    row.appendChild(dots);
    row.appendChild(linkify(it.text));
    if (sv.open === it.id) {
      const bar = mk("div", "chat-actions");
      const copy = mk("button", "chat-act", "Copy");
      copy.type = "button";
      copy.onclick = function () { sv.open = ""; if (navigator.clipboard) navigator.clipboard.writeText(it.text).catch(function () {}); renderSaved(false); };
      const del = mk("button", "chat-act danger", "Delete");
      del.type = "button";
      del.onclick = function () { sv.open = ""; writeSaved(readSaved().filter(function (x) { return x.id !== it.id; })); renderSaved(false); };
      bar.appendChild(copy); bar.appendChild(del);
      row.appendChild(bar);
    }
    wrap.appendChild(row);
    list.appendChild(wrap);
  });
  if (stick !== false) list.scrollTop = list.scrollHeight;
}
function openSaved() {
  if (!me) return;
  buildSaved();
  sv.open = "";
  renderSaved(true);
  sv.root.hidden = false;
  document.body.classList.add("chat-open");
  sv.box.focus();
}
function closeSaved() {
  if (sv) sv.root.hidden = true;
  if (!ui || ui.root.hidden) document.body.classList.remove("chat-open");
  if (sp() && sp().rerender) sp().rerender();
}

// ---- Private projects: a private notes space for each one (notes, tasks, pins, annotations) ----
const PV_MAX = 80;
let pv = null;
function pvApi() { return window.CadencePrivate || null; }
function pvInfo(id) { const a = pvApi() ? pvApi().list() : []; return a.filter(function (x) { return x.id === id; })[0] || null; }
function pvNotes() { const n = pvApi() && pv ? pvApi().notes(pv.id) : null; return n || []; }
function pvSave(notes) {
  if (!pvApi() || !pvApi().save(pv.id, notes)) { alert("Couldn't save. This browser may be blocking storage."); return false; }
  return true;
}
function pvId() { return Math.random().toString(36).slice(2, 9); }
function pvChange(id, fn) {
  const notes = pvNotes();
  const n = notes.filter(function (x) { return x.id === id; })[0];
  if (!n) return;
  fn(n);
  if (pvSave(notes)) pvRender(false);
}
function pvBuild() {
  if (pv) return pv;
  const root = mk("div", "chat-overlay chat-saved chat-private");
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Private project");
  const head = mk("div", "chat-head");
  const back = mk("button", "secondary chat-back", "\u2190");
  back.type = "button"; back.setAttribute("aria-label", "Close private project");
  const titles = mk("div", "chat-titles");
  const title = mk("strong", "chat-title", "");
  const sub = mk("small", "chat-title-sub", "");
  titles.appendChild(title); titles.appendChild(sub);
  const sel = mk("select", "field pv-switch");
  sel.setAttribute("aria-label", "Switch private project");
  head.appendChild(back); head.appendChild(titles); head.appendChild(sel);
  const list = mk("div", "chat-list");
  const form = mk("form", "chat-form");
  form.autocomplete = "off";
  const mode = mk("button", "secondary pv-mode", "Note");
  mode.type = "button"; mode.setAttribute("aria-label", "Entry type: note. Tap to switch to task");
  const box = mk("textarea", "field chat-input");
  box.rows = 1; box.maxLength = 500; box.placeholder = "Write a note";
  box.setAttribute("aria-label", "New entry");
  const send = mk("button", "chat-send", "\u2191");
  send.type = "submit"; send.setAttribute("aria-label", "Add");
  form.appendChild(mode); form.appendChild(box); form.appendChild(send);
  root.appendChild(head); root.appendChild(list); root.appendChild(form);
  document.body.appendChild(root);
  pv = { root: root, title: title, sub: sub, sel: sel, list: list, box: box, mode: mode, kind: "note", id: "", open: "", annFor: "", editId: "" };
  box.addEventListener("input", function () { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, 120) + "px"; });
  mode.onclick = function () {
    pv.kind = pv.kind === "note" ? "todo" : "note";
    mode.textContent = pv.kind === "todo" ? "Task" : "Note";
    box.placeholder = pv.kind === "todo" ? "Add a task" : "Write a note";
    mode.setAttribute("aria-label", pv.kind === "todo" ? "Entry type: task. Tap to switch to note" : "Entry type: note. Tap to switch to task");
  };
  form.onsubmit = function (e) {
    e.preventDefault();
    const t = box.value.trim();
    if (!t) return;
    const notes = pvNotes();
    if (notes.length >= PV_MAX) { alert("A private project keeps up to " + PV_MAX + " entries. Delete some first."); return; }
    notes.push({ id: pvId(), text: t.slice(0, 500), t: Date.now(), kind: pv.kind, done: false, pin: false, ann: [] });
    if (!pvSave(notes)) return;
    box.value = ""; box.style.height = "auto";
    pvRender(true);
  };
  sel.onchange = function () { pvShow(sel.value); };
  back.onclick = closePrivate;
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !root.hidden) { e.stopImmediatePropagation(); closePrivate(); }
  }, true);
  return pv;
}
function pvHeader() {
  const all = pvApi() ? pvApi().list() : [];
  const info = pvInfo(pv.id);
  pv.title.textContent = info ? info.name : "Private project";
  const bits = ["Private, only you"];
  if (info && info.course) bits.push(info.course);
  if (info && info.due) bits.push("due " + info.due);
  pv.sub.textContent = bits.join(" \u00b7 ");
  pv.sel.textContent = "";
  all.forEach(function (x) { const o = document.createElement("option"); o.value = x.id; o.textContent = x.name; if (x.id === pv.id) o.selected = true; pv.sel.appendChild(o); });
  pv.sel.hidden = all.length < 2;
}
function pvShow(id) {
  if (!pvInfo(id)) return;
  pv.id = id; pv.open = ""; pv.annFor = ""; pv.editId = "";
  try { localStorage.setItem("cadence:lastPrivate", id); } catch (e) {}
  pvHeader();
  pvRender(true);
}
function pvRow(n) {
  const wrap = mk("div", "chat-row chat-row-mine");
  const row = mk("div", "chat-msg chat-mine" + (n.pin ? " pv-pinned" : ""));
  const meta = mk("div", "chat-meta");
  meta.appendChild(mk("small", "", (n.pin ? "Pinned \u00b7 " : "") + (n.kind === "todo" ? "Task \u00b7 " : "") + timeLabel(n.t)));
  row.appendChild(meta);
  const dots = mk("button", "chat-dots", "\u22ef");
  dots.type = "button"; dots.setAttribute("aria-label", "Entry actions");
  dots.setAttribute("aria-expanded", pv.open === n.id ? "true" : "false");
  dots.onclick = function () { pv.open = pv.open === n.id ? "" : n.id; pvRender(false); };
  row.appendChild(dots);
  if (pv.editId === n.id) {
    const ta = mk("textarea", "field pv-edit");
    ta.rows = 3; ta.maxLength = 500; ta.value = n.text;
    ta.setAttribute("aria-label", "Edit entry");
    const acts = mk("div", "chat-actions");
    const ok = mk("button", "chat-act", "Save");
    ok.type = "button";
    ok.onclick = function () { const v = ta.value.trim(); if (!v) return; pv.editId = ""; pvChange(n.id, function (x) { x.text = v.slice(0, 500); }); };
    const no = mk("button", "chat-act", "Cancel");
    no.type = "button";
    no.onclick = function () { pv.editId = ""; pvRender(false); };
    acts.appendChild(ok); acts.appendChild(no);
    row.appendChild(ta); row.appendChild(acts);
    setTimeout(function () { ta.focus(); }, 0);
  } else if (n.kind === "todo") {
    const lab = mk("label", "pv-todo");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = n.done;
    cb.onchange = function () { pvChange(n.id, function (x) { x.done = cb.checked; }); };
    const txt = linkify(n.text);
    if (n.done) txt.classList.add("pv-done");
    lab.appendChild(cb); lab.appendChild(txt);
    row.appendChild(lab);
  } else {
    row.appendChild(linkify(n.text));
  }
  n.ann.forEach(function (a) {
    const line = mk("div", "pv-ann");
    line.appendChild(mk("span", "pv-ann-text", "\u21b3 " + a.text));
    line.appendChild(mk("small", "", timeLabel(a.t)));
    const x = mk("button", "chat-dots pv-ann-x", "\u2715");
    x.type = "button"; x.setAttribute("aria-label", "Remove annotation");
    x.onclick = function () { pvChange(n.id, function (y) { y.ann = y.ann.filter(function (z) { return z.id !== a.id; }); }); };
    line.appendChild(x);
    row.appendChild(line);
  });
  if (pv.annFor === n.id) {
    const f = mk("form", "pv-ann-form");
    f.autocomplete = "off";
    const inp = mk("input", "field");
    inp.type = "text"; inp.maxLength = 300; inp.placeholder = "Add an annotation";
    inp.setAttribute("aria-label", "Annotation");
    const go = mk("button", "chat-act", "Add");
    go.type = "submit";
    const no = mk("button", "chat-act", "Cancel");
    no.type = "button";
    no.onclick = function () { pv.annFor = ""; pvRender(false); };
    f.onsubmit = function (e) {
      e.preventDefault();
      const v = inp.value.trim();
      if (!v) return;
      pv.annFor = "";
      pvChange(n.id, function (x) { if (x.ann.length < 20) x.ann.push({ id: pvId(), text: v.slice(0, 300), t: Date.now() }); });
    };
    f.appendChild(inp); f.appendChild(go); f.appendChild(no);
    row.appendChild(f);
    setTimeout(function () { inp.focus(); }, 0);
  }
  if (pv.open === n.id) {
    const bar = mk("div", "chat-actions");
    function act(label, fn, danger) {
      const b = mk("button", "chat-act" + (danger ? " danger" : ""), label);
      b.type = "button";
      b.onclick = function () { pv.open = ""; fn(); };
      bar.appendChild(b);
    }
    act(n.pin ? "Unpin" : "Pin", function () { pvChange(n.id, function (x) { x.pin = !x.pin; }); });
    act("Annotate", function () { pv.annFor = n.id; pvRender(false); });
    act("Edit", function () { pv.editId = n.id; pvRender(false); });
    act(n.kind === "todo" ? "Make note" : "Make task", function () { pvChange(n.id, function (x) { x.kind = x.kind === "todo" ? "note" : "todo"; x.done = false; }); });
    act("Copy", function () { if (navigator.clipboard) navigator.clipboard.writeText(n.text).catch(function () {}); pvRender(false); });
    act("Delete", function () { const rest = pvNotes().filter(function (x) { return x.id !== n.id; }); if (pvSave(rest)) pvRender(false); }, true);
    row.appendChild(bar);
  }
  wrap.appendChild(row);
  return wrap;
}
function pvRender(stick) {
  const list = pv.list;
  list.textContent = "";
  const notes = pvNotes();
  if (!notes.length) list.appendChild(mk("p", "hint chat-empty", "Nothing here yet. Write a note below, or tap Note to switch to Task for a to-do. Use \u22ef on any entry to pin, edit or annotate it."));
  const pinned = notes.filter(function (n) { return n.pin; });
  if (pinned.length) {
    list.appendChild(mk("div", "chat-day", "Pinned"));
    pinned.forEach(function (n) { list.appendChild(pvRow(n)); });
  }
  let day = "";
  notes.filter(function (n) { return !n.pin; }).forEach(function (n) {
    const d = dayLabel(n.t);
    if (d !== day) { day = d; list.appendChild(mk("div", "chat-day", d)); }
    list.appendChild(pvRow(n));
  });
  if (stick !== false) list.scrollTop = list.scrollHeight;
}
function openPrivate(id) {
  if (!me || !pvApi()) return;
  const all = pvApi().list();
  if (!all.length) return;
  hubClose();
  pvBuild();
  const pick = pvInfo(id) || all[0];
  pv.kind = "note"; pv.mode.textContent = "Note"; pv.box.placeholder = "Write a note";
  pvShow(pick.id);
  pv.root.hidden = false;
  document.body.classList.add("chat-open");
}
function closePrivate() {
  if (pv) pv.root.hidden = true;
  const chatOpen = ui && !ui.root.hidden;
  if (!chatOpen) {
    document.body.classList.remove("chat-open");
    if (location.hash === "#projects" && window.showTab) window.showTab("home");
  }
}
window.addEventListener("cadence:privateprojects:changed", function () {
  if (ui && cur && !ui.root.hidden) drawRail();
  if (pv && !pv.root.hidden) { if (!pvInfo(pv.id)) closePrivate(); else { pvHeader(); } }
});

// ---- Home inbox: every project chat in one list ----
let inboxFilter = "";
function ago(t) {
  if (!t) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.round(h / 24);
  return d < 8 ? d + "d ago" : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function lastChat(p) {
  const at = p.chatAt && typeof p.chatAt === "object" ? p.chatAt : {};
  return Object.keys(at).reduce(function (a, k) { return Math.max(a, Number(at[k]) || 0); }, 0);
}
function inboxTile(label, count, key, on, fn) {
  const b = mk("button", "chat-tile" + (on ? " on" : "") + (count ? " has" : ""));
  b.type = "button";
  b.setAttribute("aria-pressed", on ? "true" : "false");
  b.appendChild(mk("strong", "", String(count)));
  b.appendChild(mk("small", "", label));
  b.onclick = fn;
  return b;
}
function setTabBadge(n, mention) {
  const tab = document.getElementById("tab-projects");
  if (!tab) return;
  let b = tab.querySelector(".tab-badge");
  if (!n) { if (b) b.remove(); tab.removeAttribute("data-unread"); return; }
  if (!b) { b = mk("span", "tab-badge"); b.setAttribute("aria-hidden", "true"); tab.appendChild(b); }
  b.textContent = n > 9 ? "9+" : String(n);
  b.classList.toggle("mention", !!mention);
  tab.dataset.unread = String(n);
  tab.setAttribute("aria-label", "Projects, " + n + (n === 1 ? " chat has" : " chats have") + " new messages" + (mention ? ", you were mentioned" : ""));
}

// The four counters sit inside each project card rather than in a global strip.
function renderInbox(box, projects) {
  if (box) { box.textContent = ""; box.hidden = true; }
  if (!me) { setTabBadge(0, false); return; }
  const rows = projects.map(function (p) { return unreadFor(p); });
  setTabBadge(rows.filter(function (u) { return u.threads.size; }).length, rows.some(function (u) { return u.mention; }));
}

// Four counters for one project: Unread, Mentions, Saved and My tasks (taskStageIds = my open stages here)
function tiles(p, taskStageIds) {
  const wrap = mk("div", "chat-tiles");
  if (!me) { wrap.hidden = true; return wrap; }
  const u = unreadFor(p);
  const mentioned = u.mention ? 1 : 0;
  const saved = readSaved().filter(function (x) { return x.pid === p.id; }).length;
  const tasks = taskStageIds || [];
  const mine = [
    ["Unread", u.threads.size, function () { openChat(p, Array.from(u.threads)[0] || ""); }, u.threads.size > 0],
    ["@ Mentions", mentioned, function () { const m = p.chatMention && p.chatMention[me.uid]; openChat(p, m ? m.thread : ""); }, mentioned > 0],
    ["Saved", saved, openSaved, false],
    ["My tasks", tasks.length, function () { if (sp() && sp().show) sp().show(p.id, tasks[0] || ""); }, tasks.length > 0]
  ];
  mine.forEach(function (t) {
    const b = mk("button", "chat-tile" + (t[3] ? " has" : ""));
    b.type = "button";
    b.appendChild(mk("strong", "", String(t[1])));
    b.appendChild(mk("small", "", t[0]));
    b.setAttribute("aria-label", t[0] + ": " + t[1] + " in " + p.name);
    b.onclick = t[2];
    wrap.appendChild(b);
  });
  return wrap;
}

function openProject(p, stageId) {
  if (!me) return;
  if (!cur || cur.p.id !== p.id) openChat(p, stageId || "");
  showProjectSheet(stageId || "");
}

document.addEventListener("click", function (e) {
  if (!cur || !e.target.closest) return;
  const tb = e.target.closest(".tabbar .tab");
  if (tb && tb.dataset.tab !== "projects") close();
});

window.CadenceChat = { host: hostEl, openAny: openAny, openPrivate: openPrivate, openProject: openProject, notice: notice, close: close, button: button, stageButton: stageButton, open: openChat, log: log, unreadFor: unreadFor, inbox: renderInbox, tiles: tiles };

document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "hidden") { flushSeen(); return; }
  if (!me || Date.now() - lastSeenPull < 60000) return;
  pullSeen().then(function (changed) {
    if (changed && sp() && sp().rerender) sp().rerender();
    if (changed && cur && ui && !ui.root.hidden) fillPicker();
  });
});

let lastPull = Date.now();
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState !== "visible" || !me || (ui && !ui.root.hidden)) return;
  if (Date.now() - lastPull < 120000) return;
  lastPull = Date.now();
  if (sp() && sp().reload) sp().reload();
});

onAuthStateChanged(getAuth(), async function (user) {
  me = user || null;
  admin = false;
  seenSyncOff = false; seenDirty = {};
  if (cur) close();
  if (sv) sv.root.hidden = true;
  if (me) { try { admin = (await getDoc(doc(db, "admins", me.uid))).exists(); } catch (e) {} }
  if (me) await pullSeen();
  if (sp() && sp().rerender) sp().rerender();
});

// Keep the logo badge on the rail current when new messages or requests arrive
document.addEventListener("cadence:hub", function () { if (ui && cur && !ui.root.hidden) drawRail(); });
