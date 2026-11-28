(function () {
  "use strict";
  if (!("serviceWorker" in navigator)) return;

  function banner(worker) {
    if (document.getElementById("updateBar")) return;
    const bar = document.createElement("div");
    bar.id = "updateBar";
    bar.setAttribute("role", "status");
    bar.style.cssText = "position:fixed;left:12px;right:12px;bottom:84px;z-index:50;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:12px;background:#7657E8;color:#fff;font:600 14px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35)";
    const msg = document.createElement("span");
    msg.textContent = "A new version of Cadence is ready.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Refresh";
    btn.style.cssText = "border:0;border-radius:8px;padding:8px 14px;font:inherit;background:#191923;color:#fff;cursor:pointer";
    btn.onclick = function () { worker.postMessage("SKIP_WAITING"); };
    bar.appendChild(msg);
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }

  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      if (reg.waiting && navigator.serviceWorker.controller) banner(reg.waiting);
      reg.addEventListener("updatefound", function () {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener("statechange", function () {
          if (w.state === "installed" && navigator.serviceWorker.controller) banner(w);
        });
      });
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) reg.update().catch(function () {});
      });
    }).catch(function () {});

    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  });
})();
