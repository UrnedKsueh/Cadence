// Community feed: signed-in students post finished work, like and comment. Loads after cloud.js.
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, query, orderBy, limit, getDocs, addDoc, updateDoc, arrayUnion, arrayRemove, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { avatarFor, avatarEl, getProfile, paintAva } from "./avatars.js";

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
  function paintComposerAva() {
    const slot = form.querySelector(".c-ava");
    slot.textContent = "";
    if (!user) return;
    const el = avatarEl(null, "", myName()); slot.appendChild(el);
    getProfile(user.uid).then(function (p) { if (p) paintAva(el, p, myName()); });
  }
  document.addEventListener("cadence:profile", function () { if (typeof paintComposerAva === "function") paintComposerAva(); });
  function tappable(el, uid, name) {
    el.classList.add("tap"); el.tabIndex = 0; el.setAttribute("role", "button");
    el.setAttribute("aria-label", "View " + name + "'s profile"); el.removeAttribute("aria-hidden");
    const go = function () { if (window.CadenceProfile) window.CadenceProfile.open(uid, name); };
    el.onclick = go;
    el.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    return el;
  }
  function say(text) { document.querySelectorAll(".feed-msg").forEach(function (n) { n.textContent = text; }); }
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
        alert("Posted. Find it in the Community section on your Home tab.");
      } catch (e) { alert("Couldn't post. Check your connection and that the new rules are published."); }
    },
    unpost: async function (showId) {
      const id = posted()[showId];
      if (!user || !id || !confirm("Remove this piece from the Community feed?")) return;
      try {
        // An admin may have removed the post already, so just clear the button
        const stillThere = (await getDoc(doc(db, "posts", id))).exists();
        if (stillThere) await deleteDoc(doc(db, "posts", id));
        const map = posted(); delete map[showId]; savePosted(map);
        refreshApp();
      } catch (e) { alert("Couldn't remove it. Try again."); }
    }
  };

  async function loadComments(postId, postOwner, list, onReply) {
    if (!list.childNodes.length) list.appendChild(mk("p", "hint", "Loading comments…"));
    let snap;
    try { snap = await getDocs(query(collection(db, "posts", postId, "comments"), orderBy("createdAt"), limit(40))); }
    catch (e) { list.textContent = ""; list.appendChild(mk("p", "hint", "Couldn't load comments.")); return; }
    list.textContent = "";
    if (snap.empty) list.appendChild(mk("p", "hint", "No comments yet. Be the first."));
    // Replies sit right under the comment they answer
    const all = snap.docs.map(function (d) { return { id: d.id, c: d.data() }; });
    const ids = {};
    all.forEach(function (x) { ids[x.id] = true; });
    const tops = all.filter(function (x) { return !x.c.replyId || !ids[x.c.replyId]; });
    const ordered = [];
    tops.forEach(function (t) {
      ordered.push({ x: t, reply: false });
      all.forEach(function (r) { if (r.c.replyId === t.id) ordered.push({ x: r, reply: true }); });
    });
    const frag = document.createDocumentFragment();
    ordered.forEach(function (o) {
      const d = o.x, c = o.x.c;
      const row = mk("div", "comment" + (o.reply ? " is-reply" : ""));
      const cName = String(c.authorName || "A student").slice(0, 40);
      const ava = c.owner ? tappable(avatarFor(c.owner, cName, "c-pic"), c.owner, cName) : avatarEl(null, "c-pic", cName);
      const body = mk("div", "c-text-wrap");
      const meta = mk("div", "c-meta");
      meta.appendChild(c.owner ? tappable(mk("strong", "", cName), c.owner, cName) : mk("strong", "", cName));
      meta.appendChild(mk("small", "hint", ago(c.createdAt)));
      body.appendChild(meta);
      const text = mk("p", "c-text");
      if (o.reply && c.replyName) text.appendChild(mk("span", "c-replyto", "@" + String(c.replyName).slice(0, 40) + " "));
      text.appendChild(document.createTextNode(String(c.text || "").slice(0, 200)));
      body.appendChild(text);

      // Actions: heart, reply, delete
      const likes = Array.isArray(c.likes) ? c.likes.slice() : [];
      let liked = !!user && likes.indexOf(user.uid) >= 0;
      let count = likes.length;
      const acts = mk("div", "c-acts");
      const heart = mk("button", "c-act", "");
      heart.type = "button";
      function paintHeart() {
        heart.textContent = (liked ? "♥ " : "♡ ") + (count || "");
        heart.classList.toggle("on", liked);
        heart.setAttribute("aria-pressed", liked ? "true" : "false");
        heart.setAttribute("aria-label", (liked ? "Unlike" : "Like") + " comment, " + count + (count === 1 ? " like" : " likes"));
      }
      paintHeart();
      heart.onclick = async function () {
        if (!user) return;
        const was = liked;
        liked = !was; count += was ? -1 : 1; paintHeart();
        try {
          await updateDoc(doc(db, "posts", postId, "comments", d.id), { likes: was ? arrayRemove(user.uid) : arrayUnion(user.uid) });
        } catch (e) { liked = was; count += was ? 1 : -1; paintHeart(); say("Couldn't save your like. Make sure the updated rules are published."); }
      };
      acts.appendChild(heart);
      const reply = mk("button", "c-act", "Reply");
      reply.type = "button";
      reply.setAttribute("aria-label", "Reply to " + cName);
      reply.onclick = function () { onReply({ id: o.reply ? c.replyId : d.id, name: cName }); };
      acts.appendChild(reply);
      if (user && (c.owner === user.uid || postOwner === user.uid || admin)) {
        const del = mk("button", "c-act danger", "Delete");
        del.type = "button";
        del.setAttribute("aria-label", "Delete comment by " + cName);
        del.onclick = async function () {
          if (!confirm("Delete this comment?")) return;
          try { await deleteDoc(doc(db, "posts", postId, "comments", d.id)); await loadComments(postId, postOwner, list, onReply); }
          catch (e) { say("Couldn't delete the comment."); }
        };
        acts.appendChild(del);
      }
      body.appendChild(acts);
      row.appendChild(ava);
      row.appendChild(body);
      frag.appendChild(row);
    });
    list.appendChild(frag);
  }

  // One shared listener closes any open "..." menu
  document.addEventListener("click", function () {
    document.querySelectorAll(".post-menu:not([hidden])").forEach(function (m) {
      m.hidden = true;
      const b = m.previousElementSibling; if (b) b.setAttribute("aria-expanded", "false");
    });
  });

  function renderPost(id, data, likes) {
    const wrap = mk("article", "post");
    const head = mk("div", "post-head has-ava");
    const aName = String(data.authorName || "A student").slice(0, 40);
    const ava = tappable(avatarFor(data.owner, aName, "post-ava"), data.owner, aName);
    const who = mk("div", "post-who");
    who.appendChild(tappable(mk("strong", "", aName), data.owner, aName));
    who.appendChild(mk("small", "hint", ago(data.createdAt)));
    head.appendChild(ava);
    head.appendChild(who);
    if (data.owner === user.uid || admin) {
      const mbtn = mk("button", "post-menu-btn", "");
      mbtn.type = "button";
      mbtn.setAttribute("aria-label", "Post options");
      mbtn.setAttribute("aria-haspopup", "menu");
      mbtn.setAttribute("aria-expanded", "false");
      mbtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
      const menu = mk("div", "post-menu");
      menu.setAttribute("role", "menu");
      menu.hidden = true;
      const del = mk("button", "post-menu-item danger", "Delete post");
      del.type = "button";
      del.setAttribute("role", "menuitem");
      del.onclick = async function (e) {
        e.stopPropagation();
        menu.hidden = true;
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
        } catch (err) { say("Couldn't delete the post."); }
      };
      menu.appendChild(del);
      mbtn.onclick = function (e) {
        e.stopPropagation();
        const open = menu.hidden;
        document.querySelectorAll(".post-menu:not([hidden])").forEach(function (m) { m.hidden = true; });
        menu.hidden = !open;
        mbtn.setAttribute("aria-expanded", open ? "true" : "false");
      };
      menu.onclick = function (e) { e.stopPropagation(); };
      head.appendChild(mbtn);
      head.appendChild(menu);
    }
    wrap.appendChild(head);
    const item = S.itemsFrom([data])[0];
    if (item) {
      const card = S.card(item); wrap.appendChild(card);
      const tile = card.querySelector(".proj-tile");
      if (tile) tile.remove();
    }
    if (typeof data.image === "string" && data.image.indexOf("data:image/jpeg;base64,") === 0 && data.image.length <= 250000) {
      const pic = mk("img", "post-img");
      pic.src = data.image; pic.alt = "Photo in post by " + String(data.authorName || "a student").slice(0, 40);
      pic.loading = "lazy";
      pic.onclick = function () {
        const ov = mk("div", "zoom");
        const big = mk("img", "");
        big.src = data.image; big.alt = pic.alt;
        ov.appendChild(big);
        ov.onclick = function () { ov.remove(); };
        document.body.appendChild(ov);
      };
      wrap.appendChild(pic);
    }

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

    wrap.appendChild(bar);

    const box = mk("div", "comments");
    box.hidden = true;
    const list = mk("div", "comment-list");
    let replyTo = null;
    const chip = mk("div", "c-replying");
    chip.hidden = true;
    const chipText = mk("span", "", "");
    const chipX = mk("button", "c-act", "Cancel");
    chipX.type = "button";
    chip.appendChild(chipText); chip.appendChild(chipX);
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
        const body = { owner: user.uid, authorName: myName(), text: text, createdAt: serverTimestamp() };
        if (replyTo) { body.replyId = replyTo.id; body.replyName = replyTo.name; }
        await addDoc(collection(db, "posts", id, "comments"), body);
        input.value = "";
        setReply(null);
        await loadComments(id, data.owner, list, setReply);
      } catch (err) { say("Couldn't send your comment."); }
      send.disabled = false;
    };
    function setReply(t) {
      replyTo = t;
      chip.hidden = !t;
      chipText.textContent = t ? "Replying to " + t.name : "";
      input.placeholder = t ? "Write a reply" : "Write a kind, useful comment";
      if (t) input.focus();
    }
    chipX.onclick = function () { setReply(null); };
    box.appendChild(list);
    box.appendChild(chip);
    box.appendChild(form);
    wrap.appendChild(box);
    cBtn.onclick = function () {
      box.hidden = !box.hidden;
      cBtn.setAttribute("aria-expanded", box.hidden ? "false" : "true");
      if (!box.hidden) loadComments(id, data.owner, list, setReply);
    };
    return wrap;
  }

  async function loadFeed() {
    const out = document.querySelector(".home-feed-list");
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
      say(snap.empty ? "No posts yet. Be the first to post above." : "");
    } catch (e) {
      out.textContent = "";
      say("Couldn't load the feed. Check your connection, and that the Community rules are published in Firebase.");
    }
    loading = false;
  }

  // Post box. Uses the same fields as Showcase posts, so the published rules accept it unchanged.
  const form = document.querySelector(".composer");
  const q = function (c) { return form.querySelector(c); };
  // Photo: one image per post, shrunk on the phone (about 1024px, around 150 KB) and stored inside the post.
  const MAX_IMG_CHARS = 200000;
  let photo = "";
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { reject(new Error("type")); return; }
      if (file.size > 20 * 1024 * 1024) { reject(new Error("big")); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("read")); };
      img.onload = function () {
        URL.revokeObjectURL(url);
        let max = 1024, quality = 0.8;
        for (let i = 0; i < 12; i++) {
          const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          const cv = document.createElement("canvas");
          cv.width = Math.max(1, Math.round(img.naturalWidth * k));
          cv.height = Math.max(1, Math.round(img.naturalHeight * k));
          const cx = cv.getContext("2d");
          cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
          cx.drawImage(img, 0, 0, cv.width, cv.height);
          const out = cv.toDataURL("image/jpeg", quality);
          if (out.length <= MAX_IMG_CHARS) { resolve(out); return; }
          if (quality > 0.5) quality -= 0.1; else max = Math.round(max * 0.8);
        }
        reject(new Error("big"));
      };
      img.src = url;
    });
  }
  function setPhoto(data) {
    photo = data || "";
    q(".c-preview").hidden = !photo;
    if (photo) q(".c-preview img").src = photo; else q(".c-preview img").removeAttribute("src");
    q(".c-pick").textContent = photo ? "Change photo" : "Add photo";
  }
  function setLinkOpen(open) {
    q(".c-link").hidden = !open;
    q(".c-linkbtn").setAttribute("aria-expanded", open ? "true" : "false");
    q(".c-linkbtn").textContent = open ? "Hide link" : "Add link";
  }
  q(".c-linkbtn").onclick = function () {
    const open = q(".c-link").hidden;
    setLinkOpen(open);
    if (open) q(".c-link").focus();
  };
  function grow() { const t = q(".c-body"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight + 2, 200) + "px"; }
  q(".c-body").addEventListener("input", grow);
  q(".c-pick").onclick = function () { q(".c-file").click(); };
  q(".c-unpick").onclick = function () { setPhoto(""); q(".c-file").value = ""; };
  q(".c-file").onchange = async function () {
    const file = q(".c-file").files && q(".c-file").files[0];
    if (!file) return;
    const msg = q(".c-msg");
    msg.textContent = "Preparing photo…";
    try { setPhoto(await shrink(file)); msg.textContent = ""; }
    catch (err) {
      setPhoto(""); q(".c-file").value = "";
      msg.textContent = err.message === "type" ? "Use a JPG, PNG or WebP photo."
        : err.message === "big" ? "That photo is too big. Try a smaller one." : "Couldn't read that photo.";
    }
  };
  q(".c-body").addEventListener("input", function () { q(".c-count").textContent = q(".c-body").value.length + " / 400"; });
  form.onsubmit = async function (e) {
    e.preventDefault();
    if (!user) return;
    const msg = q(".c-msg");
    const text = q(".c-body").value.trim().slice(0, 400);
    let url = "";
    const raw = q(".c-link").value.trim();
    if (raw) {
      try {
        const u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
        if (u.protocol === "https:" || u.protocol === "http:") url = u.href;
      } catch (err) {}
      if (!url) { msg.textContent = "That link doesn't look right."; return; }
    }
    if (!text && !url && !photo) { msg.textContent = "Write something, add a link or add a photo first."; return; }
    // No title box: the title comes from the first line of the message (or the link's site).
    let title = "", note = text;
    if (text) {
      const first = text.split(/\r?\n/)[0].trim();
      if (first.length <= 80) { title = first; note = text.slice(text.indexOf(first) + first.length).trim(); }
      else { title = first.slice(0, 77).replace(/\s+\S*$/, "").trim() + "…"; }
    } else {
      try { title = new URL(url).hostname.replace(/^www\./, "").slice(0, 80); } catch (err) {}
    }
    if (!title) title = photo ? "Photo" : "Post";
    const btn = q(".c-submit");
    btn.disabled = true;
    msg.textContent = "Posting…";
    try {
      const body = {
        owner: user.uid, authorName: myName(), title: title, course: "", year: "",
        role: "", tools: [], note: note, url: url, createdAt: serverTimestamp()
      };
      if (photo) body.image = photo;
      await addDoc(collection(db, "posts"), body);
      form.reset();
      setPhoto("");
      setLinkOpen(false);
      grow();
      q(".c-count").textContent = "0 / 400";
      msg.textContent = "Posted.";
      loading = false;
      await loadFeed();
    } catch (err) {
      msg.textContent = "Couldn't post. Check your connection and that the Community rules are published.";
    }
    btn.disabled = false;
  };

  function hello() {
    let n = "";
    try { n = (localStorage.getItem("cadence:displayName") || "").trim(); } catch (e) {}
    if (!n && user && user.displayName) n = user.displayName.trim().split(/\s+/)[0];
    $("helloTitle").textContent = "Hello" + (n ? " " + n.slice(0, 40) : "");
  }

  $("feedRefresh").onclick = loadFeed;
  $("tab-home").addEventListener("click", loadFeed);
  document.addEventListener("visibilitychange", function () { if (!document.hidden && user) loadFeed(); });

  onAuthStateChanged(getAuth(), async function (u) {
    user = u || null;
    admin = false;
    if (user) {
      try { admin = (await getDoc(doc(db, "admins", user.uid))).exists(); } catch (e) {}
    }
    form.hidden = !user;
    paintComposerAva();
    hello();
    refreshApp();
    loadFeed();
  });
}
