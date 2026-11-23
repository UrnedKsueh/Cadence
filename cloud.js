// Google sign-in and cloud backup (Firebase Spark plan). Local saving still works without it.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, collection, query, orderBy, limit, getDocs, addDoc, deleteDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAXSibyXH-jursSgGpbgbaANkIyTVNn2bc",
  authDomain: "cadence-5eb28.firebaseapp.com",
  projectId: "cadence-5eb28",
  storageBucket: "cadence-5eb28.firebasestorage.app",
  messagingSenderId: "339847867150",
  appId: "1:339847867150:web:281c7da76079418250455f"
};

const $ = function (id) { return document.getElementById(id); };
const status = function (text) { $("syncStatus").textContent = text; };
function paintAvatar(node, user) {
  node.textContent = "";
  if (!user) return;
  if (user.photoURL) {
    const img = document.createElement("img");
    img.src = user.photoURL;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.onerror = function () { node.textContent = initial(user); };
    node.appendChild(img);
  } else {
    node.textContent = initial(user);
  }
}

function initial(user) {
  return ((user.displayName || user.email || "?").trim().charAt(0) || "?").toUpperCase();
}

function showProfile(user) {
  $("profileName").textContent = user ? (user.displayName || "Signed in") : "Guest";
  $("profileEmail").textContent = user ? (user.email || "") : "Not signed in";
  paintAvatar($("profileAvatar"), user);
  paintAvatar($("headerAvatar"), user);
  $("avatarBtn").setAttribute("aria-label", user ? "Open profile for " + (user.displayName || user.email) : "Open profile");
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Thumbnails stay on the device so the cloud copy stays small
function forCloud(snap) {
  return {
    deadlines: snap.deadlines, projects: snap.projects, updatedAt: snap.updatedAt,
    showcase: snap.showcase.map(function (s) { const c = Object.assign({}, s); delete c.thumb; return c; })
  };
}

function backend(user) {
  return {
    save: function (snap) {
      return setDoc(doc(db, "users", user.uid), forCloud(snap)).then(function () {
        localStorage.setItem("cadence:lastSync:" + user.uid, String(snap.updatedAt));
        status("Synced to your account (" + user.email + ").");
      }).catch(function () { status("Couldn't sync. Saved on this device; will retry on next edit."); });
    }
  };
}

async function start(user) {
  status("Checking your account…");
  const ref = doc(db, "users", user.uid);
  const lastKey = "cadence:lastSync:" + user.uid;
  const lastSync = Number(localStorage.getItem(lastKey)) || 0;
  let cloud = null;
  try {
    const snap = await getDoc(ref);
    cloud = snap.exists() ? snap.data() : null;
  } catch (error) {
    status("Couldn't reach your account. Saved on this device only.");
    return;
  }
  const local = Storage.snapshot();
  const hasLocal = local.deadlines.length + local.projects.length + local.showcase.length > 0;

  if (cloud && (cloud.updatedAt || 0) > lastSync) {
    const useCloud = !hasLocal || confirm(
      "A saved copy was found in your account.\nOK = use the account copy (replaces this device).\nCancel = keep this device and overwrite the account copy.");
    if (useCloud) {
      const keepThumb = {};
      local.showcase.forEach(function (s) { if (s.thumb) keepThumb[s.id] = s.thumb; });
      applyData(cloud.deadlines || [], cloud.projects || [],
        (cloud.showcase || []).map(function (s) { return Object.assign({}, s, { thumb: keepThumb[s.id] || "" }); }));
      localStorage.setItem(lastKey, String(cloud.updatedAt || Date.now()));
    }
  }
  Storage.setCloud(backend(user));
  const result = await Storage.syncNow();
  if (result && result.ok === false) status("Over your limits (" + result.problems.join(", ") + "). Not synced; still saved here.");
}

function signInFlow() {
  return signInWithPopup(auth, new GoogleAuthProvider()).catch(function () {
    const text = "Sign-in didn't complete. Sign-in only works once the app is hosted, not from a file.";
    status(text);
    window.Gate.message(text);
  });
}

$("signInBtn").onclick = signInFlow;
$("gateSignIn").onclick = signInFlow;
$("signOutBtn").onclick = function () {
  signOut(auth).then(function () { window.Gate.signedOut(); });
};

onAuthStateChanged(auth, function (user) {
  $("signInBtn").hidden = !!user;
  $("signOutBtn").hidden = !user;
  showProfile(user);
  window.Gate.resolve(user);
  if (user) { start(user); }
  else { Storage.setCloud(null); status("Saved on this device only."); }
});


// ===== Announcements =====
// Everyone signed in reads them; only accounts listed in the "admins" collection can post.
let isAdmin = false;
let announcements = [];
let lastFetch = 0;
const DISMISSED_KEY = "cadence:dismissedAnnouncements";

function dismissed() {
  try { return JSON.parse(localStorage.getItem(DISMISSED_KEY)) || []; } catch (error) { return []; }
}
function dismiss(id) {
  const list = dismissed();
  if (list.indexOf(id) === -1) list.push(id);
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(list.slice(-50))); } catch (error) { /* storage unavailable */ }
  renderAnnouncements();
}

function when(item) {
  return item.createdAt && item.createdAt.toDate
    ? item.createdAt.toDate().toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
}

function renderAnnouncements() {
  const box = $("announceBox");
  box.innerHTML = "";
  const hide = dismissed();
  const shown = announcements.filter(function (a) { return hide.indexOf(a.id) === -1; }).slice(0, 3);
  box.hidden = shown.length === 0;
  shown.forEach(function (a) {
    const card = document.createElement("div");
    card.className = "announce";
    card.setAttribute("role", "status");
    const text = document.createElement("div");
    text.className = "announce-text";
    const strong = document.createElement("strong");
    strong.textContent = a.title;
    text.appendChild(strong);
    if (a.body) {
      const p = document.createElement("p");
      p.textContent = a.body;
      text.appendChild(p);
    }
    const date = when(a);
    if (date) {
      const small = document.createElement("small");
      small.textContent = date;
      text.appendChild(small);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "remove";
    close.textContent = "\u2715";
    close.setAttribute("aria-label", "Dismiss \"" + a.title + "\"");
    close.onclick = function () { dismiss(a.id); };
    card.appendChild(text);
    card.appendChild(close);
    box.appendChild(card);
  });

  // Admin list (with delete)
  const list = $("announceAdminList");
  list.innerHTML = "";
  if (isAdmin) {
    announcements.forEach(function (a) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = a.title + (when(a) ? " \u00b7 " + when(a) : "");
      const del = document.createElement("button");
      del.type = "button";
      del.className = "remove";
      del.textContent = "\u2715";
      del.setAttribute("aria-label", "Delete announcement \"" + a.title + "\"");
      del.onclick = function () {
        if (!confirm("Delete this announcement for everyone?")) return;
        deleteDoc(doc(db, "announcements", a.id)).then(function () { return loadAnnouncements(true); })
          .catch(function () { $("announceMsg").textContent = "Couldn't delete. Check your connection."; });
      };
      li.appendChild(label);
      li.appendChild(del);
      list.appendChild(li);
    });
  }
}

async function loadAnnouncements(force) {
  if (!auth.currentUser) return;
  if (!force && Date.now() - lastFetch < 60000) return; // at most once a minute
  lastFetch = Date.now();
  try {
    const snap = await getDocs(query(collection(db, "announcements"), orderBy("createdAt", "desc"), limit(10)));
    announcements = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
  } catch (error) { return; } // offline or rules not published yet: just show nothing
  renderAnnouncements();
}

async function checkAdmin(user) {
  try {
    const snap = await getDoc(doc(db, "admins", user.uid));
    isAdmin = snap.exists();
  } catch (error) { isAdmin = false; }
  $("adminSection").hidden = !isAdmin;
}

$("announceForm").onsubmit = function (event) {
  event.preventDefault();
  const title = $("announceTitle").value.trim();
  if (!title || !isAdmin) return;
  const btn = $("announceSubmit");
  btn.disabled = true;
  addDoc(collection(db, "announcements"), {
    title: title.slice(0, 80), body: $("announceBody").value.trim().slice(0, 500), createdAt: serverTimestamp()
  }).then(function () {
    $("announceForm").reset();
    $("announceMsg").textContent = "Posted. Students will see it on their Home tab.";
    return loadAnnouncements(true);
  }).catch(function () {
    $("announceMsg").textContent = "Couldn't post. Make sure the latest firestore.rules are published and your account is in the admins collection.";
  }).then(function () { btn.disabled = false; });
};

onAuthStateChanged(auth, function (user) {
  if (user) { checkAdmin(user).then(function () { return loadAnnouncements(true); }); }
  else {
    isAdmin = false; announcements = []; lastFetch = 0;
    $("adminSection").hidden = true;
    renderAnnouncements();
  }
});
document.addEventListener("visibilitychange", function () {
  if (!document.hidden) loadAnnouncements(false);
});
