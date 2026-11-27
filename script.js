"use strict";

// ===== Storage =====
const KEYS = { deadlines: "deadlines", projects: "projects", showcase: "showcase" };

// All saving goes through storage.js
const load = Storage.load;
const store = Storage.store;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Clean up data from older versions or imports so the rest of the code can trust it
function cleanDeadline(d) {
  if (!d || typeof d.name !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return null;
  return {
    id: typeof d.id === "string" ? d.id : uid(),
    name: d.name.trim().slice(0, 120),
    date: d.date,
    course: typeof d.course === "string" ? d.course.trim().slice(0, 60) : "",
    done: d.done === true
  };
}

// Pipeline stages follow the usual animation workflow (pre-production -> production -> post)
const STAGES = ["Script", "Storyboard", "Animatic", "Layout", "Animation",
  "Lighting & render", "Compositing", "Sound & edit", "Delivered"];
const SHOT_STATUS = ["To do", "Blocking", "Spline", "Polish", "Review", "Render", "Done"];
// Older saves used a single "Animating" status: treat it as Blocking
const SHOT_STATUS_COLORS = { "To do": "#6b7683", "Blocking": "#e0a64f", "Spline": "#d9824f", "Polish": "#b86fd0",
  "Review": "#5f9fe0", "Render": "#4fc3d9", "Done": "#4fc3a1" };
// These match the limits in the Firestore rules. Past them, cloud sync would be rejected.
const LIMITS = { deadlines: 200, projects: 10, showcase: 20 };
const FPS_CHOICES = [12, 23.976, 24, 25, 29.97, 30, 60];
const PRINCIPLES = ["Squash & stretch", "Anticipation", "Staging", "Straight ahead & pose to pose",
  "Follow through & overlapping action", "Slow in & slow out", "Arcs", "Secondary action",
  "Timing", "Exaggeration", "Solid drawing", "Appeal"];

function cleanShot(s) {
  if (!s || typeof s.name !== "string" || s.name.trim() === "") return null;
  const num = function (v, lo, hi) { return Math.min(hi, Math.max(lo, Math.round(Number(v) || 0))); };
  const log = Array.isArray(s.log) ? s.log.filter(function (x) {
    return x && typeof x.text === "string" && x.text.trim() !== "";
  }).map(function (x) { return { v: num(x.v, 1, 999), text: x.text.trim().slice(0, 200) }; }).slice(0, 50) : [];
  const checks = Array.isArray(s.checks) ? s.checks.filter(function (n, k, arr) {
    return Number.isInteger(n) && n >= 0 && n < PRINCIPLES.length && arr.indexOf(n) === k;
  }) : [];
  return {
    id: typeof s.id === "string" ? s.id : uid(),
    name: s.name.trim().slice(0, 80),
    status: SHOT_STATUS.indexOf(s.status === "Animating" ? "Blocking" : s.status) >= 0
      ? (s.status === "Animating" ? "Blocking" : s.status) : "To do",
    frames: num(s.frames, 0, 100000),
    version: num(s.version, 1, 999),
    minutes: num(s.minutes, 0, 99999),
    log: log,
    checks: checks
  };
}

const CHECKLIST_TEMPLATE = ["Script", "Character & prop designs", "Research & references",
  "Storyboard", "Animatic", "Sound & voice plan"];

function cleanItem(c) {
  if (!c || typeof c.label !== "string" || c.label.trim() === "") return null;
  return { id: typeof c.id === "string" ? c.id : uid(), label: c.label.trim().slice(0, 80), done: c.done === true };
}

// Private notes: notes, tasks, pins and annotations that live inside a private project
function cleanNote(n) {
  if (!n || typeof n.text !== "string" || n.text.trim() === "") return null;
  return {
    id: typeof n.id === "string" ? n.id : uid(),
    text: n.text.trim().slice(0, 500),
    t: Number(n.t) || Date.now(),
    kind: n.kind === "todo" ? "todo" : "note",
    done: n.done === true,
    pin: n.pin === true,
    ann: Array.isArray(n.ann) ? n.ann.filter(function (a) { return a && typeof a.text === "string" && a.text.trim() !== ""; }).map(function (a) {
      return { id: typeof a.id === "string" ? a.id : uid(), text: a.text.trim().slice(0, 300), t: Number(a.t) || Date.now() };
    }).slice(0, 20) : []
  };
}

function starterChecklist() {
  return CHECKLIST_TEMPLATE.map(function (label) { return cleanItem({ label: label }); });
}

function cleanProject(p) {
  if (!p || typeof p.name !== "string") return null;
  const last = STAGES.length - 1;
  // Older saves only had a 0-100 progress number: map it onto a stage
  const oldProgress = Math.min(100, Math.max(0, Number(p.progress) || 0));
  const stage = Number.isInteger(p.stage)
    ? Math.min(last, Math.max(0, p.stage))
    : Math.round(oldProgress / 100 * last);
  return {
    id: typeof p.id === "string" ? p.id : uid(),
    name: p.name.trim().slice(0, 120),
    course: typeof p.course === "string" ? p.course.trim().slice(0, 60) : "",
    due: /^\d{4}-\d{2}-\d{2}$/.test(p.due) ? p.due : "",
    stage: stage,
    progress: Math.round(stage / last * 100),
    fps: FPS_CHOICES.indexOf(Number(p.fps)) >= 0 ? Number(p.fps) : 24,
    target: Math.min(36000, Math.max(0, Number(p.target) || 0)),
    shots: Array.isArray(p.shots) ? p.shots.map(cleanShot).filter(Boolean).slice(0, 200) : [],
    checklist: Array.isArray(p.checklist) ? p.checklist.map(cleanItem).filter(Boolean).slice(0, 50) : [],
    notes: Array.isArray(p.notes) ? p.notes.map(cleanNote).filter(Boolean).slice(-80) : []
  };
}

let deadlines = load(KEYS.deadlines).map(cleanDeadline).filter(Boolean);
let projects = load(KEYS.projects).map(cleanProject).filter(Boolean);
let showcase = load(KEYS.showcase).map(cleanShow).filter(Boolean);
let courseFilter = "";

// ===== Shared helpers =====
const $ = function (id) { return document.getElementById(id); };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function plural(n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
}

function matchesFilter(item) {
  return courseFilter === "" || item.course === courseFilter;
}

// Built-in course suggestions (always offered in the Course fields)
const PRESET_COURSES = [
  "EMC 100 \u2013 Freehand and Digital Drawing",
  "EMC 204 \u2013 Principles of 2D Animation",
  "EMC 207 \u2013 Principles of 3D Animation",
  "EMC 301 \u2013 Design and Production Process"
];

function refreshCourses() {
  const names = new Set();
  deadlines.concat(projects, showcase).forEach(function (item) {
    if (item.course) names.add(item.course);
  });
  const sorted = Array.from(names).sort(function (a, b) { return a.localeCompare(b); });

  const datalist = $("courses");
  datalist.innerHTML = "";
  // Suggestions = presets first, then any other course you have typed before
  PRESET_COURSES.forEach(function (name) {
    const option = document.createElement("option");
    option.value = name;
    datalist.appendChild(option);
  });
  const filter = $("courseFilter");
  filter.innerHTML = "";
  filter.appendChild(new Option("All courses", ""));

  sorted.forEach(function (name) {
    if (PRESET_COURSES.indexOf(name) === -1) {
      const option = document.createElement("option");
      option.value = name;
      datalist.appendChild(option);
    }
    filter.appendChild(new Option(name, name));
  });

  // If the filtered course no longer exists, fall back to everything
  if (courseFilter !== "" && !names.has(courseFilter)) courseFilter = "";
  filter.value = courseFilter;
}

// ===== Inline editing =====
let editingId = null;

// Builds a small form for editing one item. fields: [{key, label, type, list, required}]
function editRow(item, className, fields, onSave) {
  const form = el("form", className + " edit-form");
  form.autocomplete = "off";
  const inputs = {};

  fields.forEach(function (f) {
    const label = el("label", "", f.label);
    let input;
    if (f.options) {
      input = document.createElement("select");
      f.options.forEach(function (o) { input.appendChild(new Option(o[1], o[0])); });
      input.value = String(item[f.key] || "");
    } else {
      input = document.createElement("input");
      input.type = f.type || "text";
      input.value = item[f.key] || "";
      if (f.list) input.setAttribute("list", f.list);
    }
    input.className = "field";
    if (f.required) input.required = true;
    label.appendChild(input);
    form.appendChild(label);
    inputs[f.key] = input;
  });

  const row = el("div", "row");
  const save = el("button", "", "Save");
  save.type = "submit";
  const cancel = el("button", "secondary", "Cancel");
  cancel.type = "button";
  cancel.onclick = function () { editingId = null; renderAll(); };
  row.appendChild(save);
  row.appendChild(cancel);
  form.appendChild(row);

  form.onsubmit = function (event) {
    event.preventDefault();
    const values = {};
    fields.forEach(function (f) { values[f.key] = inputs[f.key].value; });
    onSave(values);
    editingId = null;
    renderAll();
  };

  setTimeout(function () { inputs[fields[0].key].focus(); }, 0);
  return form;
}

function editButton(label, id) {
  const btn = el("button", "remove", "✎");
  btn.type = "button";
  btn.setAttribute("aria-label", "Edit \"" + label + "\"");
  btn.onclick = function () { editingId = id; renderAll(); };
  return btn;
}

// ===== Deadlines =====
function daysLeft(dateText) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dateText + "T00:00:00");
  return Math.round((due - today) / 86400000);
}

function describe(left) {
  if (left < 0) return "Overdue by " + plural(Math.abs(left), "day");
  if (left === 0) return "Due today";
  if (left === 1) return "Due tomorrow";
  return "Due in " + left + " days";
}

function renderDeadlines() {
  const list = $("deadlineList");
  list.innerHTML = "";

  // Open items first (soonest on top), finished items sink to the bottom
  const visible = deadlines.filter(matchesFilter).sort(function (a, b) {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return a.date.localeCompare(b.date);
  });

  $("deadlineEmpty").hidden = visible.length > 0;

  visible.forEach(function (d) {
    if (d.id === editingId) {
      const li = el("li", "deadline editing");
      li.appendChild(editRow(d, "deadline-edit", [
        { key: "name", label: "What's due?", required: true },
        { key: "course", label: "Course", list: "courses" },
        { key: "date", label: "Due date", type: "date", required: true }
      ], function (v) {
        const fixed = cleanDeadline({ id: d.id, name: v.name, date: v.date, course: v.course, done: d.done });
        if (fixed && fixed.name) {
          d.name = fixed.name; d.date = fixed.date; d.course = fixed.course;
          store(KEYS.deadlines, deadlines);
        }
      }));
      list.appendChild(li);
      return;
    }

    const left = daysLeft(d.date);

    const li = el("li", "deadline");
    if (d.done) li.classList.add("done");
    else if (left < 0) li.classList.add("late");
    else if (left <= 2) li.classList.add("soon");

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = d.done;
    check.setAttribute("aria-label", "Mark \"" + d.name + "\" as done");
    check.onchange = function () {
      d.done = check.checked;
      store(KEYS.deadlines, deadlines);
      renderAll();
    };

    const info = el("div", "info");
    info.appendChild(el("span", "name", d.name));
    info.appendChild(el("small", "", describe(left)));
    if (d.course) info.appendChild(el("span", "chip", d.course));

    const remove = el("button", "remove", "✕");
    remove.type = "button";
    remove.setAttribute("aria-label", "Delete \"" + d.name + "\"");
    remove.onclick = function () {
      deadlines = deadlines.filter(function (x) { return x.id !== d.id; });
      store(KEYS.deadlines, deadlines);
      renderAll();
    };

    const when = new Date(d.date + "T00:00:00");
    const tile = el("div", "date-tile");
    tile.appendChild(el("b", "", String(when.getDate())));
    tile.appendChild(el("small", "", when.toLocaleDateString(undefined, { month: "short" })));

    const status = el("span", "status", d.done ? "Done" : left < 0 ? "Overdue" : left <= 2 ? "Soon" : "On track");
    status.classList.add(d.done ? "ok" : left < 0 ? "bad" : left <= 2 ? "warn" : "ok");
    info.appendChild(status);

    li.appendChild(check);
    li.appendChild(tile);
    li.appendChild(info);
    li.appendChild(editButton(d.name, d.id));
    li.appendChild(remove);
    list.appendChild(li);
  });
}

$("deadlineForm").onsubmit = function (event) {
  event.preventDefault();
  const name = $("deadlineName").value.trim();
  const date = $("deadlineDate").value;
  if (name === "" || date === "") return;
  if (deadlines.length >= LIMITS.deadlines) { alert("You have " + LIMITS.deadlines + " deadlines. Delete finished ones before adding more."); return; }

  deadlines.push(cleanDeadline({
    name: name,
    date: date,
    course: $("deadlineCourse").value,
    done: false
  }));
  store(KEYS.deadlines, deadlines);

  $("deadlineName").value = "";
  $("deadlineDate").value = "";
  // keep the course filled in, since you often add several deadlines per class
  renderAll();
  $("deadlineName").focus();
};

// ===== Projects =====
function renderProjects() {
  const list = $("projectList");
  list.innerHTML = "";

  // Unfinished first, soonest due date first; delivered projects sink to the bottom
  const lastStage = STAGES.length - 1;
  const q = ($("sharedSearch") ? $("sharedSearch").value : "").trim().toLowerCase();
  const visible = projects.filter(matchesFilter).filter(function (p) {
    return !q || (p.name + " " + (p.course || "")).toLowerCase().indexOf(q) >= 0;
  }).sort(function (a, b) {
    const fa = a.stage >= lastStage, fb = b.stage >= lastStage;
    if (fa !== fb) return fa ? 1 : -1;
    const da = a.due || "9999", db = b.due || "9999";
    return da < db ? -1 : da > db ? 1 : 0;
  });
  const sub = $("projectSub");
  if (sub) sub.hidden = visible.length === 0;
  window.CadencePrivateCount = projects.length;
  window.dispatchEvent(new CustomEvent("cadence:privateprojects:changed"));

  visible.forEach(function (p) {
    if (p.id === editingId) {
      const li = el("li", "project editing");
      li.appendChild(editRow(p, "project-edit", [
        { key: "name", label: "Project name", required: true },
        { key: "course", label: "Course", list: "courses" },
        { key: "due", label: "Due date (optional)", type: "date" }
      ], function (v) {
        const fixed = cleanProject({ id: p.id, name: v.name, course: v.course, due: v.due, stage: p.stage, fps: p.fps, target: p.target, shots: p.shots, checklist: p.checklist });
        if (fixed && fixed.name) {
          p.name = fixed.name; p.course = fixed.course; p.due = fixed.due;
          store(KEYS.projects, projects);
        }
      }));
      list.appendChild(li);
      return;
    }

    const li = el("li", "project");
    const last = STAGES.length - 1;

    const top = el("div", "project-top");
    const percent = el("span", "percent", p.progress + "%");
    const title = el("div", "pname");
    title.appendChild(el("span", "pname-text", p.name));
    const tags = el("div", "tags");
    tags.appendChild(el("span", "status stage-chip", STAGES[p.stage]));
    if (p.course) tags.appendChild(el("span", "chip", p.course));
    title.appendChild(tags);

    const tileColors = ["tint-a", "tint-b", "tint-c"];
    const tile = el("div", "proj-tile " + tileColors[(p.name.length + p.stage) % 3], (p.name.trim().charAt(0) || "P").toUpperCase());

    const menuOpen = openMenus.has(p.id);
    const more = el("button", "remove proj-more", "⋯");
    more.type = "button";
    more.setAttribute("aria-label", "More actions for \"" + p.name + "\"");
    more.setAttribute("aria-expanded", menuOpen ? "true" : "false");
    more.onclick = function () {
      if (openMenus.has(p.id)) openMenus.delete(p.id); else openMenus.add(p.id);
      renderAll();
    };

    top.appendChild(tile);
    top.appendChild(title);
    top.appendChild(percent);
    top.appendChild(more);
    li.appendChild(top);

    if (menuOpen) {
      const acts = el("div", "proj-actions");
      const edit = el("button", "secondary", "Edit details");
      edit.type = "button";
      edit.onclick = function () { openMenus.delete(p.id); editingId = p.id; renderAll(); };
      const del = el("button", "secondary proj-delete", "Delete project");
      del.type = "button";
      del.onclick = function () {
        const n = p.shots.length;
        if (!confirm("Delete \"" + p.name + "\"" + (n ? " and its " + plural(n, "shot") : "") + "? This can't be undone.")) return;
        projects = projects.filter(function (x) { return x.id !== p.id; });
        openMenus.delete(p.id);
        store(KEYS.projects, projects);
        renderAll();
      };
      acts.appendChild(edit); acts.appendChild(del);
      li.appendChild(acts);
    }

    const bar = el("div", "bar");
    const fill = el("div", "fill");
    fill.style.width = p.progress + "%";
    bar.appendChild(fill);

    const setStage = function (n) {
      p.stage = Math.min(last, Math.max(0, n));
      p.progress = Math.round(p.stage / last * 100);
      store(KEYS.projects, projects);
      renderAll();
    };

    // One-tap stepper: the common move is "go to the next stage"
    const stepper = el("div", "proj-stepper");
    const back = el("button", "secondary proj-step-back", "←");
    back.type = "button";
    back.disabled = p.stage === 0;
    back.setAttribute("aria-label", p.stage > 0 ? "Back to " + STAGES[p.stage - 1] : "Already at the first stage");
    back.onclick = function () { setStage(p.stage - 1); };
    const where = el("div", "proj-where");
    where.appendChild(el("strong", "", STAGES[p.stage]));
    where.appendChild(el("small", "", "Stage " + (p.stage + 1) + " of " + STAGES.length));
    const next = el("button", "proj-step-next", p.stage < last ? "Next: " + STAGES[p.stage + 1] : "Delivered ✓");
    next.type = "button";
    next.disabled = p.stage >= last;
    next.onclick = function () { setStage(p.stage + 1); };
    stepper.appendChild(back); stepper.appendChild(where); stepper.appendChild(next);

    const jump = el("details", "proj-jump");
    jump.appendChild(el("summary", "", "Jump to a stage"));
    const stageSelect = document.createElement("select");
    stageSelect.className = "field stage";
    stageSelect.setAttribute("aria-label", "Pipeline stage");
    STAGES.forEach(function (name, i) { stageSelect.appendChild(new Option((i + 1) + ". " + name, i)); });
    stageSelect.value = p.stage;
    stageSelect.onchange = function () { setStage(Number(stageSelect.value)); };
    jump.appendChild(stageSelect);

    if (p.due) {
      const left = daysLeft(p.due);
      const due = el("small", "pdue", describe(left));
      if (p.progress < 100) {
        if (left < 0) due.classList.add("late");
        else if (left <= 2) due.classList.add("soon");
      }
      li.appendChild(due);
    }
    li.appendChild(bar);
    li.appendChild(stepper);
    li.appendChild(jump);
    if (p.stage === STAGES.length - 1) {
      const already = showcase.some(function (s) { return s.title === p.name && s.course === p.course; });
      const toShow = el("button", "secondary", already ? "In Showcase" : "Add to Showcase");
      toShow.type = "button";
      toShow.disabled = already;
      toShow.onclick = function () { addFromProject(p); };
      li.appendChild(toShow);
    }
    // Checklist and shots live behind one toggle so the list stays short
    const ticked = p.checklist.filter(function (x) { return x.done; }).length;
    const shotsDone = p.shots.filter(function (x) { return x.status === "Done"; }).length;
    const isOpen = openProjects.has(p.id);
    const body = el("div", "project-body");
    body.hidden = !isOpen;
    body.appendChild(checklistPanel(p));
    body.appendChild(shotsPanel(p));
    const toggle = el("button", "secondary proj-toggle",
      "Checklist " + ticked + "/" + p.checklist.length + " · Shots " + shotsDone + "/" + p.shots.length);
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    toggle.onclick = function () {
      if (openProjects.has(p.id)) openProjects.delete(p.id); else openProjects.add(p.id);
      renderAll();
    };
    li.appendChild(toggle);
    li.appendChild(body);
    li.dataset.id = p.id;
    list.appendChild(li);
  });
}

const openProjects = new Set();
const openMenus = new Set();
const openShots = new Set();
const openLists = new Set();

const openShotDetail = new Set();

function saveProjects() {
  store(KEYS.projects, projects);
  renderAll();
}

function numberInput(value, min, onChange, label) {
  const input = document.createElement("input");
  input.className = "field";
  input.type = "number";
  input.inputMode = "decimal";
  input.min = min;
  input.step = "any";
  input.value = value || "";
  input.setAttribute("aria-label", label);
  input.onchange = function () { onChange(Number(input.value) || 0); };
  return input;
}

function shotDetail(p, shot) {
  const det = document.createElement("details");
  det.className = "subdet";
  det.open = openShotDetail.has(shot.id);
  det.ontoggle = function () {
    if (det.open) openShotDetail.add(shot.id); else openShotDetail.delete(shot.id);
  };
  det.appendChild(el("summary", "", "Notes (" + shot.log.length + ") and 12 principles (" + shot.checks.length + "/12)"));

  shot.log.forEach(function (entry) {
    const row = el("div", "shot");
    row.appendChild(el("span", "name", "v" + entry.v + ": " + entry.text));
    const del = el("button", "remove", "✕");
    del.type = "button";
    del.setAttribute("aria-label", "Delete note");
    del.onclick = function () {
      shot.log = shot.log.filter(function (x) { return x !== entry; });
      saveProjects();
    };
    row.appendChild(del);
    det.appendChild(row);
  });

  const form = el("form", "shot-add");
  form.autocomplete = "off";
  const input = document.createElement("input");
  input.className = "field";
  input.placeholder = "Critique for v" + shot.version + ", e.g. arc too floaty";
  input.setAttribute("aria-label", "New feedback note");
  input.maxLength = 200;
  const add = el("button", "secondary", "Add note");
  add.type = "submit";
  form.appendChild(input);
  form.appendChild(add);
  form.onsubmit = function (event) {
    event.preventDefault();
    if (input.value.trim() === "") return;
    shot.log.push({ v: shot.version, text: input.value.trim().slice(0, 200) });
    openShotDetail.add(shot.id);
    saveProjects();
  };
  det.appendChild(form);

  det.appendChild(el("p", "hint", "Self-check before you submit this shot:"));
  const grid = el("div", "principles");
  PRINCIPLES.forEach(function (name, i) {
    const label = el("label", "pr");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = shot.checks.indexOf(i) >= 0;
    box.onchange = function () {
      shot.checks = box.checked ? shot.checks.concat(i) : shot.checks.filter(function (n) { return n !== i; });
      openShotDetail.add(shot.id);
      saveProjects();
    };
    label.appendChild(box);
    label.appendChild(document.createTextNode(" " + name));
    grid.appendChild(label);
  });
  det.appendChild(grid);
  return det;
}

function shotsPanel(p) {
  const done = p.shots.filter(function (x) { return x.status === "Done"; }).length;
  const details = document.createElement("details");
  details.className = "shots";
  details.open = openShots.has(p.id);
  details.ontoggle = function () {
    if (details.open) openShots.add(p.id); else openShots.delete(p.id);
  };
  details.appendChild(el("summary", "", "Shots (" + done + "/" + p.shots.length + " done)"));

  // Pipeline overview: one coloured segment per shot status
  if (p.shots.length) {
    const mix = el("div", "status-mix");
    mix.setAttribute("role", "img");
    const parts = [];
    SHOT_STATUS.forEach(function (st) {
      const n = p.shots.filter(function (x) { return x.status === st; }).length;
      if (!n) return;
      parts.push(st + " " + n);
      const seg = el("span", "");
      seg.style.flexGrow = n;
      seg.style.backgroundColor = SHOT_STATUS_COLORS[st];
      seg.title = st + ": " + n;
      mix.appendChild(seg);
    });
    mix.setAttribute("aria-label", "Shot pipeline: " + parts.join(", "));
    details.appendChild(mix);
    details.appendChild(el("p", "hint", parts.join(" · ")));
  }

  // Runtime budget: total frames against the target film length
  const frames = p.shots.reduce(function (n, s) { return n + s.frames; }, 0);
  const secs = frames / p.fps;
  const fpsLabel = el("label", "", "Project frame rate");
  const fpsSel = document.createElement("select");
  fpsSel.className = "field";
  FPS_CHOICES.forEach(function (f) { fpsSel.appendChild(new Option(String(f) + " fps", f)); });
  fpsSel.value = p.fps;
  fpsSel.onchange = function () { p.fps = Number(fpsSel.value); openShots.add(p.id); saveProjects(); };
  fpsLabel.appendChild(fpsSel);
  const targetLabel = el("label", "", "Target film length (seconds)");
  targetLabel.appendChild(numberInput(p.target, 0, function (v) {
    p.target = Math.min(36000, Math.max(0, v)); openShots.add(p.id); saveProjects();
  }, "Target film length in seconds"));
  details.appendChild(fpsLabel);
  details.appendChild(targetLabel);

  const over = p.target > 0 && secs > p.target;
  let text = "Planned: " + secs.toFixed(1) + "s (" + plural(frames, "frame") + ")";
  if (p.target > 0) {
    text += " of " + p.target + "s target, " +
      (over ? (secs - p.target).toFixed(1) + "s over" : (p.target - secs).toFixed(1) + "s left");
  }
  const bar = el("div", "bar");
  const fill = el("div", "fill" + (over ? " over" : ""));
  fill.style.width = (p.target > 0 ? Math.min(100, secs / p.target * 100) : 0) + "%";
  bar.appendChild(fill);
  details.appendChild(bar);
  details.appendChild(el("p", "result", text));
  const spent = p.shots.reduce(function (n, x) { return n + x.minutes; }, 0);
  if (spent) {
    const doneShots = p.shots.filter(function (x) { return x.status === "Done" && x.minutes; });
    let t = "Time logged: " + formatDuration(spent);
    if (doneShots.length) {
      const avg = doneShots.reduce(function (n, x) { return n + x.minutes; }, 0) / doneShots.length;
      t += " (about " + formatDuration(avg) + " per finished shot)";
    }
    details.appendChild(el("p", "hint", t));
  }

  p.shots.forEach(function (shot) {
    const wrap = el("div", "shot-wrap");
    const row = el("div", "shot");
    if (shot.status === "Done") row.classList.add("done");
    row.appendChild(el("span", "name", shot.name));

    const sel = document.createElement("select");
    sel.className = "field status";
    sel.setAttribute("aria-label", "Status of shot \"" + shot.name + "\"");
    SHOT_STATUS.forEach(function (st) { sel.appendChild(new Option(st, st)); });
    sel.value = shot.status;
    sel.onchange = function () { shot.status = sel.value; saveProjects(); };

    const del = el("button", "remove", "✕");
    del.type = "button";
    del.setAttribute("aria-label", "Delete shot \"" + shot.name + "\"");
    del.onclick = function () {
      p.shots = p.shots.filter(function (x) { return x.id !== shot.id; });
      saveProjects();
    };
    row.appendChild(sel);
    row.appendChild(del);

    const meta = el("div", "shot-meta");
    meta.appendChild(numberInput(shot.frames, 0, function (v) {
      shot.frames = Math.min(100000, Math.round(v)); openShots.add(p.id); saveProjects();
    }, "Frames in shot \"" + shot.name + "\""));
    meta.appendChild(el("small", "", "frames = " + (shot.frames / p.fps).toFixed(1) + "s"));
    meta.appendChild(numberInput(shot.version, 1, function (v) {
      shot.version = Math.min(999, Math.max(1, Math.round(v))); openShots.add(p.id); saveProjects();
    }, "Version of shot \"" + shot.name + "\""));
    meta.appendChild(el("small", "", "version"));

    // Time tracking: tap to add time you worked on this shot
    const timeRow = el("div", "shot-time");
    const worked = el("small", "", "Worked: " + (shot.minutes ? formatDuration(shot.minutes) : "none yet"));
    timeRow.appendChild(worked);
    [["+15m", 15], ["+30m", 30], ["+1h", 60]].forEach(function (q) {
      const b = el("button", "secondary chip-btn", q[0]);
      b.type = "button";
      b.setAttribute("aria-label", "Add " + q[0].slice(1) + " to shot \"" + shot.name + "\"");
      b.onclick = function () { shot.minutes = Math.min(99999, shot.minutes + q[1]); openShots.add(p.id); saveProjects(); };
      timeRow.appendChild(b);
    });
    if (shot.minutes) {
      const undo = el("button", "secondary chip-btn", "Reset");
      undo.type = "button";
      undo.setAttribute("aria-label", "Reset time for shot \"" + shot.name + "\"");
      undo.onclick = function () { shot.minutes = 0; openShots.add(p.id); saveProjects(); };
      timeRow.appendChild(undo);
    }
    meta.appendChild(timeRow);

    wrap.appendChild(row);
    wrap.appendChild(meta);
    wrap.appendChild(shotDetail(p, shot));
    details.appendChild(wrap);
  });

  const form = el("form", "shot-add");
  form.autocomplete = "off";
  const input = document.createElement("input");
  input.className = "field";
  input.placeholder = "e.g. SH010 Hero walks in";
  input.setAttribute("aria-label", "New shot name");
  input.maxLength = 80;
  const add = el("button", "secondary", "Add shot");
  add.type = "submit";
  form.appendChild(input);
  form.appendChild(add);
  form.onsubmit = function (event) {
    event.preventDefault();
    const shot = cleanShot({ name: input.value, status: "To do" });
    if (!shot) return;
    if (p.shots.length >= Storage.LIMITS.shotsPerProject) { alert("A project can have up to " + Storage.LIMITS.shotsPerProject + " shots."); return; }
    p.shots.push(shot);
    openShots.add(p.id);
    saveProjects();
  };
  details.appendChild(form);
  return details;
}

function checklistPanel(p) {
  const done = p.checklist.filter(function (x) { return x.done; }).length;
  const details = document.createElement("details");
  details.className = "shots";
  details.open = openLists.has(p.id);
  details.ontoggle = function () {
    if (details.open) openLists.add(p.id); else openLists.delete(p.id);
  };
  details.appendChild(el("summary", "", "Pre-production checklist (" + done + "/" + p.checklist.length + ")"));

  p.checklist.forEach(function (item) {
    const row = el("div", "shot");
    if (item.done) row.classList.add("done");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = item.done;
    check.setAttribute("aria-label", "Mark \"" + item.label + "\" as done");
    check.onchange = function () {
      item.done = check.checked;
      store(KEYS.projects, projects);
      renderAll();
    };
    const del = el("button", "remove", "✕");
    del.type = "button";
    del.setAttribute("aria-label", "Delete \"" + item.label + "\"");
    del.onclick = function () {
      p.checklist = p.checklist.filter(function (x) { return x.id !== item.id; });
      store(KEYS.projects, projects);
      renderAll();
    };
    row.appendChild(check);
    row.appendChild(el("span", "name", item.label));
    row.appendChild(del);
    details.appendChild(row);
  });

  if (p.checklist.length === 0) {
    const starter = el("button", "secondary", "Add starter checklist");
    starter.type = "button";
    starter.onclick = function () {
      p.checklist = starterChecklist();
      openLists.add(p.id);
      store(KEYS.projects, projects);
      renderAll();
    };
    details.appendChild(starter);
  }

  const form = el("form", "shot-add");
  form.autocomplete = "off";
  const input = document.createElement("input");
  input.className = "field";
  input.placeholder = "e.g. Color script";
  input.setAttribute("aria-label", "New checklist item");
  input.maxLength = 80;
  const add = el("button", "secondary", "Add item");
  add.type = "submit";
  form.appendChild(input);
  form.appendChild(add);
  form.onsubmit = function (event) {
    event.preventDefault();
    const item = cleanItem({ label: input.value });
    if (!item) return;
    p.checklist.push(item);
    openLists.add(p.id);
    store(KEYS.projects, projects);
    renderAll();
  };
  details.appendChild(form);
  return details;
}

$("projectForm").onsubmit = function (event) {
  event.preventDefault();
  const name = $("projectName").value.trim();
  if (name === "") return;
  if (projects.length >= LIMITS.projects) { alert("You can keep up to " + LIMITS.projects + " projects. Remove a finished one first."); return; }

  projects.push(cleanProject({
    name: name,
    course: $("projectCourse").value,
    due: $("projectDue").value,
    stage: 0,
    shots: [],
    checklist: starterChecklist()
  }));
  const added = projects[projects.length - 1];
  store(KEYS.projects, projects);

  $("projectForm").reset();
  $("projectCourse").dispatchEvent(new Event("input")); // repaints the course chips
  $("projectAdd").open = false;
  courseFilter = "";
  openProjects.clear(); // only the new project stays expanded
  openProjects.add(added.id);
  renderAll();
  projectMessage("Added “" + added.name + "”. Its checklist is ready to tick off.");
  const li = $("projectList").querySelector('[data-id="' + added.id + '"]');
  if (li) {
    li.classList.add("just-added");
    li.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  window.dispatchEvent(new CustomEvent("cadence:private:added", { detail: added.id }));
};

// The chat workspace reads and writes private notes through this, so there is one copy of the data
window.CadencePrivate = {
  list: function () {
    return projects.map(function (p) { return { id: p.id, name: p.name, course: p.course, due: p.due, count: p.notes.length }; });
  },
  notes: function (id) {
    const p = projects.filter(function (x) { return x.id === id; })[0];
    return p ? p.notes.slice() : null;
  },
  save: function (id, notes) {
    const p = projects.filter(function (x) { return x.id === id; })[0];
    if (!p) return false;
    p.notes = notes.map(cleanNote).filter(Boolean).slice(-80);
    return store(KEYS.projects, projects) !== false;
  }
};

let projectMsgTimer = null;
function projectMessage(text) {
  const m = $("projectMsg");
  m.textContent = text;
  m.hidden = !text;
  clearTimeout(projectMsgTimer);
  if (text) projectMsgTimer = setTimeout(function () { projectMessage(""); }, 6000);
}
$("projectAdd").addEventListener("toggle", function () {
  if ($("projectAdd").open) { projectMessage(""); $("projectName").focus(); }
});
$("projectCancel").onclick = function () {
  $("projectForm").reset();
  $("projectCourse").dispatchEvent(new Event("input"));
  $("projectAdd").open = false;
};

// The + button offers a shared or a private project
(function () {
  const plus = $("sharedNewBtn"), menu = $("pjMenu");
  function closeMenu() { menu.hidden = true; plus.setAttribute("aria-expanded", "false"); }
  function openForm(id) {
    ["sharedAdd", "sharedJoin", "projectAdd"].forEach(function (x) { if (x !== id && $(x)) $(x).open = false; });
    const d = $(id);
    if (!d) return;
    d.open = true;
    const f = d.querySelector("input");
    if (f) f.focus();
    d.scrollIntoView({ block: "nearest" });
  }
  plus.onclick = function (e) {
    e.stopPropagation();
    if ($("sharedAdd").hidden) { openForm("projectAdd"); return; } // signed out: private only
    const show = menu.hidden;
    menu.hidden = !show;
    plus.setAttribute("aria-expanded", String(show));
    if (show) { const first = menu.querySelector("button"); if (first) first.focus(); }
  };
  $("pjMenuShared").onclick = function () { closeMenu(); openForm("sharedAdd"); };
  $("pjMenuPrivate").onclick = function () { closeMenu(); openForm("projectAdd"); };
  document.addEventListener("click", function (e) { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !menu.hidden) { closeMenu(); plus.focus(); } });
  $("sharedSearch").addEventListener("input", renderProjects);
})();


// ===== Notifications =====
// Built from what is already saved: open deadlines and unfinished projects that are
// overdue or due within a week. Read state is remembered per item and per due date.
const NOTIF_KEY = "cadence:notifRead";
let notifRead = (function () {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTIF_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch (error) { return []; }
})();

const GONE_KEY = "cadence:notifGone";
let notifGone = (function () {
  try {
    const raw = JSON.parse(localStorage.getItem(GONE_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch (error) { return []; }
})();
function saveNotifGone() {
  try { localStorage.setItem(GONE_KEY, JSON.stringify(notifGone.slice(-300))); } catch (error) { /* unavailable */ }
}
let notifOpenKey = "";

function saveNotifRead() {
  try { localStorage.setItem(NOTIF_KEY, JSON.stringify(notifRead)); } catch (error) { /* unavailable */ }
}

function buildNotifications() {
  const items = [];
  function bucket(left) { return left < 0 ? "late" : left === 0 ? "today" : "soon"; }
  deadlines.forEach(function (d) {
    if (d.done) return;
    const left = daysLeft(d.date);
    if (left > 7) return;
    items.push({ key: "dl:" + d.id + ":" + d.date + ":" + bucket(left), kind: "deadline", id: d.id,
      title: d.name, left: left, course: d.course, late: left < 0,
      lines: ["Deadline: " + d.name, "Due: " + d.date + " (" + describe(left) + ")"].concat(d.course ? ["Course: " + d.course] : []) });
  });
  projects.forEach(function (p) {
    if (!p.due || p.progress >= 100) return;
    const left = daysLeft(p.due);
    if (left > 7) return;
    items.push({ key: "pj:" + p.id + ":" + p.due + ":" + bucket(left), kind: "project", id: p.id,
      title: p.name, left: left, course: p.course, late: left < 0,
      lines: ["Project: " + p.name, "Due: " + p.due + " (" + describe(left) + ")"].concat(p.course ? ["Course: " + p.course] : []) });
  });
  // Shared projects: stages assigned to me, and announcements from the admin
  const sp = window.CadenceSharedProjects;
  if (sp) {
    const uid = sp.uid();
    sp.list().forEach(function (p) {
      p.stages.forEach(function (s, i) {
        if (s.assignee !== uid || s.status === "Done") return;
        const ready = s.status === "To do" && (i === 0 || p.stages[i - 1].status === "Done");
        const fix = s.status === "Needs changes";
        items.push({ key: (fix ? "sn:" : ready ? "sr:" : "sa:") + p.id + ":" + s.id, kind: "task", id: p.id,
          title: s.name + " \u00b7 " + p.name, left: fix ? -3000 : ready ? -2000 : -1000,
          note: fix ? "Changes requested" : ready ? "Ready for you" : "Assigned to you", late: false,
          lines: [fix ? "Your teacher or lead asked for changes on this stage." : ready ? "The stage before yours is done, so it is your turn." : "This stage was assigned to you.",
            "Stage: " + s.name, "Project: " + p.name].concat(s.due || p.due ? ["Due: " + (s.due || p.due)] : []).concat(s.note ? ["Note: " + s.note] : []) });
        const due = s.due || p.due;
        if (due) {
          const left = daysLeft(due);
          if (left <= 7) items.push({ key: "sd:" + p.id + ":" + s.id + ":" + due + ":" + bucket(left), kind: "task", id: p.id,
            title: s.name + " \u00b7 " + p.name, left: left, note: describe(left), late: left < 0,
            lines: ["Stage: " + s.name, "Project: " + p.name, "Due: " + due + " (" + describe(left) + ")"].concat(s.note ? ["Note: " + s.note] : []) });
        }
      });
    });
  }
  const an = window.CadenceAnnouncements;
  if (an) {
    an.list().slice(0, 5).forEach(function (a) {
      items.push({ key: "an:" + a.id, kind: "announcement", id: a.id, title: a.title,
        left: -500, note: "Announcement", late: false, body: a.body || "",
        when: a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "" });
    });
  }
  return items.filter(function (n) { return notifGone.indexOf(n.key) < 0; })
    .sort(function (a, b) { return a.left - b.left; });
}

function setNotifOpen(open) {
  const panel = $("notifPanel");
  panel.hidden = !open;
  $("bellBtn").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) panel.focus();
}

const NOTIF_ICONS = {
  task: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4 10-10"/></svg>',
  deadline: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 3h6"/></svg>',
  project: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  announcement: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10v4h3l7 4V6l-7 4zM18 9a4 4 0 0 1 0 6"/></svg>'
};

function allKeys() {
  const keep = notifGone; notifGone = [];
  const keys = buildNotifications().map(function (n) { return n.key; });
  notifGone = keep;
  return keys;
}

function renderNotifications() {
  const items = buildNotifications();
  // Forget read marks for items that no longer apply (done, deleted, rescheduled)
  const live = items.map(function (n) { return n.key; });
  const pruned = notifRead.filter(function (k) { return live.indexOf(k) >= 0; });
  if (pruned.length !== notifRead.length) { notifRead = pruned; saveNotifRead(); }

  const prunedGone = notifGone.filter(function (k) { return allKeys().indexOf(k) >= 0; });
  if (prunedGone.length !== notifGone.length) { notifGone = prunedGone; saveNotifGone(); }
  const unread = items.filter(function (n) { return notifRead.indexOf(n.key) < 0; });
  const badge = $("bellCount");
  badge.textContent = unread.length > 9 ? "9+" : String(unread.length);
  badge.hidden = unread.length === 0;
  $("bellBtn").setAttribute("aria-label", unread.length
    ? "Notifications, " + unread.length + " unread" : "Notifications");

  const list = $("notifList");
  list.innerHTML = "";
  $("notifEmpty").hidden = items.length > 0;
  $("notifMarkAll").hidden = unread.length === 0;

  items.forEach(function (n) {
    const isUnread = notifRead.indexOf(n.key) < 0;
    const isOpen = notifOpenKey === n.key;
    const li = el("li", "notif-item" + (isUnread ? " unread" : "") + (n.late ? " late" : "") + (isOpen ? " open" : ""));

    const main = el("button", "notif-main");
    main.type = "button";
    main.setAttribute("aria-expanded", isOpen ? "true" : "false");
    const icon = el("span", "notif-icon notif-" + n.kind);
    icon.innerHTML = NOTIF_ICONS[n.kind] || NOTIF_ICONS.deadline;
    main.appendChild(icon);
    const body = el("span", "notif-body");
    let title = n.title, sub = "";
    if (n.kind === "task") {
      const cut = title.indexOf(" \u00b7 ");
      if (cut > 0) { sub = title.slice(cut + 3); title = title.slice(0, cut); }
      body.appendChild(el("strong", "", title));
      body.appendChild(el("small", "", sub));
      if (n.note) body.appendChild(el("span", "notif-chip" + (n.late ? " late" : ""), n.note));
    } else if (n.kind === "announcement") {
      body.appendChild(el("strong", "", title));
      if (!isOpen && n.body) body.appendChild(el("small", "", n.body));
      else if (!isOpen) body.appendChild(el("small", "", "Announcement" + (n.when ? " \u00b7 " + n.when : "")));
    } else {
      body.appendChild(el("strong", "", title));
      if (n.course) body.appendChild(el("small", "", n.course));
      body.appendChild(el("span", "notif-chip" + (n.late ? " late" : ""), describe(n.left)));
    }
    main.appendChild(body);
    if (isUnread) main.appendChild(el("span", "notif-dot"));
    main.onclick = function () {
      notifOpenKey = isOpen ? "" : n.key;
      if (!isOpen && notifRead.indexOf(n.key) < 0) { notifRead.push(n.key); saveNotifRead(); }
      renderNotifications();
    };
    li.appendChild(main);

    if (isOpen) {
      const more = el("div", "notif-more");
      if (n.kind === "announcement") {
        more.appendChild(el("p", "notif-text", n.body || "No extra message was added."));
        more.appendChild(el("small", "notif-meta", "Announcement" + (n.when ? " \u00b7 " + n.when : "")));
      } else {
        (n.lines || []).forEach(function (t) { more.appendChild(el("p", "notif-line", t)); });
      }
      const row = el("div", "notif-actions");
      function act(label, cls, fn) {
        const b = el("button", "notif-act " + cls, label);
        b.type = "button";
        b.onclick = function (e) { e.stopPropagation(); fn(); };
        row.appendChild(b);
      }
      act("Open", "primary", function () {
        setNotifOpen(false);
        if (n.kind === "project") window.showTab("projects");
        else if (n.kind === "task") {
          window.showTab("projects");
          if (window.CadenceSharedProjects) window.CadenceSharedProjects.show(n.id);
        } else if (n.kind === "announcement") {
          window.showTab("home");
          const box = $("announceBox");
          if (box && !box.hidden) box.scrollIntoView({ block: "start" });
        } else { window.showTab("home"); if (!(window.openDeadlines && window.openDeadlines(false))) $("deadlineList").scrollIntoView({ block: "start" }); }
      });
      act(isUnread ? "Mark as read" : "Mark as unread", "", function () {
        const i = notifRead.indexOf(n.key);
        if (i < 0) notifRead.push(n.key); else notifRead.splice(i, 1);
        saveNotifRead();
        renderNotifications();
      });
      if (n.kind === "deadline") {
        act("Done", "", function () {
          const d = deadlines.find(function (x) { return x.id === n.id; });
          if (!d) return;
          d.done = true;
          store(KEYS.deadlines, deadlines);
          renderAll();
        });
      }
      act("Delete", "danger", function () {
        notifGone.push(n.key); saveNotifGone();
        notifOpenKey = "";
        renderNotifications();
      });
      more.appendChild(row);
      li.appendChild(more);
    }
    list.appendChild(li);
  });
}

$("bellBtn").onclick = function (event) {
  event.stopPropagation();
  setNotifOpen($("notifPanel").hidden);
};
$("notifPanel").onclick = function (event) { event.stopPropagation(); };
$("notifMarkAll").onclick = function () {
  buildNotifications().forEach(function (n) {
    if (notifRead.indexOf(n.key) < 0) notifRead.push(n.key);
  });
  saveNotifRead();
  renderNotifications();
};
document.addEventListener("click", function () { if (!$("notifPanel").hidden) setNotifOpen(false); });
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape" && !$("notifPanel").hidden) { setNotifOpen(false); $("bellBtn").focus(); }
});
document.querySelectorAll(".tab").forEach(function (t) {
  t.addEventListener("click", function () { setNotifOpen(false); });
});

// ===== Overview =====
function renderDashboard() {
  const open = deadlines.filter(function (d) { return !d.done && matchesFilter(d); }).sort(function (a, b) {
    return a.date.localeCompare(b.date);
  });
  const late = open.filter(function (d) { return daysLeft(d.date) < 0; });
  const week = open.filter(function (d) {
    const left = daysLeft(d.date);
    return left >= 0 && left <= 7;
  });
  const active = projects.filter(function (p) { return matchesFilter(p) && p.progress < 100; });
  let shotsOpen = 0;
  active.forEach(function (p) {
    shotsOpen += p.shots.filter(function (x) { return x.status !== "Done"; }).length;
  });

  renderNotifications();
  $("statWeek").textContent = week.length;
  $("statWeekSub").textContent = late.length ? late.length + " overdue" : "Next 7 days";
  $("statProjects").textContent = active.length;
  $("statProjectsSub").textContent = shotsOpen ? plural(shotsOpen, "shot") + " left" : "In progress";
  $("statShow").textContent = showcase.filter(matchesFilter).length;

  const card = $("nextCard");
  const button = $("nextBtn");
  card.classList.remove("late");
  if (open.length === 0) {
    $("nextName").textContent = "Nothing due";
    $("nextWhen").textContent = "You're all caught up.";
    button.textContent = "Add a deadline";
    button.onclick = function () {
      if (!(window.openDeadlines && window.openDeadlines(true))) {
        $("deadlineForm").scrollIntoView({ block: "center" });
        $("deadlineName").focus();
      }
    };
    return;
  }
  const first = open[0];
  const left = daysLeft(first.date);
  if (left < 0) card.classList.add("late");
  $("nextName").textContent = first.name;
  $("nextWhen").textContent = describe(left) + (first.course ? " · " + first.course : "");
  button.textContent = "See all deadlines";
  button.onclick = function () {
    if (!(window.openDeadlines && window.openDeadlines(false))) $("deadlineList").scrollIntoView({ block: "start" });
  };
}

function renderSummary() {
  renderDashboard();
  const open = deadlines.filter(function (d) { return !d.done && matchesFilter(d); });
  const late = open.filter(function (d) { return daysLeft(d.date) < 0; });
  const week = open.filter(function (d) {
    const left = daysLeft(d.date);
    return left >= 0 && left <= 7;
  });
  const active = projects.filter(function (p) { return matchesFilter(p) && p.progress < 100; });
  const projectsLate = active.filter(function (p) { return p.due && daysLeft(p.due) < 0; });

  if (open.length === 0 && active.length === 0) {
    $("summary").textContent = "All clear.";
    return;
  }

  const parts = [plural(open.length, "open deadline")];
  if (late.length) parts.push(late.length + " overdue");
  if (week.length) parts.push(week.length + " due within 7 days");
  parts.push(plural(active.length, "project") + " in progress");
  if (projectsLate.length) parts.push(projectsLate.length + " past its due date");
  let shotsOpen = 0;
  active.forEach(function (p) {
    shotsOpen += p.shots.filter(function (x) { return x.status !== "Done"; }).length;
  });
  if (shotsOpen) parts.push(plural(shotsOpen, "shot") + " left");
  $("summary").textContent = parts.join(", ") + ".";
}

$("courseFilter").onchange = function () {
  courseFilter = $("courseFilter").value;
  renderAll();
};

function renderAll() {
  refreshCourses();
  renderDeadlines();
  renderProjects();
  renderShowcase();
  renderSummary();
}

// Days change while the tab sits open (or the phone sleeps): refresh when you come back
document.addEventListener("visibilitychange", function () {
  if (!document.hidden) renderAll();
});

// ===== Frame calculator =====
const fpsSelect = $("fps");
const secsInput = $("secs");
const framesInput = $("frames");
const minInput = $("minPerFrame");

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatDuration(totalMinutes) {
  const mins = Math.round(totalMinutes);
  if (mins < 60) return plural(mins, "minute");
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 24) return hours + " h " + rest + " min";
  const days = Math.floor(hours / 24);
  return plural(days, "day") + " " + (hours % 24) + " h";
}

function setResult(id, label, value) {
  const node = $(id);
  node.textContent = "";
  if (!value) return;
  node.appendChild(el("small", "", label));
  node.appendChild(el("strong", "", value));
}

function showResults() {
  const fps = Number(fpsSelect.value);
  const frames = Number(framesInput.value);

  if (!frames || frames < 0) {
    setResult("timecode", "", "");
    setResult("twos", "", "");
    setResult("renderTime", "", "");
    setResult("renderPlan", "", "");
    return;
  }

  // Timecode counts whole frames per second (23.976 -> 24, 29.97 -> 30), non-drop-frame
  const nominal = Math.round(fps);
  const totalSeconds = Math.floor(frames / nominal);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  const ff = Math.round(frames) % nominal;
  setResult("timecode", "Timecode", pad(hh) + ":" + pad(mm) + ":" + pad(ss) + ":" + pad(ff));

  setResult("twos", "Drawings", Math.round(frames) + " on ones · " + Math.ceil(frames / 2) + " on twos");

  const perFrame = Number(minInput.value);
  setResult("renderTime", "Render time", perFrame > 0 ? formatDuration(frames * perFrame) : "");

  // Render planner: work back from the due date, with a 20% safety buffer
  const plan = $("renderPlan");
  plan.classList.remove("late");
  const dueDate = $("renderDue").value;
  const hours = Number($("hoursPerDay").value);
  if (!(perFrame > 0) || !dueDate || !(hours > 0)) { setResult("renderPlan", "", ""); return; }
  const daysNeeded = Math.ceil((frames * perFrame / 60) / hours * 1.2);
  const start = addDays(dueDate, -daysNeeded);
  const spare = daysLeft(start);
  setResult("renderPlan", "Render schedule",
    "Needs about " + plural(daysNeeded, "render day") + " (with 20% buffer). Start rendering by " + start +
    (spare < 0 ? " - that's " + plural(-spare, "day") + " ago. Consider fewer frames, lower samples, or a render farm."
      : spare === 0 ? " - that's today." : " (in " + plural(spare, "day") + ")."));
  plan.classList.toggle("late", spare < 0);
}

function addDays(dateText, n) {
  const d = new Date(dateText + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

secsInput.oninput = function () {
  const fps = Number(fpsSelect.value);
  framesInput.value = secsInput.value === "" ? "" : Math.round(Number(secsInput.value) * fps);
  showResults();
};

framesInput.oninput = function () {
  const fps = Number(fpsSelect.value);
  secsInput.value =
    framesInput.value === "" ? "" : Math.round((Number(framesInput.value) / fps) * 100) / 100;
  showResults();
};

minInput.oninput = showResults;
$("renderDue").oninput = showResults;
$("renderDue").onchange = showResults;
$("hoursPerDay").oninput = showResults;

fpsSelect.onchange = function () {
  // Keep whichever value you typed last in sync with the new frame rate
  if (secsInput.value !== "") secsInput.oninput();
  else framesInput.oninput();
};

// Replaces everything on screen and in storage (used by import and cloud sync)
function applyData(d, p, sc) {
  deadlines = d.map(cleanDeadline).filter(Boolean);
  projects = p.map(cleanProject).filter(Boolean);
  showcase = sc.map(cleanShow).filter(Boolean).slice(0, 40);
  store(KEYS.showcase, showcase);
  store(KEYS.deadlines, deadlines);
  store(KEYS.projects, projects);
  renderAll();
}

// ===== Backup =====
function backupMessage(text) {
  $("backupMsg").textContent = text;
}

$("exportBtn").onclick = function () {
  const data = { app: "cadence", version: 3, deadlines: deadlines, projects: projects, showcase: showcase };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "cadence-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  backupMessage("Exported " + plural(deadlines.length, "deadline") + ", " + plural(projects.length, "project") + " and " + plural(showcase.length, "showcase piece") + ".");
};

$("importBtn").onclick = function () {
  $("importFile").click();
};

$("importFile").onchange = function () {
  const file = $("importFile").files[0];
  $("importFile").value = "";
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function () {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (error) {
      backupMessage("That file isn't valid JSON. Import a file exported from this app.");
      return;
    }
    if (!data || !Array.isArray(data.deadlines) || !Array.isArray(data.projects)) {
      backupMessage("That file doesn't look like a Cadence export.");
      return;
    }

    const newDeadlines = data.deadlines.map(cleanDeadline).filter(Boolean);
    const newProjects = data.projects.map(cleanProject).filter(Boolean);
    const newShowcase = Array.isArray(data.showcase) ? data.showcase.map(cleanShow).filter(Boolean).slice(0, 40) : [];
    const ok = confirm(
      "Replace your current data with " + plural(newDeadlines.length, "deadline") +
      ", " + plural(newProjects.length, "project") + " and " + plural(newShowcase.length, "showcase piece") + " from this file?"
    );
    if (!ok) return;

    applyData(newDeadlines, newProjects, newShowcase);
    backupMessage("Imported.");
  };
  reader.onerror = function () {
    backupMessage("Couldn't read that file. Try again.");
  };
  reader.readAsText(file);
};

// ===== Showcase =====
const openPlayers = new Set();
let showTool = "";
let showLevel = 0; // 0 = all year levels

const LEVELS = { 1: "1st year", 2: "2nd year", 3: "3rd year", 4: "4th year" };

// EMC 100 -> 1st year, EMC 204 -> 2nd year, EMC 301 -> 3rd year (first digit of the code)
function levelFromCourse(course) {
  const m = /\b([1-4])\d\d\b/.exec(String(course || ""));
  return m ? Number(m[1]) : 0;
}

function safeUrl(text) {
  try {
    let t = String(text || "").trim();
    // Pasted "youtu.be/abc" or "www.vimeo.com/123" without a scheme still works
    if (t && !/^[a-z][a-z0-9+.-]*:/i.test(t) && /^[^\s\/]+\.[^\s\/]{2,}/.test(t)) t = "https://" + t;
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch (error) {
    return "";
  }
}

// YouTube and Vimeo links can play inside the app; anything else opens in a new tab
function embedUrl(text) {
  try {
    const u = new URL(text);
    const host = u.hostname.replace(/^www\./, "");
    let id = "";
    if (host === "youtu.be") id = u.pathname.slice(1);
    else if (host === "youtube.com" || host === "m.youtube.com") {
      id = u.pathname === "/watch" ? u.searchParams.get("v") : (u.pathname.match(/^\/(?:embed|shorts)\/([\w-]+)/) || [])[1];
    }
    if (id && /^[\w-]{6,}$/.test(id)) return "https://www.youtube-nocookie.com/embed/" + id;
    const vimeo = host === "vimeo.com" && u.pathname.match(/^\/(\d+)/);
    if (vimeo) return "https://player.vimeo.com/video/" + vimeo[1];
  } catch (error) { /* not a link */ }
  return "";
}

function cleanShow(s) {
  if (!s || typeof s.title !== "string" || s.title.trim() === "") return null;
  const raw = Array.isArray(s.tools) ? s.tools : typeof s.tools === "string" ? s.tools.split(",") : [];
  const year = Math.round(Number(s.year));
  const picked = Math.round(Number(s.level));
  const text = function (v, n) { return typeof v === "string" ? v.trim().slice(0, n) : ""; };
  return {
    id: typeof s.id === "string" ? s.id : uid(),
    title: s.title.trim().slice(0, 120),
    course: text(s.course, 60),
    year: year >= 1990 && year <= 2100 ? year : "",
    level: picked >= 1 && picked <= 4 ? picked : levelFromCourse(s.course),
    url: safeUrl(s.url),
    tools: raw.map(function (t) { return String(t).trim().slice(0, 30); }).filter(Boolean).slice(0, 8),
    role: text(s.role, 60),
    note: text(s.note, 400),
    thumb: typeof s.thumb === "string" && s.thumb.length < 60000 &&
      /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(s.thumb) ? s.thumb : ""
  };
}

// Shrinks a picked image to a small JPEG so many thumbnails fit in browser storage
function makeThumb(file, done) {
  const reader = new FileReader();
  reader.onerror = function () { done(""); };
  reader.onload = function () {
    const img = new Image();
    img.onerror = function () { done(""); };
    img.onload = function () {
      const scale = Math.min(1, 320 / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      done(canvas.toDataURL("image/jpeg", 0.7));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function visibleShowcase() {
  return showcase.filter(matchesFilter).filter(function (s) {
    return showTool === "" || s.tools.indexOf(showTool) >= 0;
  }).filter(function (s) {
    return showLevel === 0 || s.level === showLevel;
  });
}

function showCard(s, big) {
  const card = el("div", "show-card" + (big ? " big" : ""));
  if (s.thumb) {
    const img = document.createElement("img");
    img.src = s.thumb;
    img.alt = "Thumbnail for " + s.title;
    card.appendChild(img);
  }
  const head = el("div", "show-head");
  if (!s.thumb) {
    const tileColors = ["tint-a", "tint-b", "tint-c"];
    head.appendChild(el("div", "proj-tile " + tileColors[(s.title.length + (Number(s.year) || 0)) % 3],
      (s.title.trim().charAt(0) || "S").toUpperCase()));
  }
  const titleBox = el("div", "show-title");
  titleBox.appendChild(el("strong", "", s.title));
  if (s.role) titleBox.appendChild(el("small", "", s.role));
  const tags = el("div", "tags");
  if (s.level) tags.appendChild(el("span", "status stage-chip", LEVELS[s.level]));
  if (s.year) tags.appendChild(el("span", "chip", String(s.year)));
  if (s.course) tags.appendChild(el("span", "chip", s.course));
  if (tags.childNodes.length) titleBox.appendChild(tags);
  head.appendChild(titleBox);
  card.appendChild(head);
  if (s.tools.length) {
    const tools = el("div", "tools");
    s.tools.forEach(function (t) { tools.appendChild(el("span", "chip", t)); });
    card.appendChild(tools);
  }
  if (s.note) card.appendChild(el("p", "note", s.note));

  const embed = embedUrl(s.url);
  if (embed && openPlayers.has(s.id)) {
    const frame = document.createElement("iframe");
    frame.className = "player";
    frame.src = embed;
    frame.title = "Video: " + s.title;
    frame.setAttribute("allow", "fullscreen; picture-in-picture");
    frame.allowFullscreen = true;
    card.appendChild(frame);
  }

  const actions = el("div", "row");
  if (embed) {
    const play = el("button", "", openPlayers.has(s.id) ? "Hide video" : "Play here");
    play.type = "button";
    play.onclick = function () {
      if (openPlayers.has(s.id)) openPlayers.delete(s.id); else openPlayers.add(s.id);
      renderAll();
    };
    actions.appendChild(play);
  }
  if (s.url) {
    const link = el("a", "btn secondary", "Open link");
    link.href = s.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    actions.appendChild(link);
  } else if (!big) {
    card.appendChild(el("small", "hint", "No video link yet. Tap ✎ to add one."));
  }
  if (!big) {
    if (window.CadenceFeed && window.CadenceFeed.ready()) {
      const isPosted = window.CadenceFeed.isPosted(s.id);
      const feedBtn = el("button", "secondary", isPosted ? "Remove from feed" : "Post to feed");
      feedBtn.type = "button";
      feedBtn.onclick = function () { if (isPosted) window.CadenceFeed.unpost(s.id); else window.CadenceFeed.post(s); };
      actions.appendChild(feedBtn);
    }
    actions.appendChild(editButton(s.title, s.id));
    const del = el("button", "remove", "✕");
    del.type = "button";
    del.setAttribute("aria-label", "Delete \"" + s.title + "\"");
    del.onclick = function () {
      if (!confirm("Delete \"" + s.title + "\" from your Showcase?")) return;
      showcase = showcase.filter(function (x) { return x.id !== s.id; });
      store(KEYS.showcase, showcase);
      renderAll();
    };
    actions.appendChild(del);
  }
  card.appendChild(actions);
  return card;
}

// Sorts by year level (1st to 4th, unassigned last) and adds a heading before each group
function groupByLevel(items, makeHeading, makeItem) {
  const sorted = items.slice().sort(function (a, b) {
    return (a.level || 9) - (b.level || 9);
  });
  let last = -1;
  sorted.forEach(function (s) {
    if (showLevel === 0 && s.level !== last) {
      const count = sorted.filter(function (x) { return x.level === s.level; }).length;
      makeHeading((s.level ? LEVELS[s.level] : "No year level") + " \u00b7 " + count);
      last = s.level;
    }
    makeItem(s);
  });
}

function renderLevelBar() {
  const bar = $("levelBar");
  bar.innerHTML = "";
  const base = showcase.filter(matchesFilter).filter(function (s) {
    return showTool === "" || s.tools.indexOf(showTool) >= 0;
  });
  [0, 1, 2, 3, 4].forEach(function (n) {
    const count = n === 0 ? base.length : base.filter(function (s) { return s.level === n; }).length;
    // Skip year levels with nothing in them (unless it is the one currently selected)
    if (n !== 0 && count === 0 && showLevel !== n) return;
    const btn = el("button", "level-chip" + (showLevel === n ? " on" : ""),
      (n === 0 ? "All" : LEVELS[n]) + " (" + count + ")");
    btn.type = "button";
    btn.setAttribute("aria-pressed", showLevel === n ? "true" : "false");
    btn.onclick = function () { showLevel = n; renderAll(); };
    bar.appendChild(btn);
  });
}

function renderShowcase() {
  const tools = new Set();
  showcase.forEach(function (s) { s.tools.forEach(function (t) { tools.add(t); }); });
  if (showTool !== "" && !tools.has(showTool)) showTool = "";
  const filter = $("showFilter");
  filter.innerHTML = "";
  filter.appendChild(new Option("All tools", ""));
  Array.from(tools).sort(function (a, b) { return a.localeCompare(b); })
    .forEach(function (t) { filter.appendChild(new Option(t, t)); });
  filter.value = showTool;
  filter.hidden = tools.size === 0;

  // Filters only appear once there is something to filter
  $("showFilters").hidden = showcase.length === 0;
  renderLevelBar();
  renderToolChips();

  const list = $("showList");
  list.innerHTML = "";
  const visible = visibleShowcase();
  $("showEmpty").hidden = visible.length > 0;
  if (visible.length === 0) {
    const filtered = showcase.length > 0;
    $("showEmptyText").textContent = filtered
      ? "No pieces match these filters."
      : "Nothing here yet. Tap Add a piece above, or send a Delivered project here.";
    $("showClear").hidden = !filtered;
  }
  groupByLevel(visible, function (text) {
    list.appendChild(el("li", "show-group", text));
  }, function (s) {
    const li = el("li", "show-item");
    li.dataset.id = s.id;
    if (s.id === editingId) {
      li.classList.add("editing");
      li.appendChild(editRow(s, "show-edit", [
        { key: "title", label: "Title", required: true },
        { key: "url", label: "Video link (YouTube, Vimeo, Drive)" },
        { key: "course", label: "Course", list: "courses" },
        { key: "level", label: "Year level", options: [["", "Auto (from course code)"], ["1", "1st year"], ["2", "2nd year"], ["3", "3rd year"], ["4", "4th year"]] },
        { key: "year", label: "Year made" },
        { key: "tools", label: "Tools (comma separated)" },
        { key: "role", label: "Your role" },
        { key: "note", label: "What you learned / feedback" }
      ], function (v) {
        const fixed = cleanShow({ id: s.id, title: v.title, url: v.url, course: v.course, year: v.year, level: v.level,
          tools: v.tools, role: v.role, note: v.note, thumb: s.thumb });
        if (fixed) {
          Object.keys(fixed).forEach(function (k) { s[k] = fixed[k]; });
          store(KEYS.showcase, showcase);
        }
      }));
    } else {
      li.appendChild(showCard(s, false));
    }
    list.appendChild(li);
  });

  const box = $("present");
  if (!box.hidden) {
    const body = $("presentBody");
    body.innerHTML = "";
    if (visible.length === 0) body.appendChild(el("p", "empty", "Nothing to present yet."));
    groupByLevel(visible, function (text) {
      body.appendChild(el("h3", "show-group", text));
    }, function (s) { body.appendChild(showCard(s, true)); });
  }
}

function addFromProject(p) {
  if (showcase.length >= LIMITS.showcase) { alert("The Showcase is full (" + LIMITS.showcase + " pieces). Remove one first."); return; }
  const entry = cleanShow({ title: p.name, course: p.course, year: new Date().getFullYear() });
  showcase.push(entry);
  store(KEYS.showcase, showcase);
  editingId = entry.id;
  renderAll();
  if (window.showTab) window.showTab("showcase");
  $("showList").scrollIntoView({ block: "center" });
}

// ----- Add form helpers -----
const COMMON_TOOLS = ["Blender", "After Effects", "Maya", "Photoshop", "Procreate", "Toon Boom Harmony", "Premiere Pro"];
let showMsgTimer = null;

function showMessage(text) {
  const m = $("showMsg");
  m.textContent = text;
  m.hidden = !text;
  clearTimeout(showMsgTimer);
  if (text) showMsgTimer = setTimeout(function () { showMessage(""); }, 6000);
}

function toolsInInput() {
  return $("showTools").value.split(",").map(function (t) { return t.trim(); }).filter(Boolean);
}

// Tap-to-add chips for tools: ones already used in the Showcase first, then common ones
function renderToolChips() {
  const bar = $("showToolBar");
  const names = [];
  showcase.forEach(function (s) {
    s.tools.forEach(function (t) {
      if (!names.some(function (n) { return n.toLowerCase() === t.toLowerCase(); })) names.push(t);
    });
  });
  names.sort(function (a, b) { return a.localeCompare(b); });
  COMMON_TOOLS.forEach(function (t) {
    if (!names.some(function (n) { return n.toLowerCase() === t.toLowerCase(); })) names.push(t);
  });
  const current = toolsInInput().map(function (t) { return t.toLowerCase(); });
  bar.innerHTML = "";
  names.forEach(function (name) {
    const on = current.indexOf(name.toLowerCase()) >= 0;
    const b = el("button", "level-chip course-chip" + (on ? " on" : ""), name);
    b.type = "button";
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.onclick = function () {
      const list = toolsInInput();
      const i = list.findIndex(function (t) { return t.toLowerCase() === name.toLowerCase(); });
      if (i >= 0) list.splice(i, 1); else list.push(name);
      $("showTools").value = list.join(", ");
      renderToolChips();
    };
    bar.appendChild(b);
  });
}
$("showTools").addEventListener("input", renderToolChips);

function resetShowForm() {
  $("showForm").reset();
  $("showYear").value = new Date().getFullYear();
  $("showCourse").dispatchEvent(new Event("input")); // repaints the course chips
  clearThumbPreview();
  closeExtras();
  renderToolChips();
  syncPost();
}

// Facebook-style composer: Post stays off until there is a title; Course, Tools and Role open only when tapped
function syncPost() { $("showPost").disabled = !$("showTitle").value.trim(); }
function closeExtras() {
  document.querySelectorAll("#showForm [data-extra]").forEach(function (b) {
    $(b.dataset.extra).hidden = true;
    b.setAttribute("aria-pressed", "false");
  });
}
document.querySelectorAll("#showForm [data-extra]").forEach(function (b) {
  b.onclick = function () {
    const box = $(b.dataset.extra);
    box.hidden = !box.hidden;
    b.setAttribute("aria-pressed", box.hidden ? "false" : "true");
    if (!box.hidden) { const f = box.querySelector("input"); if (f) f.focus(); }
  };
});
$("showTitle").addEventListener("input", syncPost);
$("showThumbClear").onclick = function () { $("showThumb").value = ""; clearThumbPreview(); };

function clearThumbPreview() {
  const img = $("showThumbPreview");
  if (img.src.indexOf("blob:") === 0) URL.revokeObjectURL(img.src);
  img.removeAttribute("src");
  img.hidden = true;
  $("showThumbClear").hidden = true;
}

$("showThumb").onchange = function () {
  clearThumbPreview();
  const file = $("showThumb").files[0];
  if (!file) return;
  const img = $("showThumbPreview");
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  $("showThumbClear").hidden = false;
};

// Opening the form puts the cursor in Title, so you can type straight away
$("showAdd").addEventListener("toggle", function () {
  if ($("showAdd").open) { showMessage(""); $("showTitle").focus(); }
});
$("showCancel").onclick = function () {
  resetShowForm();
  $("showAdd").open = false;
};
$("showUrl").addEventListener("input", function () { $("showUrl").setCustomValidity(""); });
$("showTitle").addEventListener("keydown", function (event) {
  if (event.key === "Enter") { event.preventDefault(); $("showNote").focus(); }
});
$("showClear").onclick = function () {
  showTool = "";
  showLevel = 0;
  courseFilter = "";
  renderAll();
};

$("showForm").onsubmit = function (event) {
  event.preventDefault();
  const urlText = $("showUrl").value.trim();
  if (urlText && !safeUrl(urlText)) {
    $("showUrl").setCustomValidity("That doesn't look like a link. Paste the full address.");
    $("showUrl").reportValidity();
    return;
  }
  const file = $("showThumb").files[0];
  const finish = function (thumb) {
    const entry = cleanShow({
      title: $("showTitle").value, course: $("showCourse").value, year: $("showYear").value, level: $("showLevel").value,
      url: urlText, tools: $("showTools").value, role: $("showRole").value,
      note: $("showNote").value, thumb: thumb
    });
    if (!entry) return;
    if (showcase.length >= LIMITS.showcase) { alert("The Showcase is full (" + LIMITS.showcase + " pieces). Remove one first."); return; }
    showcase.push(entry);
    if (!store(KEYS.showcase, showcase)) {
      showcase.pop();
      alert("Browser storage is full. Export a backup and remove something first.");
      return;
    }
    resetShowForm();
    $("showAdd").open = false;
    // Clear any filter that would hide the new piece, then bring it into view
    showTool = "";
    showLevel = 0;
    courseFilter = "";
    renderAll();
    showMessage("Added “" + entry.title + "” to your Showcase.");
    const li = $("showList").querySelector('[data-id="' + entry.id + '"]');
    if (li) {
      li.classList.add("just-added");
      li.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  };
  if (file) makeThumb(file, finish); else finish("");
};
$("showYear").value = new Date().getFullYear();

$("showFilter").onchange = function () {
  showTool = $("showFilter").value;
  renderAll();
};

function setPresent(on) {
  const box = $("present");
  box.hidden = !on;
  document.body.classList.toggle("locked", on);
  if (on) {
    renderAll();
    if (box.requestFullscreen) box.requestFullscreen().catch(function () { /* optional */ });
  } else if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(function () { /* optional */ });
  }
}

$("presentBtn").onclick = function () { setPresent(true); };
$("presentClose").onclick = function () { setPresent(false); };
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape" && !$("present").hidden) setPresent(false);
});
document.addEventListener("fullscreenchange", function () {
  if (!document.fullscreenElement && !$("present").hidden) setPresent(false);
});

// ===== Start =====
store(KEYS.deadlines, deadlines); // saves migrated data (ids, course field)
store(KEYS.projects, projects);
store(KEYS.showcase, showcase);
renderAll();



// Re-draw the bell when shared projects or announcements load or change
window.addEventListener("cadence:sharedprojects", renderNotifications);
window.addEventListener("cadence:sharedprojects:changed", renderNotifications);
window.addEventListener("cadence:announcements", renderNotifications);
