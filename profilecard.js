// Profile tab: banner, theme colour, links, Main / Showcase tabs, friends row and featured pieces.
// Banner, theme and links are saved with your profile by social.js; this file only draws them.
(function () {
  "use strict";
  var THEMES = ["", "#5FB8A0", "#7657E8", "#D9A95B", "#E58A85", "#B98FDF", "#62B5D1"];
  var $ = function (id) { return document.getElementById(id); };
  if (!$("pcMain")) return;

  // Banner, theme colour and links come from your profile in Firebase (social.js hands them over)
  var BANNER_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/;
  function normalize(m) {
    m = m || {};
    return {
      banner: typeof m.banner === "string" && m.banner.length <= 95000 && BANNER_RE.test(m.banner) ? m.banner : "",
      theme: THEMES.indexOf(m.theme) > 0 ? m.theme : "",
      links: (Array.isArray(m.links) ? m.links : []).filter(function (x) { return typeof x === "string"; }).slice(0, 3)
    };
  }
  var cur = normalize(null);
  function say(t) { $("pfMsg").textContent = t || ""; }

  // ----- Main / Showcase tabs -----
  function pcTab(name) {
    var showcase = name === "showcase";
    $("pcMain").hidden = showcase;
    $("showcaseWrap").hidden = !showcase;
    [["pcTabMain", !showcase], ["pcTabShow", showcase]].forEach(function (x) {
      $(x[0]).setAttribute("aria-selected", x[1] ? "true" : "false");
    });
    try { sessionStorage.setItem("cadence:pcTab", name); } catch (e) {}
  }
  window.pcTab = pcTab;
  document.querySelectorAll(".pc-tabs [data-pc]").forEach(function (b) {
    b.onclick = function () { pcTab(b.dataset.pc); };
  });
  var startTab = "main";
  try { startTab = sessionStorage.getItem("cadence:pcTab") || "main"; } catch (e) {}
  pcTab(startTab === "showcase" ? "showcase" : "main");

  // ----- Banner, theme, links on the card -----
  function host(url) {
    try { var u = new URL(url); return u.hostname.replace(/^www\./, "") + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, "") : ""); }
    catch (e) { return url; }
  }
  function paintCard() {
    var d = cur;
    var b = $("pcBanner");
    b.style.backgroundImage = d.banner ? 'url("' + d.banner + '")' : "";
    var card = document.querySelector(".profile-card");
    if (d.theme) card.style.setProperty("--pc-theme", d.theme); else card.style.removeProperty("--pc-theme");
    var ul = $("pcLinkList");
    ul.textContent = "";
    d.links.forEach(function (url) {
      var safe = typeof safeUrl === "function" ? safeUrl(url) : "";
      if (!safe) return;
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = safe; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = host(safe);
      li.appendChild(a); ul.appendChild(li);
    });
    $("pcLinks").hidden = ul.children.length === 0;
  }
  paintCard();

  // ----- Edit profile: banner + theme + links (the rest is handled in social.js) -----
  var draft = normalize(null);

  function paintBannerPreview() {
    $("pfBanner").style.backgroundImage = draft.banner ? 'url("' + draft.banner + '")' : "";
    $("pfBannerClear").hidden = !draft.banner;
    $("pfBannerPick").textContent = draft.banner ? "Change banner" : "Banner image";
    var f = $("pfBanner"); if (draft.theme) f.style.setProperty("--pc-theme", draft.theme); else f.style.removeProperty("--pc-theme");
  }
  function paintThemes() {
    var box = $("pfThemes");
    box.textContent = "";
    THEMES.forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-label", c ? "Theme " + c : "No theme colour");
      b.setAttribute("aria-pressed", draft.theme === c ? "true" : "false");
      if (c) b.style.backgroundColor = c; else { b.textContent = "∅"; b.style.background = "var(--panel)"; b.style.color = "var(--muted)"; }
      b.onclick = function () { draft.theme = c; paintThemes(); paintBannerPreview(); };
      box.appendChild(b);
    });
  }
  function shrinkBanner(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { reject(new Error("type")); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("read")); };
      img.onload = function () {
        URL.revokeObjectURL(url);
        var ratio = 3, w = 720, q = 0.8;
        var sw = img.naturalWidth, sh = img.naturalHeight, cw = sw, ch = sw / ratio;
        if (ch > sh) { ch = sh; cw = sh * ratio; }
        var sx = (sw - cw) / 2, sy = (sh - ch) / 2;
        for (var i = 0; i < 10; i++) {
          var cv = document.createElement("canvas"); cv.width = w; cv.height = Math.round(w / ratio);
          var cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
          cx.drawImage(img, sx, sy, cw, ch, 0, 0, cv.width, cv.height);
          var out = cv.toDataURL("image/jpeg", q);
          if (out.length <= 90000) { resolve(out); return; }
          if (q > 0.5) q -= 0.1; else w = Math.round(w * 0.85);
        }
        reject(new Error("big"));
      };
      img.src = url;
    });
  }
  $("pfBannerPick").onclick = function () { $("pfBannerFile").click(); };
  $("pfBannerClear").onclick = function () { draft.banner = ""; $("pfBannerFile").value = ""; paintBannerPreview(); };
  $("pfBannerFile").onchange = function () {
    var f = $("pfBannerFile").files[0];
    if (!f) return;
    shrinkBanner(f).then(function (data) { draft.banner = data; say(""); paintBannerPreview(); })
      .catch(function (err) { say(err.message === "type" ? "Use a JPG, PNG or WebP image." : "Couldn't use that image. Try another."); });
  };

  // Called by social.js: apply(profile) paints the card, fill() loads the edit form, collect() reads it on Save
  window.PC = {
    apply: function (m) { cur = normalize(m); paintCard(); },
    fill: function () {
      draft = normalize(cur);
      paintBannerPreview(); paintThemes();
      for (var i = 0; i < 3; i++) $("pfLink" + (i + 1)).value = draft.links[i] || "";
    },
    collect: function () {
      var links = [];
      for (var i = 1; i <= 3; i++) {
        var raw = $("pfLink" + i).value.trim();
        var safe = raw && typeof safeUrl === "function" ? safeUrl(raw) : "";
        if (safe && safe.length <= 300) links.push(safe);
      }
      return { banner: draft.banner, theme: draft.theme, links: links };
    }
  };

  // Full-screen edit screen: lock page scroll, ✕ and Escape close it
  new MutationObserver(function () {
    document.body.classList.toggle("cmp-open", !$("profForm").hidden || $("showAdd").open);
  }).observe($("profForm"), { attributes: true, attributeFilter: ["hidden"] });
  $("pfClose").onclick = function () { $("pfCancel").click(); };
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !$("profForm").hidden) $("pfCancel").click();
  });

  // ----- Friends row: overlapping avatars; tap to open the full list -----
  var fs = $("friendsSection");
  function paintFriendsRow() {
    var items = $("friendList").querySelectorAll(".soc-item");
    var box = $("pcFriendAvas");
    box.textContent = "";
    Array.prototype.slice.call(items, 0, 5).forEach(function (it) {
      var a = it.querySelector(".pf-ava");
      if (a) box.appendChild(a.cloneNode(true));
    });
    var n = items.length;
    $("pcFriendsCount").textContent = n ? n + (n === 1 ? " friend" : " friends") : "No friends yet";
  }
  new MutationObserver(paintFriendsRow).observe($("friendList"), { childList: true, subtree: true });
  $("pcFriendsRow").onclick = function () {
    var open = fs.classList.toggle("pc-open");
    $("pcFriendsRow").setAttribute("aria-expanded", open ? "true" : "false");
  };
  paintFriendsRow();

  // ----- Featured: up to 3 pinned pieces -----
  window.pcFeatured = function () {
    if (typeof showcase === "undefined") return;
    var pins = showcase.filter(function (s) { return s.pinned; }).slice(0, 3);
    var list = $("pcFeatList");
    list.textContent = "";
    $("pcFeatured").hidden = pins.length === 0;
    pins.forEach(function (s) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "pc-feat";
      var cover = document.createElement("span"); cover.className = "pc-feat-cover";
      if (s.thumb) { var im = document.createElement("img"); im.src = s.thumb; im.alt = ""; cover.appendChild(im); }
      else cover.textContent = (s.title.trim().charAt(0) || "S").toUpperCase();
      var t = document.createElement("strong"); t.textContent = s.title;
      var sub = document.createElement("small"); sub.textContent = s.course ? s.course.split(" \u2013 ")[0] : (s.year ? String(s.year) : "");
      b.appendChild(cover); b.appendChild(t); b.appendChild(sub);
      b.onclick = function () {
        pcTab("showcase");
        var li = document.querySelector('#showList [data-id="' + s.id + '"]');
        if (li) li.scrollIntoView({ block: "center" });
      };
      list.appendChild(b);
    });
  };
  window.pcFeatured();
})();
