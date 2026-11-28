(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var P = {
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    send: '<path d="M21.5 2.5 10.5 13.5"/><path d="M21.5 2.5 14.5 21.5l-4-8-8-4z"/>',
    message: '<path d="M21 12a8.5 8.5 0 0 1-12.2 7.6L3.5 21l1.5-4.7A8.5 8.5 0 1 1 21 12z"/>',
    userCheck: '<circle cx="9" cy="7.5" r="3.5"/><path d="M2.5 20v-1.5a4.5 4.5 0 0 1 4.5-4.5h4a4.5 4.5 0 0 1 4.5 4.5V20"/><path d="m16.5 11 2 2 4-4.5"/>',
    userPlus: '<circle cx="9" cy="7.5" r="3.5"/><path d="M2.5 20v-1.5a4.5 4.5 0 0 1 4.5-4.5h4a4.5 4.5 0 0 1 4.5 4.5V20"/><path d="M19 8v6M16 11h6"/>',
    userMinus: '<circle cx="9" cy="7.5" r="3.5"/><path d="M2.5 20v-1.5a4.5 4.5 0 0 1 4.5-4.5h4a4.5 4.5 0 0 1 4.5 4.5V20"/><path d="M16 11h6"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.7"/><path d="m21 16-5-5L6 20"/>',
    pencil: '<path d="M4 20h4L19.5 8.5l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    chevL: '<path d="m15 6-6 6 6 6"/>',
    chevR: '<path d="m9 6 6 6-6 6"/>',
    more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
    upload: '<path d="M12 16V5M7 9l5-5 5 5M5 20h14"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14-4.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14 4.5L20 15M20 20v-5h-5"/>',
    logout: '<path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10M15 8l4 4-4 4M19 12H9"/>',
    checks: '<path d="m2.5 12.5 4 4L14 8M10 16.5l1 1L21 7"/>',
    reply: '<path d="M9 6 3.5 11.5 9 17M4 11.5h9a7 7 0 0 1 7 7V19"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
    play: '<path d="M8 5.5v13l11-6.5z"/>',
    external: '<path d="M14 4h6v6M20 4 11 13M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
    smilePlus: '<path d="M20.5 12.5A8.5 8.5 0 1 1 11.5 3.6"/><path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M14 9.5h.01M18 3v5M15.5 5.5h5"/>',
    inbox: '<path d="M3.5 13.5 6 5.5h12l2.5 8M3.5 13.5V18a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4.5h-5l-1.5 2.5h-5L8.5 13.5z"/>'
  };
  function svg(name) {
    var s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", "ico");
    s.innerHTML = P[name] || "";
    return s;
  }
  function label(btn, name, text) {
    btn.classList.add("has-ico");
    btn.textContent = "";
    btn.appendChild(svg(name));
    btn.appendChild(document.createTextNode(text));
    return btn;
  }

  var SYMBOLS = {
    "\u2715": ["x", "Close"], "\u2716": ["x", "Close"], "\u00d7": ["x", "Close"],
    "\u2190": ["arrowLeft", "Back"], "\u2039": ["chevL", "Previous"], "\u203a": ["chevR", "Next"],
    "\u2191": ["arrowUp", "Send"], "\u22ef": ["more", "More actions"], "\u270e": ["pencil", "Edit"]
  };
  var LABELS = {
    "Add": "plus", "Add deadline": "plus", "Add a deadline": "plus", "Add project": "plus", "Add resource": "plus",
    "Add link": "plus", "Add assessment": "plus", "Add stage": "plus", "Add photo": "image", "Create invite code": "plus", "New code": "refresh",
    "Edit": "pencil", "Edit profile": "pencil", "Edit Profile": "pencil",
    "Delete": "trash", "Delete project": "trash", "Delete post": "trash", "Delete card": "trash", "Remove stage": "trash", "Remove icon": "trash",
    "Copy": "copy", "Copy link": "copy", "Copy my invite link": "copy",
    "Search": "search", "Search older messages": "search",
    "Export": "download", "Import": "upload", "Refresh": "refresh", "Sign out": "logout",
    "Invite": "userPlus", "Invite people": "userPlus", "Join": "userPlus", "Join project": "userPlus",
    "Mark all read": "checks", "Reply": "reply", "Create share link": "link", "Add to my calendar (.ics)": "calendar",
    "Save": "check", "Save changes": "check", "Done": "check", "Post": "send", "Post announcement": "send", "Send": "send",
    "Present mode": "play", "Open link": "external", "Open project": "external", "Load older messages": "arrowUp"
  };

  function enhance(el) {
    if (!el || el.nodeType !== 1 || el.querySelector(".ico") || el.children.length || el.dataset.noico) return;
    var t = el.textContent.trim();
    if (!t) return;
    if (SYMBOLS[t]) {
      var s = SYMBOLS[t];
      var name = el.classList.contains("chat-rx-add") ? "smilePlus" : s[0];
      var lab = el.classList.contains("chat-rx-add") ? "Add reaction" : s[1];
      el.textContent = "";
      el.appendChild(svg(name));
      el.classList.add("ico-only");
      if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", lab);
      return;
    }
    if (LABELS[t]) label(el, LABELS[t], t);
  }
  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches("button, a.btn")) enhance(root);
    var list = root.querySelectorAll ? root.querySelectorAll("button, a.btn") : [];
    for (var i = 0; i < list.length; i++) enhance(list[i]);
  }
  var queue = [], pending = false;
  function flush() {
    pending = false;
    var q = queue; queue = [];
    for (var i = 0; i < q.length; i++) scan(q[i]);
  }
  function start() {
    scan(document.body);
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.target.nodeType === 1 && m.addedNodes.length && m.target.matches("button, a.btn")) queue.push(m.target);
        for (var j = 0; j < m.addedNodes.length; j++) if (m.addedNodes[j].nodeType === 1) queue.push(m.addedNodes[j]);
      }
      if (queue.length && !pending) { pending = true; requestAnimationFrame(flush); }
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  window.CadenceIcons = { svg: svg, label: label, enhance: enhance };
})();
