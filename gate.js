(function () {
  "use strict";
  const GUEST = "cadence:guest";
  const gate = document.getElementById("gate");
  const app = document.getElementById("app");
  const wait = document.getElementById("gateWait");
  const actions = document.getElementById("gateActions");
  const note = document.getElementById("gateNote");
  const signIn = document.getElementById("gateSignIn");
  const skip = document.getElementById("gateSkip");
  let resolved = false;

  function isGuest() {
    try { return localStorage.getItem(GUEST) === "1"; } catch (e) { return false; }
  }

  function setGuest(on) {
    try {
      if (on) localStorage.setItem(GUEST, "1"); else localStorage.removeItem(GUEST);
    } catch (e) {}
  }

  function hide() {
    gate.hidden = true;
    app.inert = false;
    document.body.classList.remove("locked");
  }

  function show() {
    gate.hidden = false;
    app.inert = true;
    document.body.classList.add("locked");
  }

  function ready() {
    wait.hidden = true;
    actions.hidden = false;
    if (!gate.hidden) signIn.focus();
  }

  function message(text) {
    note.textContent = text;
    note.classList.add("error");
  }

  window.Gate = {
    resolve: function (user) {
      resolved = true;
      if (user || isGuest()) { hide(); return; }
      show();
      ready();
    },
    signedOut: function () {
      setGuest(false);
      note.classList.remove("error");
      show();
      ready();
    },
    message: message
  };

  signIn.onclick = function () {
    message("Sign-in isn't available right now. It needs an internet connection and the hosted app.");
  };

  skip.onclick = function () {
    setGuest(true);
    hide();
  };

  if (isGuest()) {
    hide();
  } else {
    show();
    setTimeout(function () {
      if (!resolved) ready();
    }, 5000);
  }
})();
