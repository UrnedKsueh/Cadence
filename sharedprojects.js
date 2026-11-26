// Shared projects: admins and students create projects, add members and assign stages.
// Members see their projects and update the status of their own stages. Loads after cloud.js.
import { avatarEl, avatarFor } from "./avatars.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, query, where, orderBy, limit, getDocs, addDoc, setDoc, updateDoc, deleteDoc, arrayUnion, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const db = getFirestore(getApp());
const $ = function (id) { return document.getElementById(id); };

const TEMPLATES = [
  { name: "Animation pipeline", stages: ["Script", "Storyboard", "Animatic", "Layout", "Animation", "Lighting & render", "Compositing", "Sound & edit", "Delivered"] },
  { name: "3D character", stages: ["Concept", "Modeling", "Texturing", "Rigging", "Animation", "Render", "Delivered"] },
  { name: "Motion graphics", stages: ["Brief", "Style frames", "Storyboard", "Animation", "Sound", "Review", "Delivered"] },
  { name: "Short film", stages: ["Concept", "Script", "Storyboard", "Animatic", "Production", "Post", "Delivered"] },
  { name: "Empty project", stages: [] }
];
const STATUS = ["To do", "In progress", "Review", "Needs changes", "Done"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_STAGES = 30;
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

let me = null;
let admin = false;
let projects = [];
let loading = false;
let lastFetch = 0;
const open = new Set();

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function ms(t) { return t && typeof t.toMillis === "function" ? t.toMillis() : Number(t) || 0; }
function newId() { return Math.random().toString(36).slice(2, 8); }
function say(text) {
  if (text && window.CadenceChat && window.CadenceChat.notice && window.CadenceChat.notice(text)) return;
  const m = $("sharedMsg");
  m.textContent = text || "";
  m.hidden = !text;
}
function nameOf(p, uid) {
  if (me && uid === me.uid) return "You";
  return (p.names && p.names[uid]) || "Member";
}
function manage(p) { return admin || (!!me && p.createdBy === me.uid); }
function canEdit(p, stage) { return manage(p) || (me && stage.assignee === me.uid); }
function doneCount(p) { return p.stages.filter(function (s) { return s.status === "Done"; }).length; }
function daysUntil(text) {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Math.round((new Date(text + "T00:00:00") - t) / 86400000);
}
function dueLabel(text) {
  const left = daysUntil(text);
  if (left < 0) return "Overdue by " + Math.abs(left) + (Math.abs(left) === 1 ? " day" : " days");
  if (left === 0) return "Due today";
  if (left === 1) return "Due tomorrow";
  return "Due " + new Date(text + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function stageDue(p, s) { return s.due || p.due || ""; }
function percent(p) { return p.stages.length ? Math.round(doneCount(p) / p.stages.length * 100) : 0; }

function safeLink(v) {
  const t = String(v || "").trim().slice(0, 300);
  return /^https:\/\/[^\s]+$/i.test(t) ? t : "";
}

const MAX_LINKS = 5;
function cleanLinks(s) {
  let out = (Array.isArray(s.links) ? s.links : []).map(function (l) {
    return { label: String((l && l.label) || "").trim().slice(0, 30), url: safeLink(l && l.url) };
  }).filter(function (l) { return l.url; }).slice(0, MAX_LINKS);
  if (!out.length && safeLink(s.link)) out = [{ label: "Files", url: safeLink(s.link) }];
  return out;
}

function clean(p) {
  p.members = Array.isArray(p.members) ? p.members : [];
  p.names = p.names && typeof p.names === "object" ? p.names : {};
  p.stages = (Array.isArray(p.stages) ? p.stages : []).map(function (s) {
    return {
      id: String(s.id || newId()),
      name: String(s.name || "Stage").slice(0, 60),
      assignee: String(s.assignee || ""),
      status: STATUS.indexOf(s.status) >= 0 ? s.status : "To do",
      due: DATE_RE.test(String(s.due || "")) ? String(s.due) : "",
      note: String(s.note || "").slice(0, 300),
      links: cleanLinks(s)
    };
  });
  return p;
}

async function load(force) {
  if (!me || loading) return;
  if (!force && Date.now() - lastFetch < 60000) return;
  loading = true;
  try {
    const col = collection(db, "sharedProjects");
    const q = admin
      ? query(col, orderBy("createdAt", "desc"), limit(50))
      : query(col, where("members", "array-contains", me.uid), limit(50));
    const snap = await getDocs(q);
    projects = snap.docs.map(function (d) { return clean(Object.assign({ id: d.id }, d.data())); });
    projects.sort(function (a, b) { return ms(b.createdAt) - ms(a.createdAt); });
    say("");
  } catch (e) {
    say("Couldn't load shared projects. Check your connection, and that the shared project rules are published in Firebase.");
  }
  loading = false;
  lastFetch = Date.now();
  render();
  window.dispatchEvent(new CustomEvent("cadence:sharedprojects", { detail: projects }));
}

async function patch(p, fields) {
  try {
    await updateDoc(doc(db, "sharedProjects", p.id), Object.assign({ updatedAt: Date.now() }, fields));
    Object.assign(p, fields);
    say("");
    return true;
  } catch (e) {
    say("Couldn't save that change. Check your connection and try again.");
    await load(true);
    return false;
  }
}

function memberOptions(p, current) {
  const sel = mk("select", "field sp-select");
  sel.appendChild(new Option("Unassigned", ""));
  p.members.forEach(function (uid) { sel.appendChild(new Option(nameOf(p, uid), uid)); });
  sel.value = current;
  return sel;
}

const openStages = new Set();
// Next step shown as one clear button: [label, new status]
const NEXT = {
  "To do": ["Start working", "In progress"],
  "In progress": ["Send for review", "Review"],
  "Review": ["Mark as done", "Done"],
  "Needs changes": ["Start working again", "In progress"]
};
const STATUS_HELP = {
  "To do": "Not started yet.",
  "In progress": "Someone is working on it.",
  "Review": "Finished and waiting for feedback.",
  "Needs changes": "Feedback was given. Changes are needed.",
  "Done": "Finished."
};
function statusClass(s) { return "sp-st-" + String(s).toLowerCase().replace(/[^a-z]+/g, "-"); }
function isReady(p, stage, i) {
  return !!me && stage.assignee === me.uid && stage.status === "To do" && (i === 0 || p.stages[i - 1].status === "Done");
}

async function setStatus(p, stage, status) {
  stage.status = status;
  if (await patch(p, { stages: p.stages })) {
    if (window.CadenceChat && me) {
      window.CadenceChat.log(p, stage.id, ((p.names && p.names[me.uid]) || me.displayName || "Someone") + " set " + stage.name + " to " + status);
    }
    render();
  }
}

function fieldBlock(label, node) {
  const d = mk("div", "sp-field");
  d.appendChild(mk("span", "sp-label", label));
  d.appendChild(node);
  return d;
}

function linkEditor(p, stage) {
  const det = mk("details", "sp-edit");
  det.appendChild(mk("summary", "", stage.note || stage.links.length ? "Edit note and links" : "Add a note or links"));
  const form = mk("form", "sp-edit-form");
  form.autocomplete = "off";
  const note = mk("textarea", "field");
  note.rows = 2; note.maxLength = 300; note.value = stage.note;
  note.placeholder = "Note for the team, e.g. v2 is ready, check shot 14";
  note.setAttribute("aria-label", "Note for " + stage.name);
  form.appendChild(note);
  form.appendChild(mk("small", "hint", "Add links to Drive or Dropbox files. Name each one, e.g. v1, v2, final."));
  const rows = mk("div", "sp-link-rows");
  const draft = stage.links.map(function (l) { return { label: l.label, url: l.url }; });
  function drawRows() {
    rows.textContent = "";
    draft.forEach(function (l, k) {
      const r = mk("div", "sp-link-row");
      const lab = mk("input", "field");
      lab.maxLength = 30; lab.value = l.label; lab.placeholder = "Name, e.g. v2";
      lab.setAttribute("aria-label", "Name of link " + (k + 1));
      lab.oninput = function () { l.label = lab.value; };
      const url = mk("input", "field");
      url.type = "url"; url.maxLength = 300; url.value = l.url; url.placeholder = "https://...";
      url.setAttribute("aria-label", "Address of link " + (k + 1));
      url.oninput = function () { l.url = url.value; };
      const rm = mk("button", "secondary sp-x", "Remove");
      rm.type = "button";
      rm.setAttribute("aria-label", "Remove link " + (k + 1));
      rm.onclick = function () { draft.splice(k, 1); drawRows(); };
      r.appendChild(lab); r.appendChild(url); r.appendChild(rm);
      rows.appendChild(r);
    });
  }
  drawRows();
  form.appendChild(rows);
  const addLink = mk("button", "secondary sp-x", "Add a link");
  addLink.type = "button";
  addLink.onclick = function () {
    if (draft.length >= MAX_LINKS) { say("Up to " + MAX_LINKS + " links per stage."); return; }
    draft.push({ label: "", url: "" }); drawRows();
  };
  form.appendChild(addLink);
  const save = mk("button", "", "Save");
  save.type = "submit";
  form.appendChild(save);
  form.onsubmit = async function (e) {
    e.preventDefault();
    const links = [];
    for (let k = 0; k < draft.length; k++) {
      const raw = String(draft[k].url || "").trim();
      if (!raw) continue;
      const ok = safeLink(raw);
      if (!ok) { say("Links must start with https://"); return; }
      links.push({ label: String(draft[k].label || "").trim().slice(0, 30), url: ok });
    }
    say("");
    stage.note = note.value.trim().slice(0, 300);
    stage.links = links;
    delete stage.link;
    if (await patch(p, { stages: p.stages })) render();
  };
  det.appendChild(form);
  return det;
}

function stageRow(p, stage, i) {
  const mine = !!me && stage.assignee === me.uid;
  const li = mk("li", "sp-stage" + (mine ? " sp-mine" : ""));
  li.dataset.stage = stage.id;
  const det = mk("details", "sp-stage-det");
  det.open = openStages.has(stage.id);
  det.addEventListener("toggle", function () { if (det.open) openStages.add(stage.id); else openStages.delete(stage.id); });

  // Summary line: what is visible without tapping
  const sum = mk("summary", "sp-stage-sum");
  const dot = mk("span", "sp-dot " + statusClass(stage.status));
  dot.setAttribute("aria-hidden", "true");
  sum.appendChild(dot);
  const main = mk("span", "sp-stage-main");
  main.appendChild(mk("strong", "", stage.name));
  const sub = mk("small", "sp-sub");
  sub.appendChild(document.createTextNode(stage.assignee ? (mine ? "You" : nameOf(p, stage.assignee)) : "Not assigned yet"));
  const due = stageDue(p, stage);
  if (due) {
    const late = stage.status !== "Done" && daysUntil(due) < 0;
    const dueNode = mk("span", late ? "sp-late-text" : "", " \u00b7 " + dueLabel(due));
    sub.appendChild(dueNode);
  }
  main.appendChild(sub);
  sum.appendChild(main);
  const right = mk("span", "sp-stage-right");
  if (isReady(p, stage, i)) right.appendChild(mk("span", "chip sp-ready", "Your turn"));
  else if (mine && stage.status === "Needs changes") right.appendChild(mk("span", "chip sp-ready", "Fix needed"));
  else {
    const st = mk("span", "sp-st-label", stage.status);
    right.appendChild(st);
  }
  if (window.CadenceChat && window.CadenceChat.unreadFor(p).threads.has(stage.id)) {
    const u = mk("span", "sp-unread", "\u25cf");
    u.setAttribute("aria-label", "New messages in this stage");
    right.appendChild(u);
  }
  sum.appendChild(right);
  det.appendChild(sum);

  // Details: shown when the stage is tapped
  const body = mk("div", "sp-stage-body");
  if (isReady(p, stage, i)) body.appendChild(mk("p", "sp-tip", "It's your turn. The stage before yours is finished, so you can start."));
  if (mine && stage.status === "Needs changes") body.appendChild(mk("p", "sp-tip", "Feedback was left on this stage. Check the note and chat, then start again."));

  // Who
  if (manage(p)) {
    const who = memberOptions(p, stage.assignee);
    who.setAttribute("aria-label", "Assigned to, for " + stage.name);
    who.onchange = async function () {
      stage.assignee = who.value;
      if (await patch(p, { stages: p.stages })) render();
    };
    body.appendChild(fieldBlock("Assigned to", who));
  }

  // Status: one clear next step, plus a menu for anything else
  if (canEdit(p, stage)) {
    const wrap = mk("div", "sp-status-box");
    const next = NEXT[stage.status];
    if (next) {
      const go = mk("button", "sp-next-step", next[0]);
      go.type = "button";
      go.onclick = function () { go.disabled = true; setStatus(p, stage, next[1]); };
      wrap.appendChild(go);
    }
    const st = mk("select", "field sp-select");
    st.setAttribute("aria-label", "Change status of " + stage.name);
    STATUS.forEach(function (x) { st.appendChild(new Option(x, x)); });
    st.value = stage.status;
    st.onchange = function () { setStatus(p, stage, st.value); };
    wrap.appendChild(fieldBlock("Or choose a status", st));
    wrap.appendChild(mk("small", "hint", STATUS_HELP[stage.status]));
    body.appendChild(fieldBlock("Status: " + stage.status, wrap));
  } else {
    const ro = mk("div", "sp-status-box");
    const chip = mk("span", "status sp-status", stage.status);
    chip.dataset.status = stage.status;
    ro.appendChild(chip);
    ro.appendChild(mk("small", "hint", STATUS_HELP[stage.status] + (stage.assignee ? " Only " + nameOf(p, stage.assignee) + " can change it." : "")));
    body.appendChild(fieldBlock("Status", ro));
  }

  if (manage(p)) {
    const dueIn = mk("input", "field sp-select");
    dueIn.type = "date";
    dueIn.value = stage.due;
    dueIn.setAttribute("aria-label", "Due date for " + stage.name);
    dueIn.onchange = async function () {
      stage.due = dueIn.value;
      if (await patch(p, { stages: p.stages })) render();
    };
    body.appendChild(fieldBlock("Due date", dueIn));
  }

  if (stage.note) body.appendChild(mk("p", "sp-note", stage.note));
  if (stage.links.length) {
    const box = mk("div", "sp-links");
    stage.links.forEach(function (l, k) {
      const a = mk("a", "sp-link", l.label || (stage.links.length > 1 ? "Link " + (k + 1) : "Open files link"));
      a.href = l.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      box.appendChild(a);
    });
    body.appendChild(box);
  }
  if (canEdit(p, stage)) body.appendChild(linkEditor(p, stage));

  const actions = mk("div", "sp-stage-actions");
  if (window.CadenceChat) actions.appendChild(window.CadenceChat.stageButton(p, stage));
  if (manage(p)) {
    [["Up", -1, "Move up"], ["Down", 1, "Move down"]].forEach(function (d) {
      const j = i + d[1];
      const mv = mk("button", "secondary sp-x sp-move", d[2]);
      mv.type = "button";
      mv.setAttribute("aria-label", d[2] + ": " + stage.name);
      mv.disabled = j < 0 || j >= p.stages.length;
      mv.onclick = async function () {
        const a = p.stages.slice();
        const t = a[i]; a[i] = a[j]; a[j] = t;
        if (await patch(p, { stages: a })) render();
      };
      actions.appendChild(mv);
    });
    const rm = mk("button", "secondary sp-x sp-danger", "Remove stage");
    rm.type = "button";
    rm.onclick = async function () {
      if (!confirm("Remove the stage \"" + stage.name + "\"?")) return;
      if (await patch(p, { stages: p.stages.filter(function (s) { return s.id !== stage.id; }) })) render();
    };
    actions.appendChild(rm);
  }
  body.appendChild(actions);
  det.appendChild(body);
  li.appendChild(det);
  return li;
}

async function addPeople(p, people) {
  const room = 40 - p.members.length;
  if (room <= 0) { say("A project can have up to 40 members."); return; }
  const add = people.filter(function (f) { return p.members.indexOf(f.uid) < 0; }).slice(0, room);
  if (!add.length) return;
  const names = Object.assign({}, p.names);
  add.forEach(function (f) { names[f.uid] = String(f.nickname || ("@" + f.handle)).slice(0, 30); });
  if (await patch(p, { members: p.members.concat(add.map(function (f) { return f.uid; })), names: names })) {
    say(add.length === 1 ? (add[0].nickname || "They") + " was added." : add.length + " people were added.");
    render();
  }
}

const openFriendPickers = new Set();
function friendPicker(p) {
  const det = mk("details", "sp-fold sp-friend-fold");
  det.open = openFriendPickers.has(p.id);
  det.addEventListener("toggle", function () { if (det.open) openFriendPickers.add(p.id); else openFriendPickers.delete(p.id); });
  det.appendChild(mk("summary", "", "Add from your friends"));
  const friends = window.CadenceFriends ? window.CadenceFriends.list() : [];
  const avail = friends.filter(function (f) { return p.members.indexOf(f.uid) < 0; });
  if (!friends.length) {
    det.appendChild(mk("p", "hint", "You have no friends on Cadence yet. Add friends from your Profile tab, or add someone by handle below."));
    return det;
  }
  if (!avail.length) {
    det.appendChild(mk("p", "hint", "All your friends are already in this project."));
    return det;
  }
  const ul = mk("ul", "sp-friend-list");
  avail.forEach(function (f) {
    const li = mk("li", "sp-friend");
    li.appendChild(avatarEl(f, "sp-ava", f.nickname));
    const who = mk("span", "sp-friend-who");
    who.appendChild(mk("strong", "", f.nickname || ("@" + f.handle)));
    if (f.handle) who.appendChild(mk("small", "", "@" + f.handle));
    li.appendChild(who);
    const b = mk("button", "secondary sp-x", "Add");
    b.type = "button";
    b.setAttribute("aria-label", "Add " + (f.nickname || f.handle) + " to this project");
    b.onclick = function () { b.disabled = true; addPeople(p, [f]); };
    li.appendChild(b);
    ul.appendChild(li);
  });
  det.appendChild(ul);
  if (avail.length > 1) {
    const all = mk("button", "sp-x", "Add all " + avail.length);
    all.type = "button";
    all.onclick = function () { all.disabled = true; addPeople(p, avail); };
    det.appendChild(all);
  }
  return det;
}

function memberBar(p) {
  const box = mk("div", "sp-members");
  box.appendChild(mk("h3", "", "People"));
  const chips = mk("div", "sp-row");
  if (!p.members.length) chips.appendChild(mk("span", "hint", manage(p) ? "No members yet. Add people by their handle." : "No members listed."));
  p.members.forEach(function (uid) {
    const c = mk("span", "chip sp-person", nameOf(p, uid));
    c.insertBefore(avatarFor(uid, (p.names && p.names[uid]) || "?", "sp-ava"), c.firstChild);
    if (manage(p)) {
      const x = mk("button", "sp-chip-x", "\u2715");
      x.type = "button";
      x.setAttribute("aria-label", "Remove " + nameOf(p, uid) + " from this project");
      x.onclick = async function () {
        if (!confirm("Remove " + nameOf(p, uid) + "? Their stages become unassigned.")) return;
        const names = Object.assign({}, p.names);
        delete names[uid];
        p.stages.forEach(function (s) { if (s.assignee === uid) s.assignee = ""; });
        if (await patch(p, { members: p.members.filter(function (m) { return m !== uid; }), names: names, stages: p.stages })) render();
      };
      c.appendChild(x);
    }
    chips.appendChild(c);
  });
  box.appendChild(chips);

  if (manage(p)) {
    box.appendChild(friendPicker(p));
    box.appendChild(mk("small", "hint", "Or add someone by their handle:"));
    const form = mk("form", "sp-row sp-add");
    form.autocomplete = "off";
    const input = mk("input", "field");
    input.placeholder = "Add by handle, e.g. @mei";
    input.maxLength = 21;
    input.setAttribute("aria-label", "Handle of the person to add");
    const btn = mk("button", "", "Add member");
    btn.type = "submit";
    form.appendChild(input); form.appendChild(btn);
    form.onsubmit = async function (e) {
      e.preventDefault();
      const h = input.value.trim().replace(/^@/, "").toLowerCase();
      if (!HANDLE_RE.test(h)) { say("Handles are 3-20 letters, numbers or _."); return; }
      btn.disabled = true;
      try {
        const hs = await getDoc(doc(db, "handles", h));
        if (!hs.exists()) { say("No one found with @" + h + "."); btn.disabled = false; return; }
        const uid = hs.data().uid;
        if (p.members.indexOf(uid) >= 0) { say("@" + h + " is already a member."); btn.disabled = false; return; }
        if (p.members.length >= 40) { say("A project can have up to 40 members."); btn.disabled = false; return; }
        const prof = await getDoc(doc(db, "profiles", uid));
        const nick = prof.exists() && prof.data().nickname ? String(prof.data().nickname) : "@" + h;
        const names = Object.assign({}, p.names); names[uid] = nick.slice(0, 30);
        if (await patch(p, { members: p.members.concat(uid), names: names })) render();
      } catch (err) { say("Couldn't add that person. Check your connection and try again."); }
      btn.disabled = false;
    };
    box.appendChild(form);
  }
  return box;
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, function (x) { return CODE_CHARS[x % 32]; }).join("");
}
function normCode(v) { return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function showCode(c) { return c.slice(0, 4) + "-" + c.slice(4); }

function inviteBox(p) {
  const box = mk("div", "sp-members sp-invite");
  box.appendChild(mk("h3", "", "Invite code"));
  const row = mk("div", "sp-row");
  async function make() {
    const code = makeCode();
    try {
      await setDoc(doc(db, "invites", code), { pid: p.id, name: p.name, active: true, createdBy: me.uid, createdAt: serverTimestamp() });
      if (p.inviteCode) { try { await deleteDoc(doc(db, "invites", p.inviteCode)); } catch (e) {} }
      if (await patch(p, { inviteCode: code })) render();
    } catch (e) { say("Couldn't create a code. Make sure the invite rules are published in Firebase."); }
  }
  if (p.inviteCode) {
    row.appendChild(mk("strong", "sp-code", showCode(p.inviteCode)));
    const copy = mk("button", "secondary sp-x", "Copy");
    copy.type = "button";
    copy.onclick = async function () {
      try { await navigator.clipboard.writeText(showCode(p.inviteCode)); say("Code copied. Send it to your classmates."); }
      catch (e) { say("Couldn't copy. Select the code and copy it by hand."); }
    };
    const fresh = mk("button", "secondary sp-x", "New code");
    fresh.type = "button";
    fresh.onclick = function () { if (confirm("Make a new code? The old one stops working.")) make(); };
    const off = mk("button", "secondary sp-x", "Turn off");
    off.type = "button";
    off.onclick = async function () {
      try {
        await deleteDoc(doc(db, "invites", p.inviteCode));
        if (await patch(p, { inviteCode: "" })) render();
      } catch (e) { say("Couldn't turn off the code. Check your connection and try again."); }
    };
    row.appendChild(copy); row.appendChild(fresh); row.appendChild(off);
    box.appendChild(row);
    box.appendChild(mk("p", "hint", "Anyone signed in who enters this code joins the project. Members can see the code too."));
  } else {
    const on = mk("button", "secondary", "Create invite code");
    on.type = "button";
    on.onclick = make;
    row.appendChild(on);
    box.appendChild(row);
    box.appendChild(mk("p", "hint", "Lets students join on their own, so you don't add each handle."));
  }
  return box;
}

function stageAdder(p) {
  const form = mk("form", "sp-row sp-add");
  form.autocomplete = "off";
  const input = mk("input", "field");
  input.placeholder = "New stage, e.g. Clean-up";
  input.maxLength = 60;
  input.setAttribute("aria-label", "Name of the new stage");
  const btn = mk("button", "", "Add stage");
  btn.type = "submit";
  form.appendChild(input); form.appendChild(btn);
  form.onsubmit = async function (e) {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    if (p.stages.length >= MAX_STAGES) { say("A project can have up to " + MAX_STAGES + " stages."); return; }
    const stages = p.stages.concat({ id: newId(), name: name.slice(0, 60), assignee: "", status: "To do", due: "", links: [] });
    if (await patch(p, { stages: stages })) render();
  };
  return form;
}

function fold(title, node) {
  const d = mk("details", "sp-fold");
  d.appendChild(mk("summary", "", title));
  d.appendChild(node);
  return d;
}

// Everything about one project, built for the team chat's Project sheet:
// stages, adding a stage, people, invite code and delete.
function projectPanel(p, focusStageId) {
  if (focusStageId) openStages.add(focusStageId);
  const total = p.stages.length;
  const body = mk("div", "sp-body");
  body.appendChild(mk("p", "hint sp-howto", manage(p) ? "Tap a stage to assign it, set a date or update it." : "Tap a stage to see details and update your own."));
  const stages = mk("ul", "sp-stages");
  if (!total) stages.appendChild(mk("li", "hint", "No stages yet."));
  p.stages.forEach(function (s, i) { stages.appendChild(stageRow(p, s, i)); });
  body.appendChild(stages);
  if (manage(p)) body.appendChild(fold("Add a stage", stageAdder(p)));
  body.appendChild(memberBar(p));
  if (manage(p)) body.appendChild(inviteBox(p));
  if (manage(p)) {
    const del = mk("button", "secondary sp-delete", "Delete project");
    del.type = "button";
    del.onclick = async function () {
      if (!confirm("Delete \"" + p.name + "\" for everyone? This can't be undone.")) return;
      try {
        if (p.inviteCode) { try { await deleteDoc(doc(db, "invites", p.inviteCode)); } catch (e) {} }
        await deleteDoc(doc(db, "sharedProjects", p.id));
        open.delete(p.id);
        if (window.CadenceChat && window.CadenceChat.close) window.CadenceChat.close();
        await load(true);
      } catch (e) { say("Couldn't delete. Check your connection and try again."); }
    };
    body.appendChild(del);
  }
  return body;
}

function card(p) {
  const li = mk("li", "project shared-project");
  const isOpen = open.has(p.id);
  const total = p.stages.length;

  const head = mk("div", "sp-card-head");
  const titles = mk("div", "sp-card-titles");
  titles.appendChild(mk("h3", "sp-card-name", p.name));
  const meta = [];
  if (p.course) meta.push(p.course);
  if (p.due) meta.push("Due " + p.due);
  if (!admin && me && p.createdBy === me.uid) meta.push("You own this");
  if (meta.length) titles.appendChild(mk("small", "sp-sub", meta.join(" \u00b7 ")));
  head.appendChild(titles);
  head.appendChild(mk("span", "sp-percent", percent(p) + "%"));
  li.appendChild(head);

  const bar = mk("div", "sp-bar");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(percent(p)));
  bar.setAttribute("aria-label", p.name + " progress");
  const fill = mk("span"); fill.style.width = percent(p) + "%";
  bar.appendChild(fill);
  li.appendChild(bar);
  li.appendChild(mk("small", "sp-sub", total ? doneCount(p) + " of " + total + " stages done" : "No stages yet"));

  // The person's own next task in this project, one tap away
  const mineNext = myTasks().filter(function (t) { return t.p === p; })[0];
  if (mineNext) {
    const nb = mk("button", "sp-next-task");
    nb.type = "button";
    nb.appendChild(mk("small", "", mineNext.ready ? "Your turn" : mineNext.fix ? "Needs your fix" : "Your next task"));
    const dd = stageDue(p, mineNext.s);
    nb.appendChild(mk("strong", "", mineNext.s.name + (dd ? " \u00b7 " + dueLabel(dd) : "")));
    nb.onclick = function () { showProject(p.id, mineNext.s.id); };
    li.appendChild(nb);
  }

  if (window.CadenceChat && window.CadenceChat.tiles) {
    li.appendChild(window.CadenceChat.tiles(p, myTasks().filter(function (t) { return t.p === p; }).map(function (t) { return t.s.id; })));
  }
  const actions = mk("div", "sp-card-actions");
  if (window.CadenceChat) actions.appendChild(window.CadenceChat.button(p));
  li.appendChild(actions);

  return li;
}

function myTasks() {
  const out = [];
  if (!me) return out;
  projects.forEach(function (p) {
    p.stages.forEach(function (s, i) {
      if (s.assignee !== me.uid || s.status === "Done") return;
      const ready = s.status === "To do" && (i === 0 || p.stages[i - 1].status === "Done");
      out.push({ p: p, s: s, ready: ready, fix: s.status === "Needs changes" });
    });
  });
  out.sort(function (a, b) {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    if (a.fix !== b.fix) return a.fix ? -1 : 1;
    const da = stageDue(a.p, a.s) || "9999", db2 = stageDue(b.p, b.s) || "9999";
    return da < db2 ? -1 : da > db2 ? 1 : 0;
  });
  return out;
}

function renderTasks() {
  const box = $("myTasks");
  if (!box) return;
  const tasks = myTasks();
  box.hidden = tasks.length === 0;
  const list = $("myTasksList");
  list.textContent = "";
  tasks.forEach(function (t) {
    const li = mk("li", "my-task");
    const btn = mk("button", "my-task-btn");
    btn.type = "button";
    const main = mk("span", "my-task-main");
    main.appendChild(mk("strong", "", t.s.name));
    const d = stageDue(t.p, t.s);
    main.appendChild(mk("small", "", t.p.name + (d ? " \u00b7 " + dueLabel(d) : "")));
    btn.appendChild(main);
    const tags = mk("span", "tags");
    if (t.ready) tags.appendChild(mk("span", "chip sp-ready", "Ready for you"));
    if (t.fix) tags.appendChild(mk("span", "chip sp-ready", "Changes requested"));
    const chip = mk("span", "status sp-status", t.s.status);
    chip.dataset.status = t.s.status;
    tags.appendChild(chip);
    btn.appendChild(tags);
    btn.onclick = function () { showProject(t.p.id, t.s.id); };
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function showProject(id, stageId) {
  const p = projects.filter(function (x) { return x.id === id; })[0];
  if (!p) return;
  if (window.CadenceChat && window.CadenceChat.openProject) window.CadenceChat.openProject(p, stageId || "");
}

// ---- Messages-style project list (v18) ----
let pjFilter = "";
const TILE_COLORS = ["#4fc3a1", "#8fa8ff", "#f0b44c", "#ff8a80", "#c792ea", "#5cc8e8"];
function tileColor(name) {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TILE_COLORS[h % TILE_COLORS.length];
}
function openProjectChat(p) {
  if (window.CadenceChat && window.CadenceChat.open) window.CadenceChat.open(p, "");
  else showProject(p.id);
}
function row(p) {
  const li = mk("li", "pj-row");
  const btn = mk("button", "pj-row-btn");
  btn.type = "button";
  const tile = mk("span", "pj-tile", (p.name.trim().charAt(0) || "?").toUpperCase());
  const c = tileColor(p.name);
  tile.style.color = c;
  tile.style.backgroundColor = "color-mix(in srgb, " + c + " 22%, var(--panel))";
  btn.appendChild(tile);

  const main = mk("span", "pj-main");
  const top = mk("span", "pj-top");
  top.appendChild(mk("strong", "pj-name", p.name));
  if (p.course) top.appendChild(mk("span", "pj-chip", p.course));
  main.appendChild(top);
  const total = p.stages.length;
  const mine = myTasks().filter(function (t) { return t.p === p; })[0];
  let preview = total ? doneCount(p) + " of " + total + " stages done" : "No stages yet";
  if (mine) preview = (mine.ready ? "Your turn: " : mine.fix ? "Needs your fix: " : "Your task: ") + mine.s.name;
  const pv = mk("span", "pj-preview", preview);
  if (mine) pv.classList.add("mine");
  main.appendChild(pv);
  const bar = mk("span", "pj-bar-line");
  const fill = mk("span"); fill.style.width = percent(p) + "%";
  bar.appendChild(fill);
  main.appendChild(bar);
  btn.appendChild(main);

  const side = mk("span", "pj-side");
  const dl = p.due ? daysUntil(p.due) : 0;
  const d = !p.due ? "" : dl < 0 ? Math.abs(dl) + "d overdue" : dueLabel(p.due);
  if (d) side.appendChild(mk("span", "pj-when", d));
  const n = window.CadenceChat && window.CadenceChat.unreadFor ? window.CadenceChat.unreadFor(p).threads.size : 0;
  if (n) side.appendChild(mk("span", "pj-badge", n > 99 ? "99+" : String(n)));
  btn.appendChild(side);

  btn.setAttribute("aria-label", p.name + ". " + preview + (d ? ". " + d : "") + (n ? ". " + n + " unread" : ""));
  btn.onclick = function () { openProjectChat(p); };
  li.appendChild(btn);
  return li;
}
function renderDue() {
  const box = $("pjDue");
  if (!box) return;
  const tasks = myTasks().slice(0, 8);
  box.textContent = "";
  box.hidden = tasks.length === 0;
  tasks.forEach(function (t) {
    const b = mk("button", "pj-due-card");
    b.type = "button";
    const dd = stageDue(t.p, t.s);
    b.appendChild(mk("small", "", t.p.name));
    b.appendChild(mk("strong", "", t.s.name));
    b.appendChild(mk("span", "", t.ready ? "Your turn" : t.fix ? "Needs your fix" : (dd ? dueLabel(dd) : t.s.status)));
    b.onclick = function () { showProject(t.p.id, t.s.id); };
    box.appendChild(b);
  });
}
function openForm(id) {
  const d = $(id);
  if (!d) return;
  d.open = !d.open;
  if (d.open) { const f = d.querySelector("input"); if (f) f.focus(); d.scrollIntoView({ block: "nearest" }); }
}
$("sharedSearch").addEventListener("input", function (e) { pjFilter = e.target.value.trim().toLowerCase(); render(); });
$("sharedNewBtn").onclick = function () { $("sharedJoin").open = false; openForm("sharedAdd"); };
$("sharedJoinBtn").onclick = function () { $("sharedAdd").open = false; openForm("sharedJoin"); };

function render() {
  renderTasks();
  window.dispatchEvent(new CustomEvent("cadence:sharedprojects:changed"));
  $("sharedSection").hidden = !me;
  $("sharedAdd").hidden = !me;
  $("sharedSection").classList.toggle("has-projects", projects.length > 0);
  $("sharedOwnerNote").hidden = admin;
  $("sharedJoin").hidden = !me || admin;
  $("sharedJoinBtn").hidden = !me || admin;
  $("sharedNewBtn").hidden = !me;
  const list = $("sharedList");
  list.textContent = "";
  renderDue();
  const shown = projects.filter(function (p) { return !pjFilter || (p.name + " " + (p.course || "")).toLowerCase().indexOf(pjFilter) >= 0; });
  shown.forEach(function (p) { list.appendChild(row(p)); });
  if (window.CadenceChat && window.CadenceChat.inbox) window.CadenceChat.inbox($("chatInbox"), projects);
  const empty = $("sharedEmpty");
  empty.hidden = projects.length > 0 || !me;
  empty.querySelector("p").textContent = admin
    ? "No shared projects yet. Tap New shared project above to start one."
    : "No shared projects yet. Start one with New shared project, or tap Join with a code if you were given one.";
}

TEMPLATES.forEach(function (t, i) { $("sharedTemplate").appendChild(new Option(t.stages.length ? t.name + " (" + t.stages.length + " stages)" : t.name, String(i))); });

const MAX_OWNED = 5;
$("sharedForm").onsubmit = async function (e) {
  e.preventDefault();
  if (!me) return;
  const name = $("sharedName").value.trim();
  if (!name) return;
  if (!admin && projects.filter(function (p) { return p.createdBy === me.uid; }).length >= MAX_OWNED) {
    say("You can own up to " + MAX_OWNED + " shared projects. Delete one you no longer need first.");
    return;
  }
  const btn = e.submitter; if (btn) btn.disabled = true;
  const tpl = TEMPLATES[Number($("sharedTemplate").value)] || TEMPLATES[0];
  const stages = tpl.stages.map(function (n) { return { id: newId(), name: n, assignee: "", status: "To do", due: "", links: [] }; });
  // Students start as the owner and first member. Admins create without joining.
  let members = [], names = {};
  if (!admin) {
    let nick = me.displayName || "Owner";
    try {
      const prof = await getDoc(doc(db, "profiles", me.uid));
      if (prof.exists() && prof.data().nickname) nick = String(prof.data().nickname);
    } catch (err) {}
    members = [me.uid]; names[me.uid] = nick.slice(0, 30);
  }
  try {
    const ref = await addDoc(collection(db, "sharedProjects"), {
      name: name.slice(0, 80), course: $("sharedCourse").value.trim().slice(0, 40), due: $("sharedDue").value || "",
      members: members, names: names, stages: stages, createdBy: me.uid, createdAt: serverTimestamp(), updatedAt: Date.now()
    });
    $("sharedForm").reset();
    $("sharedTemplate").value = "0";
    $("sharedAdd").open = false;
    open.add(ref.id);
    await load(true);
  } catch (err) {
    say("Couldn't create the project. Make sure the latest rules are published in Firebase.");
  }
  if (btn) btn.disabled = false;
};

$("joinForm").onsubmit = async function (e) {
  e.preventDefault();
  if (!me) return;
  const code = normCode($("joinCode").value);
  if (code.length !== 8) { say("Codes have 8 letters and numbers, like K7MQ-4XWD."); return; }
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    const inv = await getDoc(doc(db, "invites", code));
    if (!inv.exists() || inv.data().active !== true) { say("That code isn't valid, or it was turned off. Ask for a new one."); }
    else {
      const pid = String(inv.data().pid || "");
      if (projects.some(function (p) { return p.id === pid; })) { say("You're already in that project."); }
      else {
        let nick = me.displayName || "Member";
        try {
          const prof = await getDoc(doc(db, "profiles", me.uid));
          if (prof.exists() && prof.data().nickname) nick = String(prof.data().nickname);
        } catch (err) {}
        const f = { members: arrayUnion(me.uid), joinCode: code };
        f["names." + me.uid] = nick.slice(0, 30);
        await updateDoc(doc(db, "sharedProjects", pid), f);
        $("joinForm").reset();
        $("sharedJoin").open = false;
        open.add(pid);
        await load(true);
        say("You joined " + String(inv.data().name || "the project") + ".");
      }
    }
  } catch (err) {
    say("Couldn't join. Check the code and your connection, and that the updated rules are published in Firebase.");
  }
  if (btn) btn.disabled = false;
};
$("sharedCancel").onclick = function () { $("sharedForm").reset(); $("sharedTemplate").value = "0"; $("sharedAdd").open = false; };

document.addEventListener("visibilitychange", function () { if (!document.hidden) load(false); });

onAuthStateChanged(getAuth(), async function (user) {
  me = user || null;
  admin = false;
  projects = []; lastFetch = 0;
  if (me) {
    try { admin = (await getDoc(doc(db, "admins", me.uid))).exists(); } catch (e) {}
    await load(true);
  } else {
    say("");
    render();
    window.dispatchEvent(new CustomEvent("cadence:sharedprojects", { detail: [] }));
  }
});

// Used by the Home "My tasks" list and the bell inbox
window.CadenceSharedProjects = {
  list: function () { return projects; },
  uid: function () { return me ? me.uid : ""; },
  reload: function () { return load(true); },
  rerender: function () { render(); },
  patch: patch,
  panel: projectPanel,
  addPeople: addPeople,
  show: showProject
};
