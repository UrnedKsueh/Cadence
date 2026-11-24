// Shared projects: admins create a project, add members and assign stages; members see their projects
// and update the status of their own stages. Runs after cloud.js.
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
      if (await patch(p, { stages: p.stages })) {
        if (window.CadenceChat) window.CadenceChat.log(p, stage.id, ((p.names && p.names[me.uid]) || me.displayName || "Someone") + " set " + stage.name + " to " + stage.status);
        render();
      }
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
  if (window.CadenceChat) row.appendChild(window.CadenceChat.stageButton(p, stage));
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
  if (stage.links.length) {
    const box = mk("div", "sp-links");
    stage.links.forEach(function (l, k) {
      const a = mk("a", "sp-link", l.label || (stage.links.length > 1 ? "Link " + (k + 1) : "Open files link"));
      a.href = l.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      box.appendChild(a);
    });
    li.appendChild(box);
  }
  if (canEdit(p, stage)) {
    const det = mk("details", "sp-edit");
    det.appendChild(mk("summary", "", stage.note || stage.links.length ? "Edit note and links" : "Add note or links"));
    const form = mk("form", "sp-edit-form");
    form.autocomplete = "off";
    const note = mk("textarea", "field");
    note.rows = 2; note.maxLength = 300; note.value = stage.note;
    note.placeholder = "Note for the team, e.g. v2 uploaded, check shot 14";
    note.setAttribute("aria-label", "Note for " + stage.name);
    form.appendChild(note);
    form.appendChild(mk("small", "hint", "Links to Drive or Dropbox files. Name each one, e.g. v1, v2, final."));
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

  if (window.CadenceChat) li.appendChild(window.CadenceChat.button(p));
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
    if (admin) body.appendChild(inviteBox(p));
    if (admin) {
      const del = mk("button", "secondary sp-delete", "Delete project");
      del.type = "button";
      del.onclick = async function () {
        if (!confirm("Delete \"" + p.name + "\" for everyone? This can't be undone.")) return;
        try {
          if (p.inviteCode) { try { await deleteDoc(doc(db, "invites", p.inviteCode)); } catch (e) {} }
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
  $("sharedJoin").hidden = !me || admin;
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
  const stages = tpl.stages.map(function (n) { return { id: newId(), name: n, assignee: "", status: "To do", due: "", links: [] }; });
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
  show: showProject
};
