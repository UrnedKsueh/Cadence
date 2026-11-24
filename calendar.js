(function () {
  "use strict";
  const host = document.getElementById("calendarBox");
  if (!host) return;

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth();
  let picked = "";

  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function key(y, m, d) { return y + "-" + pad(m + 1) + "-" + pad(d); }
  const todayKey = key(now.getFullYear(), now.getMonth(), now.getDate());

  // Everything with a date: open deadlines and unfinished project due dates
  function eventsByDay() {
    const map = {};
    function add(date, ev) { (map[date] = map[date] || []).push(ev); }
    deadlines.forEach(function (d) {
      if (!d.done) add(d.date, { label: d.name, course: d.course, kind: "Deadline" });
    });
    projects.forEach(function (p) {
      if (p.due && p.stage < STAGES.length - 1) add(p.due, { label: p.name, course: p.course, kind: "Project due" });
    });
    return map;
  }

  function render() {
    const events = eventsByDay();
    host.textContent = "";

    const head = mk("div", "cal-head");
    const prev = mk("button", "secondary cal-nav", "‹");
    prev.type = "button";
    prev.setAttribute("aria-label", "Previous month");
    const next = mk("button", "secondary cal-nav", "›");
    next.type = "button";
    next.setAttribute("aria-label", "Next month");
    const title = mk("strong", "cal-title", MONTHS[month] + " " + year);
    title.setAttribute("aria-live", "polite");
    prev.onclick = function () { month--; if (month < 0) { month = 11; year--; } picked = ""; render(); };
    next.onclick = function () { month++; if (month > 11) { month = 0; year++; } picked = ""; render(); };
    head.appendChild(prev);
    head.appendChild(title);
    head.appendChild(next);
    host.appendChild(head);

    const grid = mk("div", "cal-grid");
    DOW.forEach(function (d) { grid.appendChild(mk("span", "cal-dow", d)); });
    const first = new Date(year, month, 1).getDay();
    const days = new Date(year, month + 1, 0).getDate();
    for (let i = 0; i < first; i++) grid.appendChild(mk("span", "cal-blank"));
    for (let d = 1; d <= days; d++) {
      const k = key(year, month, d);
      const list = events[k] || [];
      const b = mk("button", "cal-day", String(d));
      b.type = "button";
      if (k === todayKey) b.classList.add("today");
      if (k === picked) b.classList.add("picked");
      if (list.length) {
        b.classList.add(k < todayKey ? "late" : "has");
        const dot = mk("i", "cal-dot");
        b.appendChild(dot);
      }
      b.setAttribute("aria-pressed", k === picked ? "true" : "false");
      b.setAttribute("aria-label", MONTHS[month] + " " + d + (list.length ? ", " + list.length + (list.length === 1 ? " item due" : " items due") : ""));
      b.onclick = function () { picked = picked === k ? "" : k; render(); };
      grid.appendChild(b);
    }
    host.appendChild(grid);

    const detail = mk("div", "cal-detail");
    detail.setAttribute("aria-live", "polite");
    if (picked) {
      const list = events[picked] || [];
      if (!list.length) detail.appendChild(mk("p", "hint", "Nothing due on " + picked + "."));
      list.forEach(function (ev) {
        const row = mk("p", "cal-item");
        row.appendChild(mk("strong", "", ev.label));
        row.appendChild(document.createTextNode(" · " + ev.kind + (ev.course ? " · " + ev.course : "")));
        detail.appendChild(row);
      });
    } else {
      detail.appendChild(mk("p", "hint", "Tap a day to see what's due."));
    }
    host.appendChild(detail);
  }

  // Redraw whenever the app redraws (add, edit, delete, import, cloud sync)
  const original = window.renderAll;
  if (typeof original === "function") {
    window.renderAll = function () {
      const r = original.apply(this, arguments);
      render();
      return r;
    };
  }
  render();
})();
