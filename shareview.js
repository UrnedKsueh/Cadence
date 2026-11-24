// Public showcase link: shows a read-only page when the address has ?share=ID,
// and holds the helpers the signed-in share controls use (share.js talks to Firebase).
(function () {
  "use strict";
  const ID_RE = /^[A-Za-z0-9]{20,64}$/;
  const params = new URLSearchParams(location.search);
  const shareId = ID_RE.test(params.get("share") || "") ? params.get("share") : "";

  // Runs in <head>: hide the app and sign-in screen right away on a share link
  if (shareId) document.documentElement.classList.add("share-view");

  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // Only plain, trimmed text and web links are accepted from shared data
  function cleanItem(s) {
    if (!s || typeof s.title !== "string" || !s.title.trim()) return null;
    const t = function (v, n) { return typeof v === "string" ? v.trim().slice(0, n) : ""; };
    let url = "";
    try { const u = new URL(String(s.url || "").trim()); if (u.protocol === "https:" || u.protocol === "http:") url = u.href; } catch (e) {}
    const year = Math.round(Number(s.year));
    return {
      title: t(s.title, 120), course: t(s.course, 60), role: t(s.role, 60), note: t(s.note, 400), url: url,
      year: year >= 1990 && year <= 2100 ? year : "",
      tools: (Array.isArray(s.tools) ? s.tools : []).map(function (x) { return t(x, 30); }).filter(Boolean).slice(0, 8)
    };
  }

  // What gets published: no thumbnails, no internal ids, nothing but showcase fields
  function itemsFrom(list) {
    return (list || []).map(cleanItem).filter(Boolean).slice(0, 20);
  }

  function card(s) {
    const c = mk("div", "show-card big");
    const head = mk("div", "show-head");
    head.appendChild(mk("div", "proj-tile tint-a", s.title.charAt(0).toUpperCase()));
    const box = mk("div", "show-title");
    box.appendChild(mk("strong", "", s.title));
    if (s.role) box.appendChild(mk("small", "", s.role));
    const tags = mk("div", "tags");
    if (s.year) tags.appendChild(mk("span", "chip", String(s.year)));
    if (s.course) tags.appendChild(mk("span", "chip", s.course));
    if (tags.childNodes.length) box.appendChild(tags);
    head.appendChild(box);
    c.appendChild(head);
    if (s.tools.length) {
      const tools = mk("div", "tools");
      s.tools.forEach(function (t) { tools.appendChild(mk("span", "chip", t)); });
      c.appendChild(tools);
    }
    if (s.note) c.appendChild(mk("p", "note", s.note));
    const embed = typeof embedUrl === "function" ? embedUrl(s.url) : "";
    if (embed) {
      const f = document.createElement("iframe");
      f.className = "player";
      f.src = embed;
      f.title = "Video: " + s.title;
      f.setAttribute("allow", "fullscreen; picture-in-picture");
      f.setAttribute("referrerpolicy", "no-referrer");
      f.loading = "lazy";
      c.appendChild(f);
    }
    if (s.url) {
      const row = mk("div", "row");
      const a = mk("a", "btn secondary", "Open link");
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      row.appendChild(a);
      c.appendChild(row);
    }
    return c;
  }

  function renderView(data, errorText) {
    const root = document.getElementById("shareView");
    if (!root) return;
    root.textContent = "";
    if (errorText || !data) {
      root.appendChild(mk("h1", "", "Showcase"));
      root.appendChild(mk("p", "empty", errorText || "This showcase isn't available."));
    } else {
      const who = typeof data.name === "string" && data.name.trim() ? data.name.trim().slice(0, 40) : "";
      root.appendChild(mk("h1", "", who ? who + "'s showcase" : "Showcase"));
      const items = itemsFrom(data.items);
      if (!items.length) root.appendChild(mk("p", "empty", "Nothing here yet."));
      const list = mk("div", "share-list");
      items.forEach(function (s) { list.appendChild(card(s)); });
      root.appendChild(list);
      document.title = (who ? who + "'s showcase" : "Showcase") + " · Cadence";
    }
    const foot = mk("p", "hint share-foot");
    foot.appendChild(document.createTextNode("Made with "));
    const home = mk("a", "", "Cadence");
    home.href = location.pathname;
    foot.appendChild(home);
    root.appendChild(foot);
  }

  function newId() {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from(bytes, function (b) { return chars[b % chars.length]; }).join("");
  }

  function linkFor(id) { return location.origin + location.pathname + "?share=" + id; }

  window.CadenceShare = { id: shareId, card: card, mk: mk, itemsFrom: itemsFrom, renderView: renderView, newId: newId, linkFor: linkFor, ID_RE: ID_RE };
  // Placeholder only if the data hasn't already arrived
  if (shareId) document.addEventListener("DOMContentLoaded", function () {
    const root = document.getElementById("shareView");
    if (root && !root.firstChild) renderView(null, "Loading…");
  });
})();
