// Shared projects: admins create a project, add members and assign stages; members see their projects
// and update the status of their own stages. Runs after cloud.js.
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, query, where, orderBy, limit, getDocs, addDoc, updateDoc, deleteDoc, serverTimestamp }
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
  const m = $("sharedMsg");
  m.textContent = text || "";
  m.hidden = !text;
}
function nameOf(p, uid) {
  if (me && uid === me.uid) return "You";
  return (p.names && p.names[uid]) || "Member";
}
function canEdit(p, stage) { return admin || (me && stage.assignee === me.uid); }
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
      link: safeLink(s.link)
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

function stageRow(p, stage, i) {
  const li = mk("li", "sp-stage");
  const top = mk("div", "sp-stage-top");
  top.appendChild(mk("strong", "", stage.name));
  if (admin) {
    [["Up", -1, "\u2191"], ["Down", 1, "\u2193"]].forEach(function (d) {
      const j = i + d[1];
      const mv = mk("button", "secondary sp-x sp-move", d[2]);
      mv.type = "button";
      mv.setAttribute("aria-label", "Move " + stage.name + " " + d[0].toLowerCase());
      mv.disabled = j < 0 || j >= p.stages.length;
      mv.onclick = async function () {
        const a = p.stages.slice();
        const t = a[i]; a[i] = a[j]; a[j] = t;
        if (await patch(p, { stages: a })) render();
      };
      top.appendChild(mv);
    });
    const rm = mk("button", "secondary sp-x", "Remove");
    rm.type = "button";
    rm.setAttribute("aria-label", "Remove stage " + stage.name);
    rm.onclick = async function () {
      if (!confirm("Remove the stage \"" + stage.name + "\"?")) return;
      if (await patch(p, { stages: p.stages.filter(function (s) { return s.id !== stage.id; }) })) render();
    };
    top.appendChild(rm);
  }
  li.appendChild(top);

  const row = mk("div", "sp-row");
  if (admin) {
    const who = memberOptions(p, stage.assignee);
    who.setAttribute("aria-label", "Assignee for " + stage.name);
    who.onchange = async function () {
      stage.assignee = who.value;
      if (await patch(p, { stages: p.stages })) render();
    };
    row.appendChild(who);
  } else {
    row.appendChild(mk("span", "chip", stage.assignee ? nameOf(p, stage.assignee) : "Unassigned"));
  }

  if (canEdit(p, stage)) {
    const st = mk("select", "field sp-select");
    st.setAttribute("aria-label", "Status for " + stage.name);
    STATUS.forEach(function (s) { st.appendChild(new Option(s, s)); });
    st.value = stage.status;
    st.onchange = async function () {
      stage.status = st.value;
      if (await patch(p, { stages: p.stages })) render();
    };
    row.appendChild(st);
  } else {
    const chip = mk("span", "status sp-status", stage.status);
    chip.dataset.status = stage.status;
    row.appendChild(chip);
  }

  const ready = me && stage.assignee === me.uid && stage.status === "To do" &&
    (i === 0 || p.stages[i - 1].status === "Done");
  if (ready) row.appendChild(mk("span", "chip sp-ready", "Ready for you"));
  if (me && stage.assignee === me.uid && stage.status === "Needs changes") row.appendChild(mk("span", "chip sp-ready", "Changes requested"));
  li.appendChild(row);

  if (admin) {
    const dueRow = mk("div", "sp-row sp-due-row");
    const dueIn = mk("input", "field sp-select");
    dueIn.type = "date";
    dueIn.value = stage.due;
    dueIn.setAttribute("aria-label", "Due date for " + stage.name);
    dueIn.onchange = async function () {
      stage.due = dueIn.value;
      if (await patch(p, { stages: p.stages })) render();
    };
    dueRow.appendChild(mk("small", "hint", "Due"));
    dueRow.appendChild(dueIn);
    li.appendChild(dueRow);
  }
  if (stage.due) {
    const late = stage.status !== "Done" && daysUntil(stage.due) < 0;
    li.appendChild(mk("span", "chip sp-due" + (late ? " sp-late" : ""), dueLabel(stage.due)));
  }

  if (stage.note) li.appendChild(mk("p", "sp-note", stage.note));
  if (stage.link) {
    const a = mk("a", "sp-link", "Open files link");
    a.href = stage.link; a.target = "_blank"; a.rel = "noopener noreferrer";
    li.appendChild(a);
  }
  if (canEdit(p, stage)) {
    const det = mk("details", "sp-edit");
    det.appendChild(mk("summary", "", stage.note || stage.link ? "Edit note and link" : "Add note or link"));
    const form = mk("form", "sp-edit-form");
    form.autocomplete = "off";
    const note = mk("textarea", "field");
    note.rows = 2; note.maxLength = 300; note.value = stage.note;
    note.placeholder = "Note for the team, e.g. v2 uploaded, check shot 14";
    note.setAttribute("aria-label", "Note for " + stage.name);
    const link = mk("input", "field");
    link.type = "url"; link.maxLength = 300; link.value = stage.link;
    link.placeholder = "Drive or Dropbox link (https://...)";
    link.setAttribute("aria-label", "Files link for " + stage.name);
    const save = mk("button", "", "Save");
    save.type = "submit";
    form.appendChild(note); form.appendChild(link); form.appendChild(save);
    form.onsubmit = async function (e) {
      e.preventDefault();
      const raw = link.value.trim();
      const ok = safeLink(raw);
      if (raw && !ok) { say("Links must start with https://"); return; }
      say("");
      stage.note = note.value.trim().slice(0, 300);
      stage.link = ok;
      if (await patch(p, { stages: p.stages })) render();
    };
    det.appendChild(form);
    li.appendChild(det);
  }
  return li;
}

function memberBar(p) {
  const box = mk("div", "sp-members");
  box.appendChild(mk("h3", "", "Members"));
  const chips = mk("div", "sp-row");
  if (!p.members.length) chips.appendChild(mk("span", "hint", admin ? "No members yet. Add people by their handle." : "No members listed."));
  p.members.forEach(function (uid) {
    const c = mk("span", "chip", nameOf(p, uid));
    if (admin) {
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

  if (admin) {
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
    const stages = p.stages.concat({ id: newId(), name: name.slice(0, 60), assignee: "", status: "To do", due: "" });
    if (await patch(p, { stages: stages })) render();
  };
  return form;
}

function card(p) {
  const li = mk("li", "project shared-project");
  const isOpen = open.has(p.id);
  const top = mk("div", "project-top");
  const pname = mk("span", "pname");
  pname.appendChild(mk("span", "", p.name));
  const tags = mk("span", "tags");
  tags.appendChild(mk("span", "chip", doneCount(p) + "/" + p.stages.length + " done"));
  if (p.course) tags.appendChild(mk("span", "chip", p.course));
  if (p.due) tags.appendChild(mk("span", "chip", "Due " + p.due));
  pname.appendChild(tags);
  top.appendChild(pname);
  top.appendChild(mk("span", "percent", percent(p) + "%"));
  li.appendChild(top);

  const bar = mk("div", "sp-bar");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(percent(p)));
  bar.setAttribute("aria-label", p.name + " progress");
  const fill = mk("span"); fill.style.width = percent(p) + "%";
  bar.appendChild(fill);
  li.appendChild(bar);

  const toggle = mk("button", "secondary sp-toggle", isOpen ? "Hide details" : "Show details");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
  toggle.onclick = function () { if (open.has(p.id)) open.delete(p.id); else open.add(p.id); render(); };
  li.appendChild(toggle);

  if (isOpen) {
    const body = mk("div", "sp-body");
    const stages = mk("ul", "sp-stages");
    if (!p.stages.length) stages.appendChild(mk("li", "hint", "No stages yet."));
    p.stages.forEach(function (s, i) { stages.appendChild(stageRow(p, s, i)); });
    body.appendChild(stages);
    if (admin) body.appendChild(stageAdder(p));
    body.appendChild(memberBar(p));
    if (admin) {
      const del = mk("button", "secondary sp-delete", "Delete project");
      del.type = "button";
      del.onclick = async function () {
        if (!confirm("Delete \"" + p.name + "\" for everyone? This can't be undone.")) return;
        try {
          await deleteDoc(doc(db, "sharedProjects", p.id));
          open.delete(p.id);
          await load(true);
        } catch (e) { say("Couldn't delete. Check your connection and try again."); }
      };
      body.appendChild(del);
    }
    li.appendChild(body);
  }
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
    btn.onclick = function () { showProject(t.p.id); };
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function showProject(id) {
  open.add(id);
  if (window.showTab) window.showTab("projects");
  render();
  const cards = $("sharedList").children;
  for (let i = 0; i < projects.length; i++) {
    if (projects[i].id === id && cards[i]) { cards[i].scrollIntoView({ block: "start" }); break; }
  }
}

function render() {
  renderTasks();
  window.dispatchEvent(new CustomEvent("cadence:sharedprojects:changed"));
  $("sharedSection").hidden = !me;
  $("sharedAdd").hidden = !admin;
  const list = $("sharedList");
  list.textContent = "";
  projects.forEach(function (p) { list.appendChild(card(p)); });
  const empty = $("sharedEmpty");
  empty.hidden = projects.length > 0 || !me;
  empty.querySelector("p").textContent = admin
    ? "No shared projects yet. Tap New shared project above to start one."
    : "Nothing here yet. Projects you're added to will appear here.";
}

TEMPLATES.forEach(function (t, i) { $("sharedTemplate").appendChild(new Option(t.stages.length ? t.name + " (" + t.stages.length + " stages)" : t.name, String(i))); });

$("sharedForm").onsubmit = async function (e) {
  e.preventDefault();
  if (!admin) return;
  const name = $("sharedName").value.trim();
  if (!name) return;
  const btn = e.submitter; if (btn) btn.disabled = true;
  const tpl = TEMPLATES[Number($("sharedTemplate").value)] || TEMPLATES[0];
  const stages = tpl.stages.map(function (n) { return { id: newId(), name: n, assignee: "", status: "To do", due: "" }; });
  try {
    const ref = await addDoc(collection(db, "sharedProjects"), {
      name: name.slice(0, 80), course: $("sharedCourse").value.trim().slice(0, 40), due: $("sharedDue").value || "",
      members: [], names: {}, stages: stages, createdBy: me.uid, createdAt: serverTimestamp(), updatedAt: Date.now()
    });
    $("sharedForm").reset();
    $("sharedTemplate").value = "0";
    $("sharedAdd").open = false;
    open.add(ref.id);
    await load(true);
  } catch (err) {
    say("Couldn't create the project. Make sure the shared project rules are published and your account is in the admins collection.");
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
  show: showProject
};
