"use strict";

// ===== storage.js =====
// Every read and write of saved data goes through this file.
// Today it saves to the browser (localStorage). Later, a cloud backend can be
// plugged in with Storage.setCloud() without touching the rest of the app.

const Storage = (function () {
  const PREFIX = "cadence:";
  // Old Render Room data lived under bare keys; it is copied over once, never deleted.
  const LEGACY_KEYS = ["deadlines", "projects", "showcase"];

  // Per-student limits. They apply to cloud saves (see firestore.rules).
  const LIMITS = { projects: 10, shotsPerProject: 100, showcase: 20, deadlines: 200 };

  let cloud = null;       // { save(snapshot) } set once login exists
  let syncTimer = null;
  const SYNC_DELAY_MS = 4000;

  function readRaw(name) {
    try {
      return JSON.parse(localStorage.getItem(name));
    } catch (error) {
      return null;
    }
  }

  function migrateLegacy() {
    LEGACY_KEYS.forEach(function (key) {
      try {
        if (localStorage.getItem(PREFIX + key) === null && localStorage.getItem(key) !== null) {
          localStorage.setItem(PREFIX + key, localStorage.getItem(key));
        }
      } catch (error) { /* storage unavailable; app still runs this session */ }
    });
  }

  function load(key) {
    const data = readRaw(PREFIX + key);
    return Array.isArray(data) ? data : [];
  }

  function store(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (error) {
      return false; // private mode or full
    }
    scheduleSync();
    return true;
  }

  function snapshot() {
    return {
      deadlines: load("deadlines"),
      projects: load("projects"),
      showcase: load("showcase"),
      updatedAt: Date.now()
    };
  }

  // Returns a list of plain-English problems; empty means the data fits the limits.
  function overLimits(data) {
    const problems = [];
    if (data.projects.length > LIMITS.projects) problems.push("more than " + LIMITS.projects + " projects");
    if (data.showcase.length > LIMITS.showcase) problems.push("more than " + LIMITS.showcase + " showcase pieces");
    if (data.deadlines.length > LIMITS.deadlines) problems.push("more than " + LIMITS.deadlines + " deadlines");
    data.projects.forEach(function (p) {
      if (Array.isArray(p.shots) && p.shots.length > LIMITS.shotsPerProject) {
        problems.push("more than " + LIMITS.shotsPerProject + " shots in \"" + p.name + "\"");
      }
    });
    return problems;
  }

  // Cloud sync waits a few seconds after the last edit so the free daily quota barely moves.
  function scheduleSync() {
    if (!cloud) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, SYNC_DELAY_MS);
  }

  function syncNow() {
    if (!cloud) return Promise.resolve(false);
    const snap = snapshot();
    const problems = overLimits(snap);
    if (problems.length) return Promise.resolve({ ok: false, problems: problems });
    return Promise.resolve(cloud.save(snap)).then(function () { return { ok: true }; });
  }

  function setCloud(backend) {
    cloud = backend;
    scheduleSync();
  }

  migrateLegacy();
  return { load: load, store: store, snapshot: snapshot, overLimits: overLimits,
           setCloud: setCloud, syncNow: syncNow, LIMITS: LIMITS };
})();
