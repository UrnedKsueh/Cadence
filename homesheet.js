/* Portrait home: Overview/Calendar pill, and Deadlines in a bottom sheet. Landscape ignores all of this. */
(function () {
  var grid = document.querySelector(".home-grid");
  var sheet = document.getElementById("deadlinesSheet");
  var back = document.getElementById("dlBackdrop");
  var mq = window.matchMedia("not all and (min-width: 900px) and (orientation: landscape)");
  if (!grid || !sheet || !back) return;
  grid.setAttribute("data-view", "overview");

  function setView(v) {
    grid.setAttribute("data-view", v);
    ["overview", "calendar"].forEach(function (k) {
      var b = document.getElementById(k === "overview" ? "pillOverview" : "pillCalendar");
      if (b) b.setAttribute("aria-selected", k === v ? "true" : "false");
    });
  }
  document.getElementById("homePill").addEventListener("click", function (e) {
    var b = e.target.closest("[data-view]");
    if (b) setView(b.getAttribute("data-view"));
  });

  function openSheet(focusName) {
    if (!mq.matches) return false;
    sheet.classList.add("sheet-open");
    back.hidden = false;
    document.body.classList.add("dl-open");
    sheet.scrollTop = 0;
    if (focusName) { var n = document.getElementById("deadlineName"); if (n) n.focus(); }
    return true;
  }
  function closeSheet() {
    sheet.classList.remove("sheet-open");
    back.hidden = true;
    document.body.classList.remove("dl-open");
  }
  window.openDeadlines = openSheet;
  document.getElementById("dlClose").addEventListener("click", closeSheet);
  back.addEventListener("click", closeSheet);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeSheet(); });
  /* Portrait: course filter joins the pill row; the greeting and post form move into the Community card. */
  var pillRow = document.getElementById("homePill");
  var filter = document.querySelector(".ov-filter");
  var filterHome = filter && filter.parentNode;
  var hello = document.querySelector(".home-hello");
  var helloHome = hello && hello.parentNode;
  var composer = document.querySelector(".composer");
  var feed = document.querySelector(".home-feed");
  function place() {
    if (mq.matches) {
      if (filter && filter.parentNode !== pillRow) pillRow.appendChild(filter);
      if (composer && feed && composer.parentNode !== feed) feed.insertBefore(composer, feed.firstChild);
    } else {
      if (filter && filterHome && filter.parentNode !== filterHome) filterHome.appendChild(filter);
      if (composer && feed && composer.parentNode === feed) feed.parentNode.insertBefore(composer, feed);
    }
    /* Greeting sits in the post card at every size, so the header only holds logo + search */
    if (hello && composer && hello.parentNode !== composer) composer.insertBefore(hello, composer.firstChild);
  }
  place();
  if (mq.addEventListener) mq.addEventListener("change", function () { place(); if (!mq.matches) closeSheet(); });
})();
