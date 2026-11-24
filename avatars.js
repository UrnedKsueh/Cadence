// Shared profile pictures: custom photo (small JPEG) or a coloured initial. Used by the feed and Profile.
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const db = getFirestore(getApp());
export const COLORS = ["#4fc3a1", "#8fa8ff", "#f0b44c", "#ff8a80", "#c792ea", "#5cc8e8"];
const cache = {};
const pending = {};

export function setCached(uid, p) { cache[uid] = p; }
export async function getProfile(uid) {
  if (cache[uid]) return cache[uid];
  if (!pending[uid]) {
    pending[uid] = getDoc(doc(db, "profiles", uid)).then(function (s) { if (s.exists()) cache[uid] = s.data(); return cache[uid] || null; })
      .catch(function () { return null; }).then(function (p) { delete pending[uid]; return p; });
  }
  return pending[uid];
}

function okPhoto(s) { return typeof s === "string" && s.length <= 14000 && s.indexOf("data:image/jpeg;base64,") === 0; }

// Fill an avatar element from a profile ({nickname, color, photo}); name is the fallback for the initial
export function paintAva(el, p, name) {
  const label = (p && p.nickname) || name || "?";
  const c = (p && p.color) || COLORS[0];
  el.textContent = "";
  if (p && okPhoto(p.photo)) {
    const img = document.createElement("img");
    img.src = p.photo; img.alt = ""; img.decoding = "async";
    el.appendChild(img);
    el.style.backgroundColor = "";
    el.style.color = "";
  } else {
    el.textContent = label.trim().charAt(0).toUpperCase() || "?";
    el.style.color = c;
    el.style.backgroundColor = "color-mix(in srgb, " + c + " 22%, var(--panel))";
  }
}
export function avatarEl(p, cls, name) {
  const el = document.createElement("span");
  el.className = "pf-ava" + (cls ? " " + cls : "");
  el.setAttribute("aria-hidden", "true");
  paintAva(el, p, name);
  return el;
}
// Avatar for someone by uid: shows their initial right away, swaps in their picture when it loads
export function avatarFor(uid, name, cls) {
  const el = avatarEl(null, cls, name);
  getProfile(uid).then(function (p) { if (p) paintAva(el, p, name); });
  return el;
}
