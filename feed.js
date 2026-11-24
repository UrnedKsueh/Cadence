// Community feed: signed-in students post finished pieces, like and comment. Runs after cloud.js.
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, query, orderBy, limit, getDocs, addDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const S = window.CadenceShare;
if (!S.id) {
  const db = getFirestore(getApp());
  const $ = function (id) { return document.getElementById(id); };
  const mk = S.mk;
  let user = null;
  let admin = false;
  let loading = false;

  function posted() {
    try { return JSON.parse(localStorage.getItem("cadence:posted:" + user.uid)) || {}; } catch (e) { return {}; }
  }
  function savePosted(map) {
    try { localStorage.setItem("cadence:posted:" + user.uid, JSON.stringify(map)); } catch (e) {}
  }
  function myName() {
    let n = "";
    try { n = (localStorage.getItem("cadence:displayName") || "").trim(); } catch (e) {}
    if (!n && user && user.displayName) n = user.displayName.trim().split(/\s+/)[0];
    return (n || "A student").slice(0, 40);
  }
  function ms(t) { return t && typeof t.toMillis === "function" ? t.toMillis() : Number(t) || 0; }
  function ago(t) {
    const m = Math.max(0, Math.round((Date.now() - ms(t)) / 60000));
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    if (m < 1440) return Math.round(m / 60) + " h ago";
    return Math.round(m / 1440) + " d ago";
  }
  function say(text) { $("feedMsg").textContent = text; }
  function refreshApp() { if (typeof renderAll === "function") renderAll(); }

  window.CadenceFeed = {
    ready: function () { return !!user; },
    isPosted: function (showId) { return !!(user && posted()[showId]); },
    post: async function (piece) {
      const item = S.itemsFrom([piece])[0];
      if (!user || !item) return;
      if (!confirm("Post \"" + item.title + "\" to the Community feed?\nAll signed-in Cadence students will see it, with the name \"" + myName() + "\".")) return;
      try {
        const ref = await addDoc(collection(db, "posts"), {
          owner: user.uid, authorName: myName(), title: item.title, course: item.course, year: item.year,
          role: item.role, tools: item.tools, note: item.note, url: item.url, createdAt: serverTimestamp()
        });
        const map = posted(); map[piece.id] = ref.id; savePosted(map);
        refreshApp();
        alert("Posted. Find it in the Community tab.");
      } catch (e) { alert("Couldn't post. Check your connection and that the new rules are published."); }
    },
    unpost: async function (showId) {
      const id = posted()[showId];
      if (!user || !id || !confirm("Remove this piece from the Community feed?")) return;
      try {
        // If an admin already removed the post, just clear the button
        const stillThere = (await getDoc(doc(db, "posts", id))).exists();
        if (stillThere) await deleteDoc(doc(db, "posts", id));
        const map = posted(); delete map[showId]; savePosted(map);
        refreshApp();
      } catch (e) { alert("Couldn't remove it. Try again."); }
    }
  };

  async function loadComments(postId, postOwner, list) {
    list.textContent = "";
    let snap;
    try { snap = await getDocs(query(collection(db, "posts", postId, "comments"), orderBy("createdAt"), limit(30))); }
    catch (e) { list.appendChild(mk("p", "hint", "Couldn't load comments.")); return; }
    if (snap.empty) list.appendChild(mk("p", "hint", "No comments yet."));
    snap.docs.forEach(function (d) {
      const c = d.data();
      const row = mk("div", "comment");
      const who = mk("strong", "", String(c.authorName || "A student").slice(0, 40));
      row.appendChild(who);
      row.appendChild(document.createTextNode(" " + String(c.text || "").slice(0, 200) + " "));
      row.appendChild(mk("small", "hint", ago(c.createdAt)));
      if (user && (c.owner === user.uid || postOwner === user.uid || admin)) {
        const del = mk("button", "remove", "✕");
        del.type = "button";
        del.setAttribute("aria-label", "Delete comment");
        del.onclick = async function () {
          try { await deleteDoc(doc(db, "posts", postId, "comments", d.id)); loadComments(postId, postOwner, list); }
          catch (e) { say("Couldn't delete the comment."); }
        };
        row.appendChild(del);
      }
      list.appendChild(row);
    });
  }

  function renderPost(id, data, likes) {
    const wrap = mk("article", "post");
    const head = mk("div", "post-head");
    head.appendChild(mk("strong", "", String(data.authorName || "A student").slice(0, 40)));
    head.appendChild(mk("small", "hint", " · " + ago(data.createdAt)));
    wrap.appendChild(head);
    const item = S.itemsFrom([data])[0];
    if (item) wrap.appendChild(S.card(item));

    const mine = likes.some(function (l) { return l.id === user.uid; });
    let count = likes.length;
    let liked = mine;
    const bar = mk("div", "row post-bar");
    const like = mk("button", "secondary", "");
    like.type = "button";
    function paintLike() {
      like.textContent = (liked ? "♥ " : "♡ ") + count;
      like.setAttribute("aria-pressed", liked ? "true" : "false");
      like.setAttribute("aria-label", (liked ? "Unlike" : "Like") + ", " + count + (count === 1 ? " like" : " likes"));
    }
    paintLike();
    like.onclick = async function () {
      const was = liked;
      liked = !was; count += was ? -1 : 1; paintLike();
      try {
        const ref = doc(db, "posts", id, "likes", user.uid);
        if (was) await deleteDoc(ref); else await setDoc(ref, { at: Date.now() });
      } catch (e) { liked = was; count += was ? 1 : -1; paintLike(); say("Couldn't save your like."); }
    };
    bar.appendChild(like);

    const cBtn = mk("button", "secondary", "Comments");
    cBtn.type = "button";
    cBtn.setAttribute("aria-expanded", "false");
    bar.appendChild(cBtn);

    if (data.owner === user.uid || admin) {
      const del = mk("button", "secondary", "Delete post");
      del.type = "button";
      del.onclick = async function () {
        if (!confirm("Delete this post for everyone?")) return;
        try {
          await deleteDoc(doc(db, "posts", id));
          if (data.owner === user.uid) {
            const map = posted();
            Object.keys(map).forEach(function (k) { if (map[k] === id) delete map[k]; });
            savePosted(map);
            refreshApp();
          }
          wrap.remove();
        } catch (e) { say("Couldn't delete the post."); }
      };
      bar.appendChild(del);
    }
    wrap.appendChild(bar);

    const box = mk("div", "comments");
    box.hidden = true;
    const list = mk("div", "comment-list");
    const form = mk("form", "shot-add");
    form.autocomplete = "off";
    const input = document.createElement("input");
    input.className = "field";
    input.maxLength = 200;
    input.placeholder = "Write a kind, useful comment";
    input.setAttribute("aria-label", "Write a comment");
    const send = mk("button", "secondary", "Send");
    send.type = "submit";
    form.appendChild(input);
    form.appendChild(send);
    form.onsubmit = async function (e) {
      e.preventDefault();
      const text = input.value.trim().slice(0, 200);
      if (!text) return;
      send.disabled = true;
      try {
        await addDoc(collection(db, "posts", id, "comments"), { owner: user.uid, authorName: myName(), text: text, createdAt: serverTimestamp() });
        input.value = "";
        await loadComments(id, data.owner, list);
      } catch (err) { say("Couldn't send your comment."); }
      send.disabled = false;
    };
    box.appendChild(list);
    box.appendChild(form);
    wrap.appendChild(box);
    cBtn.onclick = function () {
      box.hidden = !box.hidden;
      cBtn.setAttribute("aria-expanded", box.hidden ? "false" : "true");
      if (!box.hidden) loadComments(id, data.owner, list);
    };
    return wrap;
  }

  async function loadFeed() {
    const out = $("feedList");
    if (!user) { out.textContent = ""; say("Sign in with Google to see the Community feed."); return; }
    if (loading) return;
    loading = true;
    say("Loading…");
    try {
      const snap = await getDocs(query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(20)));
      const likes = await Promise.all(snap.docs.map(function (d) {
        return getDocs(collection(db, "posts", d.id, "likes")).then(function (s) { return s.docs; }).catch(function () { return []; });
      }));
      out.textContent = "";
      snap.docs.forEach(function (d, i) { out.appendChild(renderPost(d.id, d.data(), likes[i])); });
      say(snap.empty ? "No posts yet. Be the first: open the Showcase tab and tap Post to feed on a piece." : "");
    } catch (e) {
      out.textContent = "";
      say("Couldn't load the feed. Check your connection, and that the Community rules are published in Firebase.");
    }
    loading = false;
  }

  $("feedRefresh").onclick = loadFeed;
  $("tab-community").addEventListener("click", loadFeed);

  onAuthStateChanged(getAuth(), async function (u) {
    user = u || null;
    admin = false;
    if (user) {
      try { admin = (await getDoc(doc(db, "admins", user.uid))).exists(); } catch (e) {}
    }
    refreshApp();
    if (!$("panel-community").hidden) loadFeed();
  });
}
