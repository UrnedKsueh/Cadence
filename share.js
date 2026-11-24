// Share controls and the public viewer's data loading (Firebase). Runs after cloud.js.
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, query, where, limit, getDocs }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const S = window.CadenceShare;
const db = getFirestore(getApp());
const $ = function (id) { return document.getElementById(id); };

if (S.id) {
  // Public viewer: no sign-in needed
  getDoc(doc(db, "shares", S.id)).then(function (snap) {
    if (snap.exists()) S.renderView(snap.data());
    else S.renderView(null, "This showcase link isn't active. The owner may have stopped sharing it.");
  }).catch(function () {
    S.renderView(null, "Couldn't load this showcase. Check your connection and try again.");
  });
} else {
  const box = $("shareSection");
  const msg = $("shareMsg");
  const nameInput = $("shareName");
  const linkInput = $("shareLink");
  let uid = "";
  let shareId = "";
  try { nameInput.value = localStorage.getItem("cadence:displayName") || ""; } catch (e) {}
  nameInput.oninput = function () { try { localStorage.setItem("cadence:displayName", nameInput.value.trim().slice(0, 40)); } catch (e) {} };

  function say(text) { msg.textContent = text; }

  function paint() {
    const live = !!shareId;
    $("sharePublish").textContent = live ? "Update shared copy" : "Create share link";
    $("shareCopy").hidden = !live;
    $("shareStop").hidden = !live;
    linkInput.hidden = !live;
    linkInput.value = live ? S.linkFor(shareId) : "";
  }

  async function findExisting() {
    const q = query(collection(db, "shares"), where("owner", "==", uid), limit(1));
    const snap = await getDocs(q);
    if (snap.empty) { shareId = ""; return; }
    shareId = snap.docs[0].id;
    nameInput.value = snap.docs[0].data().name || "";
  }

  $("sharePublish").onclick = async function () {
    if (!uid) return;
    const items = S.itemsFrom(Storage.snapshot().showcase);
    if (!items.length) { say("Add at least one piece to your Showcase first."); return; }
    const name = nameInput.value.trim().slice(0, 40);
    const id = shareId || S.newId();
    this.disabled = true;
    try {
      await setDoc(doc(db, "shares", id), { owner: uid, name: name, items: items, updatedAt: Date.now() });
      shareId = id;
      paint();
      say("Shared " + items.length + (items.length === 1 ? " piece." : " pieces.") + " Anyone with the link can view them. Thumbnails aren't included.");
    } catch (e) {
      say("Couldn't publish. Check your connection, and that the share rules are published in Firebase.");
    }
    this.disabled = false;
  };

  $("shareCopy").onclick = async function () {
    const url = S.linkFor(shareId);
    try { await navigator.clipboard.writeText(url); say("Link copied."); }
    catch (e) { linkInput.focus(); linkInput.select(); say("Copy the link from the box."); }
  };

  $("shareStop").onclick = async function () {
    if (!shareId || !confirm("Stop sharing? The link will stop working for everyone.")) return;
    try { await deleteDoc(doc(db, "shares", shareId)); shareId = ""; paint(); say("Sharing stopped. The link no longer works."); }
    catch (e) { say("Couldn't stop sharing. Try again."); }
  };

  onAuthStateChanged(getAuth(), async function (user) {
    uid = user ? user.uid : "";
    box.hidden = !user;
    if (!user) { shareId = ""; paint(); return; }
    try { await findExisting(); } catch (e) { say("Sharing isn't set up yet (rules not published)."); }
    paint();
  });
}
