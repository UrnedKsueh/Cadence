// Project chat: every shared project gets # General, # Announcements (owner/admin-only posting) and one thread per stage.
// Messages live in sharedProjects/{pid}/threads/{threadId}/messages. Runs after sharedprojects.js.
// Free-plan friendly: only the open thread is listened to, history loads 30 at a time, unread uses a map on the project doc.
import { avatarFor } from "./avatars.js";
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
const picked = new Map(); // people chosen from the @ list: uid -> name

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
    const stageId = cur.tid && cur.tid !== "general" && cur.tid !== "announcements" ? cur.tid : "";
    showProjectSheet(stageId);
  };
  head.appendChild(back); head.appendChild(titles); head.appendChild(stagesBtn);

  const list = mk("div", "chat-list");
  list.setAttribute("role", "log");
  list.setAttribute("aria-live", "polite");

  const note = mk("p", "hint chat-note");
  note.hidden = true;

  const form = mk("form", "chat-form");
  form.autocomplete = "off";
  const box = mk("textarea", "field chat-input");
  box.rows = 1; box.maxLength = MAX_LEN;
  box.placeholder = "Message, or type @ to mention";
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
  form.appendChild(suggest); form.appendChild(sheet);
  form.appendChild(plus); form.appendChild(box); form.appendChild(send);

  const drawer = mk("div", "chat-drawer");
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

  root.appendChild(head); root.appendChild(list); root.appendChild(note); root.appendChild(form); root.appendChild(drawer); root.appendChild(proj);
  document.body.appendChild(root);

  back.onclick = close;
  pick.onclick = function () { if (cur) toggleDrawer(); };
  scrim.onclick = function () { toggleDrawer(false); };
  plus.onclick = function () { toggleSheet(); };
  form.onsubmit = function (e) { e.preventDefault(); submit(); };
  box.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
  });
  box.addEventListener("input", function () {
    box.style.height = "auto";
    box.style.height = Math.min(box.scrollHeight, 120) + "px";
    showSuggest();
  });
  box.addEventListener("click", showSuggest);
  box.addEventListener("blur", function () { setTimeout(hideSuggest, 150); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !root.hidden) { if (!proj.hidden) proj.hidden = true; else if (!drawer.hidden) toggleDrawer(false); else if (!sheet.hidden) toggleSheet(false); else close(); } });

  ui = { suggest: suggest, root: root, title: title, pick: pick, list: list, note: note, box: box, send: send, back: back, plus: plus, sheet: sheet, drawer: drawer, panel: panel, proj: proj, jpanel: jpanel };
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

// sharedprojects.js messages (errors, "Code copied") show here while the sheet is open
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

function setTitle() {
  const n = cur.p.members.length;
  ui.title.textContent = "";
  ui.title.appendChild(mk("span", "chat-title-name", cur.p.name));
  ui.title.appendChild(mk("small", "chat-title-sub", n + (n === 1 ? " person" : " people") + " \u203a"));
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
  b.onclick = function () { toggleDrawer(false); if (!on) switchTo(t.id); };
  return b;
}

function fillPicker() {
  const u = unreadFor(cur.p);
  const others = threadsOf(cur.p).some(function (t) { return u.threads.has(t.id) && t.id !== cur.tid; });
  const isStage = cur.tid && cur.tid !== "general" && cur.tid !== "announcements";
  ui.pick.textContent = "";
  ui.pick.appendChild(mk("span", "chat-pick-label", (isStage ? "" : "# ") + threadLabel(cur.tid)));
  ui.pick.appendChild(mk("span", "chat-pick-caret", "\u25be"));
  if (others) ui.pick.appendChild(mk("span", "chat-badge", "\u25cf"));
  const panel = ui.panel;
  panel.textContent = "";
  panel.appendChild(mk("div", "chat-drawer-grip"));
  panel.appendChild(mk("h3", "chat-drawer-title", cur.p.name));
  panel.appendChild(mk("p", "chat-drawer-sec", "Channels"));
  threadsOf(cur.p).filter(function (t) { return t.id === "general" || t.id === "announcements"; })
    .forEach(function (t) { panel.appendChild(drawerRow(t, u, "channel")); });
  if (cur.p.stages.length) {
    panel.appendChild(mk("p", "chat-drawer-sec", "Stages"));
    cur.p.stages.forEach(function (s) { panel.appendChild(drawerRow({ id: s.id, label: "Stage: " + s.name }, u, "stage")); });
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
}

function say(text) {
  ui.note.textContent = text || "";
  ui.note.hidden = !text && canPost();
  if (!text && !canPost()) ui.note.textContent = "Only admins can post in Announcements.";
}

function msgsRef() { return collection(db, "sharedProjects", cur.p.id, "threads", cur.tid, "messages"); }

function dayLabel(t) { return new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }
// ---- @ suggestions: people in this project, picked from a list ----
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

// Live project card: always shows the project as it is now, so there is nothing to "update".
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
  list.textContent = "";
  if (cur.pins.size) {
    const box = mk("div", "chat-pins");
    cur.pins.forEach(function (pin, id) {
      const row = mk("div", "chat-pin");
      row.appendChild(mk("span", "", "\ud83d\udccc " + (pin.name ? pin.name + ": " : "") + (pin.text.length > 140 ? pin.text.slice(0, 140) + "\u2026" : pin.text)));
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
      const isStage = cur.tid !== "general" && cur.tid !== "announcements";
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
    const next = items[i + 1];
    const joins = function (x, y) { return x && y && y.kind !== "system" && y.kind !== "card" && x.uid === y.uid && dayLabel(x.t) === dayLabel(y.t) && Math.abs(y.t - x.t) < 5 * 60 * 1000; };
    const cont = joins(prev, m);
    const lastOfGroup = !joins(m, next);
    prev = m;
    const mine = me && m.uid === me.uid;
    const tagged = me && Array.isArray(m.mentions) && m.mentions.indexOf(me.uid) >= 0;
    const wrap = mk("div", "chat-row" + (mine ? " chat-row-mine" : "") + (cont ? " chat-cont" : ""));
    if (lastOfGroup) wrap.appendChild(avatarFor(m.uid, m.name, "chat-ava"));
    else wrap.appendChild(mk("span", "chat-ava-gap"));
    const row = mk("div", "chat-msg" + (mine ? " chat-mine" : "") + (tagged || (m.everyone && !mine) ? " chat-tagged" : ""));
    if (!cont) {
      const meta = mk("div", "chat-meta");
      meta.appendChild(mk("strong", "", mine ? "You" : (m.name || "Member")));
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
    row.appendChild(bodyNode(m));
    if (cont) row.classList.add("chat-msg-cont");
    row.appendChild(reactionRow(m));
    if (open) {
      const bar = mk("div", "chat-actions");
      const act = function (label, fn, danger) {
        const x = mk("button", "chat-act" + (danger ? " danger" : ""), label);
        x.type = "button";
        x.onclick = function () { cur.menu = ""; fn(); };
        bar.appendChild(x);
      };
      act("React", function () { cur.picker = m.id; render(false); });
      act("Copy", function () { if (navigator.clipboard) navigator.clipboard.writeText(m.text).catch(function () {}); });
      act("Save", function () { say(addSaved(m.text, cur.p.name + " \u00b7 " + threadLabel(cur.tid), cur.p.id) ? "Saved to your notes." : "Couldn't save. This browser may be blocking storage."); });
      if (canPin) act(cur.pins.has(m.id) ? "Unpin" : "Pin", function () { setPin(m.id, !cur.pins.has(m.id)); });
      if (canDel) act("Delete", function () { removeMsg(m.id); }, true);
      row.appendChild(bar);
    }
    wrap.appendChild(row);
    list.appendChild(wrap);
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
    kind: d.kind || "", everyone: d.everyone === true, reactions: d.reactions && typeof d.reactions === "object" ? d.reactions : {}, pinned: !!d.pinned, mentions: Array.isArray(d.mentions) ? d.mentions : [], t: ms(d.createdAt) || Date.now()
  });
}

async function switchTo(tid) {
  if (cur && cur.unsub) { cur.unsub(); cur.unsub = null; }
  const p = cur.p;
  cur = { p: p, tid: tid, msgs: new Map(), pins: new Map(), picker: "", menu: "", unsub: null, oldest: null, hasMore: false };
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
  // People picked from the @ list (their name must still be in the text)
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

// Mark the thread as having new activity so other members see an unread dot
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
  try {
    const mentions = await resolveMentions(p, text);
    const data = { uid: me.uid, name: myName(p), text: text, createdAt: serverTimestamp() };
    if (mentions.length) data.mentions = mentions.slice(0, 10);
    const everyone = manage(p) && /(^|\s)@everyone\b/i.test(text);
    if (everyone) data.everyone = true;
    await addDoc(collection(db, "sharedProjects", p.id, "threads", tid, "messages"), data);
    ui.box.value = ""; ui.box.style.height = "auto";
    picked.clear(); hideSuggest();
    say("");
    markSeen(p.id, tid);
    bump(p, tid, mentions, everyone);
  } catch (e) {
    if (cur === mine) say("Couldn't send. Check your connection, and that the chat rules are published in Firebase.");
  }
  if (cur === mine) setComposer();
}

function openChat(p, tid) {
  if (!me) return;
  build();
  cur = { p: p, tid: "", msgs: new Map(), pins: new Map(), picker: "", menu: "", unsub: null, oldest: null, hasMore: false };
  setTitle();
  ui.root.querySelector(".chat-stages").textContent = "Stages (" + p.stages.length + ")";
  ui.proj.hidden = true;
  ui.root.hidden = false;
  document.body.classList.add("chat-open");
  const start = tid && threadsOf(p).some(function (t) { return t.id === tid; }) ? tid : "general";
  switchTo(start);
  ui.back.focus();
}

function close() {
  picked.clear();
  if (cur && cur.unsub) cur.unsub();
  cur = null;
  if (ui) { ui.root.hidden = true; ui.drawer.hidden = true; ui.proj.hidden = true; ui.sheet.hidden = true; }
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

// ---- Saved: a private scratch space (Slack's "message yourself"), kept on this device ----
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

// ---- Home inbox: every project chat in one list, Slack style ----
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

// The global strip is gone: the same four counters now live inside each project card.
function renderInbox(box, projects) {
  if (box) { box.textContent = ""; box.hidden = true; }
  if (!me) { setTabBadge(0, false); return; }
  const rows = projects.map(function (p) { return unreadFor(p); });
  setTabBadge(rows.filter(function (u) { return u.threads.size; }).length, rows.some(function (u) { return u.mention; }));
}

// Four small counters for one project: Unread, Mentions, Saved, My tasks (taskStageIds = my open stages here)
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

window.CadenceChat = { openProject: openProject, notice: notice, close: close, button: button, stageButton: stageButton, open: openChat, log: log, unreadFor: unreadFor, inbox: renderInbox, tiles: tiles };

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
  if (cur) close();
  if (sv) sv.root.hidden = true;
  if (me) { try { admin = (await getDoc(doc(db, "admins", me.uid))).exists(); } catch (e) {} }
  if (sp() && sp().rerender) sp().rerender();
});
