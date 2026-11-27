(function () {
  var $ = function (id) { return document.getElementById(id); };
  var top = document.querySelector("header.top");
  var btn = $("searchBtn"), form = $("searchForm"), input = $("globalSearch");
  var panel = $("searchPanel"), label = $("gsQuery"), closeBtn = $("searchClose");
  if (!top || !btn || !form || !input || !panel) return;

  function go(name) {
    var p = $("panel-" + name);
    if (window.showTab) window.showTab(name);
    if (p && p.hidden) { var t = $("tab-" + name); if (t) t.click(); }
  }
  function fill(el, v) {
    if (!el) return;
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function closePanel() { panel.hidden = true; }
  function placePanel() {
    var r = form.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    var w = Math.min(Math.max(r.width, 300), vw - 24);
    var l = Math.min(Math.max(12, r.left), vw - w - 12);
    panel.style.left = l + "px"; panel.style.right = "auto";
    panel.style.width = w + "px"; panel.style.maxWidth = "none";
    panel.style.margin = "0"; panel.style.top = (r.bottom + 8) + "px";
  }
  function closeAll() {
    closePanel();
    top.classList.remove("searching");
    btn.setAttribute("aria-expanded", "false");
  }
  function openField() {
    top.classList.add("searching");
    btn.setAttribute("aria-expanded", "true");
    input.focus();
  }
  function filterPosts(q) {
    var items = document.querySelectorAll(".home-feed-list > *");
    q = q.toLowerCase();
    items.forEach(function (n) {
      n.classList.toggle("feed-hidden", !!q && n.textContent.toLowerCase().indexOf(q) === -1);
    });
  }

  btn.addEventListener("click", function () {
    if (top.classList.contains("searching")) closeAll(); else openField();
  });
  closeBtn.addEventListener("click", function () { fill(input, ""); filterPosts(""); closeAll(); });

  input.addEventListener("input", function () {
    var q = input.value.trim();
    label.textContent = "\u201C" + q + "\u201D";
    panel.hidden = !q;
    if (q) placePanel();
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (input.value.trim()) { panel.hidden = false; placePanel(); }
  });

  panel.addEventListener("click", function (e) {
    var row = e.target.closest("[data-gs]");
    if (!row) return;
    var q = input.value.trim(), kind = row.getAttribute("data-gs");
    closeAll();
    if (kind === "resources") { go("resources"); fill($("resSearch"), q); }
    else if (kind === "projects") { go("projects"); fill($("sharedSearch"), q); }
    else if (kind === "posts") { go("home"); filterPosts(q); var f = document.querySelector(".home-feed"); if (f) f.scrollIntoView({ behavior: "smooth", block: "start" }); }
    else if (kind === "people") {
      if (window.CadenceFriends && window.CadenceFriends.find) window.CadenceFriends.find(q);
    }
  });

  document.addEventListener("click", function (e) {
    if (panel.hidden) return;
    if (!panel.contains(e.target) && !form.contains(e.target) && e.target !== btn) closePanel();
  });
  window.addEventListener("resize", function () { if (!panel.hidden) placePanel(); });
  window.addEventListener("scroll", function () { if (!panel.hidden) placePanel(); }, { passive: true });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && (!panel.hidden || top.classList.contains("searching"))) { closeAll(); }
  });
})();
