(function () {
  "use strict";
  const tabs = Array.from(document.querySelectorAll(".tab"));
  // Tools and Profile have no nav button: they open from the icons in the header.
  const names = tabs.map(function (t) { return t.dataset.tab; }).concat("tools", "profile");
  const toolsBtn = document.getElementById("toolsBtn");
  const KEY = "cadence:lastTab";

  function show(name, focusTab) {
    // Showcase now lives inside Profile; old links and saved tabs land there
    if (name === "community") name = "resources";
    let jumpTo = "";
    if (name === "showcase") { name = "profile"; jumpTo = "showcaseSection"; }
    if (names.indexOf(name) < 0) name = names[0];
    names.forEach(function (n) {
      document.getElementById("panel-" + n).hidden = n !== name;
    });
    tabs.forEach(function (t) {
      const on = t.dataset.tab === name;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      if (on && focusTab) t.focus();
    });
    // When Tools or Profile is open no tab is selected; keep the first one reachable by keyboard.
    if ((name === "profile" || name === "tools") && tabs.length) tabs[0].tabIndex = 0;
    toolsBtn.classList.toggle("on", name === "tools");
    toolsBtn.setAttribute("aria-pressed", name === "tools" ? "true" : "false");
    try { localStorage.setItem(KEY, name); } catch (e) {}
    if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
    const target = jumpTo && document.getElementById(jumpTo);
    if (target) target.scrollIntoView({ block: "start" }); else window.scrollTo(0, 0);
  }

  window.showTab = function (name) { show(name, false); };

  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { show(t.dataset.tab, false); });
    t.addEventListener("keydown", function (e) {
      let next = -1;
      if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next < 0) return;
      e.preventDefault();
      show(tabs[next].dataset.tab, true);
    });
  });

  // Tools hub: open a tool from its card, go back to the list
  const hub = document.getElementById("toolsHub");
  const views = Array.from(document.querySelectorAll(".tool-view"));
  function openTool(name) {
    const view = name ? document.getElementById("tool-" + name) : null;
    hub.hidden = !!view;
    views.forEach(function (v) { v.hidden = v !== view; });
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("[data-tool]").forEach(function (b) {
    b.addEventListener("click", function () { openTool(b.dataset.tool); });
  });
  document.querySelectorAll("[data-tool-back]").forEach(function (b) {
    b.addEventListener("click", function () { openTool(null); });
  });
  toolsBtn.addEventListener("click", function () { show("tools", false); openTool(null); });


  document.getElementById("avatarBtn").addEventListener("click", function () { show("profile", false); });
  window.addEventListener("hashchange", function () { show(location.hash.slice(1), false); });

  let start = location.hash.slice(1);
  if (start === "calc") start = "tools";
  if (names.indexOf(start) < 0 && start !== "showcase") { // "showcase" is an alias for Profile
    try { start = localStorage.getItem(KEY) || ""; } catch (e) { start = ""; }
  }
  show(start, false);
})();
