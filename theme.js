// Theme: follows the phone's setting until the student taps the Theme button.
(function () {
  "use strict";
  const KEY = "cadence:theme";
  const root = document.documentElement;
  const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  function saved() { try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : ""; } catch (e) { return ""; } }
  function effective() { return saved() || (media && media.matches ? "light" : "dark"); }
  function paint() {
    const s = saved();
    if (s) root.setAttribute("data-theme", s); else root.removeAttribute("data-theme");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", effective() === "light" ? "#f5f7fa" : "#0e1319");
    const btn = document.getElementById("themeBtn");
    if (btn) {
      btn.setAttribute("aria-label", effective() === "light" ? "Switch to dark theme" : "Switch to light theme");
      btn.setAttribute("aria-pressed", effective() === "light" ? "true" : "false");
    }
  }
  paint(); // runs in <head> so the right theme shows before the page draws
  document.addEventListener("DOMContentLoaded", function () {
    paint();
    const btn = document.getElementById("themeBtn");
    if (btn) btn.onclick = function () {
      try { localStorage.setItem(KEY, effective() === "light" ? "dark" : "light"); } catch (e) {}
      paint();
    };
  });
  if (media && media.addEventListener) media.addEventListener("change", paint);
})();
