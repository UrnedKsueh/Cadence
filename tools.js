(function () {
  "use strict";
  const $id = function (id) { return document.getElementById(id); };
  function get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function set(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // ===== Course picker: tap a chip instead of typing =====
  const LAST = "cadence:lastCourse";
  const inputs = ["deadlineCourse", "projectCourse", "showCourse"].map($id).filter(Boolean);
  const bars = [];

  function shortName(name) {
    const i = name.indexOf(" \u2013 ");
    return i > 0 ? name.slice(0, i) : name;
  }

  function courseList() {
    const list = PRESET_COURSES.slice();
    const extra = new Set();
    deadlines.concat(projects, showcase).forEach(function (it) {
      if (it.course && list.indexOf(it.course) < 0) extra.add(it.course);
    });
    return list.concat(Array.from(extra).sort(function (a, b) { return a.localeCompare(b); }));
  }

  function paint(bar, input) {
    Array.from(bar.children).forEach(function (b) {
      const on = b.dataset.course === input.value.trim();
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function build(bar, input) {
    bar.innerHTML = "";
    courseList().forEach(function (name) {
      const b = mk("button", "level-chip course-chip", shortName(name));
      b.type = "button";
      b.dataset.course = name;
      b.title = name;
      b.onclick = function () {
        const same = input.value.trim() === name;
        input.value = same ? "" : name;
        if (!same) set(LAST, name);
        paint(bar, input);
      };
      bar.appendChild(b);
    });
    paint(bar, input);
  }

  inputs.forEach(function (input) {
    const bar = mk("div", "levelbar course-bar");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Pick a course");
    input.insertAdjacentElement("afterend", bar);
    input.placeholder = "Tap a course or type your own";
    input.addEventListener("input", function () { paint(bar, input); });
    bars.push({ bar: bar, input: input });
  });

  function rebuildAll() { bars.forEach(function (x) { build(x.bar, x.input); }); }

  // Prefill the course: the Home filter if one is chosen, else the last one used
  function prefill() {
    const pick = (typeof courseFilter === "string" && courseFilter) || get(LAST) || "";
    if (!pick) return;
    ["deadlineCourse", "projectCourse"].forEach(function (id) {
      const input = $id(id);
      if (input && input.value === "") input.value = pick;
    });
    bars.forEach(function (x) { paint(x.bar, x.input); });
  }

  const original = window.refreshCourses;
  if (typeof original === "function") {
    window.refreshCourses = function () {
      original.apply(this, arguments);
      rebuildAll();
    };
  }
  rebuildAll();
  prefill();
  // Keep the Home filter and the form in step
  const cf = $id("courseFilter");
  if (cf) cf.addEventListener("change", function () {
    if (cf.value) {
      ["deadlineCourse", "projectCourse"].forEach(function (id) { $id(id).value = cf.value; });
      bars.forEach(function (x) { paint(x.bar, x.input); });
    }
  });

  // ===== Focus timer =====
  (function () {
    const timeEl = $id("focusTime"), phaseEl = $id("focusPhase");
    const startBtn = $id("focusStart"), resetBtn = $id("focusReset");
    const stats = $id("focusStats"), modes = $id("focusModes");
    if (!timeEl) return;
    const DAY = "cadence:focus:" + new Date().toISOString().slice(0, 10);
    let work = 25, brk = 5, phase = "work", left = work * 60, endAt = 0, tick = null;

    function fmt(s) {
      s = Math.max(0, Math.ceil(s));
      return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    }
    function rounds() { return parseInt(get(DAY) || "0", 10) || 0; }
    function draw() {
      timeEl.textContent = fmt(left);
      phaseEl.textContent = phase === "work" ? "Work" : "Break";
      const n = rounds();
      stats.textContent = n === 0 ? "No focus rounds finished today." : n + (n === 1 ? " focus round" : " focus rounds") + " finished today.";
    }
    function beep() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx(), o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; g.gain.value = 0.15;
        o.connect(g); g.connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + 0.4);
      } catch (e) {}
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }
    function stop() { clearInterval(tick); tick = null; startBtn.textContent = "Start"; }
    function loop() {
      left = (endAt - Date.now()) / 1000;
      if (left <= 0) {
        beep();
        if (phase === "work") set(DAY, String(rounds() + 1));
        phase = phase === "work" ? "break" : "work";
        left = (phase === "work" ? work : brk) * 60;
        stop();
      }
      draw();
      document.title = tick ? fmt(left) + " \u00b7 Cadence" : "Cadence";
    }
    startBtn.onclick = function () {
      if (tick) { stop(); document.title = "Cadence"; draw(); return; }
      endAt = Date.now() + left * 1000;
      tick = setInterval(loop, 250);
      startBtn.textContent = "Pause";
    };
    resetBtn.onclick = function () {
      stop(); phase = "work"; left = work * 60; document.title = "Cadence"; draw();
    };
    modes.addEventListener("click", function (e) {
      const b = e.target.closest("button[data-work]");
      if (!b) return;
      Array.from(modes.children).forEach(function (x) { x.classList.toggle("on", x === b); });
      work = parseInt(b.dataset.work, 10); brk = parseInt(b.dataset["break"], 10);
      resetBtn.onclick();
    });
    draw();
  })();

  // ===== Grade calculator =====
  (function () {
    const rowsEl = $id("gradeRows");
    if (!rowsEl) return;
    const KEY = "cadence:grades";
    let rows = [];
    try { rows = JSON.parse(get(KEY)) || []; } catch (e) { rows = []; }
    if (!Array.isArray(rows) || !rows.length) rows = [{ n: "", s: "", w: "" }];
    rows = rows.slice(0, 30);
    const target = $id("gradeTarget");

    function num(v) { const x = parseFloat(v); return isFinite(x) ? x : null; }
    function save() { set(KEY, JSON.stringify(rows)); }

    function calc() {
      let done = 0, got = 0, total = 0;
      rows.forEach(function (r) {
        const w = num(r.w), s = num(r.s);
        if (w === null || w <= 0) return;
        total += w;
        if (s !== null) { done += w; got += w * s / 100; }
      });
      const now = $id("gradeNow"), need = $id("gradeNeed");
      if (done === 0) {
        now.textContent = "Enter at least one score and its weight.";
        need.textContent = "";
        return;
      }
      now.textContent = "Current average: " + (got / done * 100).toFixed(1) + "% (from " + done + "% of the grade marked).";
      const left = Math.max(0, 100 - done), t = num(target.value);
      if (total > 100) { need.textContent = "Weights add up to " + total + "%. Check them."; return; }
      if (t === null) { need.textContent = ""; return; }
      if (left <= 0) {
        need.textContent = "Final grade: " + got.toFixed(1) + "%. " + (got >= t ? "Target reached." : "Target missed by " + (t - got).toFixed(1) + " points.");
        return;
      }
      const req = (t - got) / left * 100;
      if (req <= 0) need.textContent = "Target " + t + "% is already secured.";
      else if (req > 100) need.textContent = "Target " + t + "% is out of reach. The best possible is " + (got + left).toFixed(1) + "%.";
      else need.textContent = "You need " + req.toFixed(1) + "% on the remaining " + left + "% to reach " + t + "%.";
    }

    function field(ph, val, mode, onInput, label) {
      const i = mk("input", "field");
      i.placeholder = ph; i.value = val; i.setAttribute("aria-label", label);
      if (mode) { i.type = "number"; i.inputMode = "decimal"; i.min = "0"; i.step = "any"; }
      else i.maxLength = 60;
      i.oninput = onInput;
      return i;
    }

    function render() {
      rowsEl.innerHTML = "";
      rows.forEach(function (r, idx) {
        const line = mk("div", "grade-row");
        line.appendChild(field("Assessment", r.n, false, function (e) { r.n = e.target.value; save(); }, "Assessment name"));
        line.appendChild(field("Score %", r.s, true, function (e) { r.s = e.target.value; save(); calc(); }, "Score percent"));
        line.appendChild(field("Weight %", r.w, true, function (e) { r.w = e.target.value; save(); calc(); }, "Weight percent"));
        const del = mk("button", "secondary grade-del", "\u2715");
        del.type = "button"; del.setAttribute("aria-label", "Remove assessment");
        del.onclick = function () {
          rows.splice(idx, 1);
          if (!rows.length) rows.push({ n: "", s: "", w: "" });
          save(); render();
        };
        line.appendChild(del);
        rowsEl.appendChild(line);
      });
      calc();
    }
    $id("gradeAdd").onclick = function () {
      if (rows.length >= 30) return;
      rows.push({ n: "", s: "", w: "" }); save(); render();
    };
    $id("gradeClear").onclick = function () { rows = [{ n: "", s: "", w: "" }]; save(); render(); };
    target.oninput = calc;
    render();
  })();

  // ===== Resolution helper =====
  (function () {
    const w = $id("resW"), h = $id("resH"), sc = $id("resScale"), pre = $id("resPreset");
    if (!w) return;
    function gcd(a, b) { return b ? gcd(b, a % b) : a; }
    function run() {
      const W = Math.round(parseFloat(w.value)), H = Math.round(parseFloat(h.value));
      const ratio = $id("resRatio"), mp = $id("resMp"), sd = $id("resScaled");
      if (!(W > 0) || !(H > 0)) { ratio.textContent = "Enter a width and a height."; mp.textContent = ""; sd.textContent = ""; return; }
      const g = gcd(W, H);
      ratio.textContent = "Aspect ratio: " + (W / g) + ":" + (H / g) + " (" + (W / H).toFixed(3) + ")";
      mp.textContent = W + " \u00d7 " + H + " = " + (W * H / 1e6).toFixed(2) + " megapixels per frame.";
      const S = Math.round(parseFloat(sc.value));
      if (S > 0) {
        const nh = Math.round(S * H / W);
        sd.textContent = "At " + S + " px wide: " + S + " \u00d7 " + nh + (nh % 2 ? " (odd height, video encoders prefer even)." : ".");
      } else sd.textContent = "Add a width above to see a scaled size.";
    }
    pre.onchange = function () {
      if (!pre.value) return;
      const p = pre.value.split("x");
      w.value = p[0]; h.value = p[1]; run();
    };
    [w, h, sc].forEach(function (i) {
      i.oninput = function () {
        if (i !== sc) pre.value = Array.from(pre.options).some(function (o) { return o.value === w.value + "x" + h.value; }) ? w.value + "x" + h.value : "";
        run();
      };
    });
    run();
  })();
})();
