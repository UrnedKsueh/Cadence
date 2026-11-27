(function () {
  "use strict";
  const tabs = Array.from(document.querySelectorAll(".tab"));
  // No bottom nav: Home is the logo, Projects is a header button, and Tools, Resources, Profile and Settings live in the profile menu.
  const names = tabs.map(function (t) { return t.dataset.tab; }).concat("tools", "profile", "menu", "settings");
  const MENU_FAMILY = ["menu", "profile", "tools", "settings", "resources"];
  const projectsBtn = document.getElementById("projectsBtn");
  const avatarBtn = document.getElementById("avatarBtn");
  const KEY = "cadence:lastTab";

  function show(name, focusTab, force) {
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
    projectsBtn.setAttribute("aria-pressed", name === "projects" ? "true" : "false");
    avatarBtn.setAttribute("aria-pressed", MENU_FAMILY.indexOf(name) >= 0 ? "true" : "false");
    try { localStorage.setItem(KEY, name); } catch (e) {}
    if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
    const target = jumpTo && document.getElementById(jumpTo);
    if (target) target.scrollIntoView({ block: "start" }); else window.scrollTo(0, 0);
    // Projects goes straight into the team chat. The list page only shows for New / Join or when there is no project yet.
    if (name === "projects" && !force && window.CadenceSharedProjects && window.CadenceSharedProjects.enter) window.CadenceSharedProjects.enter();
  }

  window.showTab = function (name, force) { show(name, false, force === true); };

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
  // Go to a section. Sections that still have a (hidden) tab get that tab's click so their loaders run.
  function goto(name) {
    const tab = tabs.filter(function (t) { return t.dataset.tab === name; })[0];
    if (tab) tab.click(); else { show(name, false); if (name === "tools") openTool(null); }
  }
  document.querySelectorAll("[data-goto]").forEach(function (b) {
    b.addEventListener("click", function () { goto(b.dataset.goto); });
  });
  projectsBtn.addEventListener("click", function () { goto("projects"); });
  // Facebook-style account dropdown instead of a full Menu page
  const acct = document.getElementById("acctMenu");
  function acctOpen(on) {
    acct.hidden = !on;
    avatarBtn.setAttribute("aria-expanded", on ? "true" : "false");
  }
  avatarBtn.addEventListener("click", function (e) { e.stopPropagation(); acctOpen(acct.hidden); });
  acct.addEventListener("click", function (e) {
    e.stopPropagation();
    if (e.target.closest("[data-goto]")) acctOpen(false);
  });
  document.addEventListener("click", function () { acctOpen(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !acct.hidden) { acctOpen(false); avatarBtn.focus(); } });
  // Display & accessibility flips the same light/dark switch as Settings
  const acctTheme = document.getElementById("acctThemeBtn"), acctPill = document.getElementById("acctThemePill");
  function syncTheme() { const p = document.getElementById("themePill"); if (p) acctPill.textContent = p.textContent; }
  acctTheme.addEventListener("click", function () { const b = document.getElementById("themeBtn"); if (b) b.click(); syncTheme(); });
  syncTheme();
  const tp = document.getElementById("themePill");
  if (tp) new MutationObserver(syncTheme).observe(tp, { childList: true, characterData: true, subtree: true });
  // Sign in / Log out follow the real buttons in Profile
  const acctAuth = document.getElementById("acctAuthBtn"), acctAuthText = document.getElementById("acctAuthText");
  const outBtn = document.getElementById("signOutBtn"), inBtn = document.getElementById("signInBtn");
  function syncAuth() { acctAuthText.textContent = outBtn.hidden ? "Sign in" : "Log out"; }
  acctAuth.addEventListener("click", function () { acctOpen(false); (outBtn.hidden ? inBtn : outBtn).click(); });
  new MutationObserver(syncAuth).observe(outBtn, { attributes: true, attributeFilter: ["hidden"] });
  syncAuth();
  const logo = document.getElementById("homeLogo");
  logo.addEventListener("click", function () { goto("home"); });
  logo.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goto("home"); } });

  // The menu card shows the same picture and name as the header and profile
  (function mirror() {
    const src = document.getElementById("headerAvatar"), dst = document.getElementById("menuAvatar"), dst2 = document.getElementById("acctAvatar");
    const nameSrc = document.getElementById("profileName"), nameDst = document.getElementById("menuName"), nameDst2 = document.getElementById("acctName");
    function sync() {
      dst.innerHTML = src.innerHTML; dst.style.cssText = src.style.cssText; dst.className = "avatar lg " + src.className.replace(/\bavatar\b|\blg\b/g, "");
      dst2.innerHTML = src.innerHTML; dst2.style.cssText = src.style.cssText; dst2.className = "avatar " + src.className.replace(/\bavatar\b|\blg\b/g, "");
      nameDst.textContent = nameSrc.textContent; nameDst2.textContent = nameSrc.textContent;
    }
    const opts = { childList: true, characterData: true, subtree: true, attributes: true };
    new MutationObserver(sync).observe(src, opts);
    new MutationObserver(sync).observe(nameSrc, opts);
    sync();
  })();
  window.addEventListener("hashchange", function () { show(location.hash.slice(1), false); });

  let start = location.hash.slice(1);
  if (start === "calc") start = "tools";
  if (names.indexOf(start) < 0 && start !== "showcase") { // "showcase" is an alias for Profile
    try { start = localStorage.getItem(KEY) || ""; } catch (e) { start = ""; }
  }
  show(start, false);
})();
