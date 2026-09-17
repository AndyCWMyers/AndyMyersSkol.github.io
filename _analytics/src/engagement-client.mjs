// Served verbatim as /__analytics/engagement.js; no bundler/runtime dependencies.
export default String.raw`(() => {
  "use strict";
  const HOUR = 3600000;
  const CHECKPOINT = 300000;
  const MAX_GAP = 5000;
  const MAX_HOURS = 128;
  const noop = { download() {}, stop() {} };

  function allowed() {
    return !navigator.globalPrivacyControl && navigator.doNotTrack !== "1" &&
      window.doNotTrack !== "1" && navigator.msDoNotTrack !== "1" &&
      !(document.cookie || "").split(";").some(part => part.trim() === "__Host-acw_ignore=1");
  }

  // Retries reuse the exact sequence/body. Newer cumulative snapshots may arrive first.
  async function post(endpoint, body, attempt = 0) {
    if (!allowed()) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let ok = false;
    try {
      ok = (await fetch(endpoint, { method: "POST", body, credentials: "same-origin",
        headers: { "Content-Type": "text/plain" }, keepalive: true, signal: controller.signal })).ok;
    } catch {} finally { clearTimeout(timeout); }
    if (ok || attempt >= 2 || !allowed()) return ok;
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    return post(endpoint, body, attempt + 1);
  }

  function startEngagement({ id, path, kind }) {
    if (!allowed() || !id || !path || !kind) return noop;
    let milliseconds = 0, downloads = 0, seq = 0, checkpoint = 0;
    let lastMono = performance.now(), lastWall = Date.now();
    let focused = document.hasFocus(), inPage = true, stopped = false, cancelled = false;
    let wasActive = focused && document.visibilityState === "visible";
    let successor = null, rotating = false;
    const queuedDownloads = [];
    const hours = new Map();
    const listeners = [];
    let timer;

    function active() {
      return !stopped && inPage && focused && document.visibilityState === "visible";
    }

    function bucket(wall) {
      const hour = Math.floor(wall / HOUR) * 3600;
      if (!hours.has(hour)) {
        if (hours.size >= MAX_HOURS) return null;
        hours.set(hour, { hour, milliseconds: 0, downloads: 0 });
      }
      return hours.get(hour);
    }

    function sample() {
      const mono = performance.now(), wall = Date.now();
      const delta = mono - lastMono, wallDelta = wall - lastWall;
      lastMono = mono;
      // Drop suspended timers and clock discontinuities, not entire sleeping intervals.
      if (wasActive && delta >= 0 && delta <= MAX_GAP && wallDelta >= 0 && wallDelta <= MAX_GAP) {
        let remaining = Math.floor(Math.min(delta, wallDelta));
        let cursor = wall - remaining;
        while (remaining > 0) {
          const item = bucket(cursor);
          if (!item) { rotate(); break; }
          const span = Math.min(remaining, (item.hour * 1000 + HOUR) - cursor);
          const credited = Math.min(span, HOUR - item.milliseconds);
          item.milliseconds += credited;
          milliseconds += credited;
          cursor += span;
          remaining -= span;
        }
      }
      lastWall = Math.max(lastWall, wall);
    }

    function save(isActive = active()) {
      if (!allowed()) return;
      checkpoint = milliseconds;
      const body = JSON.stringify({ id, seq: ++seq, active: isActive,
        milliseconds, downloads, at: Date.now(),
        hours: Array.from(hours.values(), item => ({ ...item })).sort((a, b) => a.hour - b.hour) });
      void post("/__analytics/engagement", body);
    }

    function detach() {
      clearInterval(timer);
      for (const [target, event, callback] of listeners) target.removeEventListener(event, callback);
    }

    async function rotate() {
      if (rotating || stopped) return;
      rotating = true;
      stopped = true;
      detach();
      save(false);
      const nextId = crypto.randomUUID();
      const eventKind = kind === "pdf" || kind === "pdf_view" ? "pdf_view" : "page_view";
      let referrer = "";
      try { referrer = new URL(document.referrer).origin; } catch {}
      const ok = await post("/__analytics/event", JSON.stringify({ id: nextId, path,
        kind: eventKind, engagement: true, referrer, source: "", medium: "", campaign: "" }));
      if (ok && !cancelled && allowed()) {
        successor = startEngagement({ id: nextId, path, kind });
        for (const at of queuedDownloads) successor.download(at);
      } else if (!cancelled && allowed()) {
        console.warn("Engagement session rotation failed; tracking stopped without truncating hour buckets.");
      }
      rotating = false;
    }

    function transition(event) {
      if (!allowed()) { stop(false); return; }
      sample();
      if (stopped) return;
      if (event.type === "blur") focused = false;
      if (event.type === "focus") focused = true;
      if (event.type === "pagehide") inPage = false;
      if (event.type === "pageshow") { inPage = true; focused = document.hasFocus(); }
      if (event.type === "visibilitychange" && document.visibilityState === "visible") focused = document.hasFocus();
      wasActive = active();
      save();
      if (event.type === "pagehide" && !event.persisted) { stopped = true; detach(); }
    }

    function tick() {
      if (!allowed()) { stop(false); return; }
      sample();
      focused = document.hasFocus();
      wasActive = active();
      if (!stopped && active() && milliseconds - checkpoint >= CHECKPOINT) save();
    }

    function download(at = Date.now()) {
      if (successor) return successor.download(at);
      if (!allowed()) { stop(false); return; }
      if (rotating) { queuedDownloads.push(at); return; }
      if (stopped) return;
      sample();
      if (rotating) { queuedDownloads.push(at); return; }
      const item = bucket(at);
      if (!item) { queuedDownloads.push(at); void rotate(); return; }
      item.downloads++;
      downloads++;
      save();
    }

    function stop(send = true) {
      cancelled = true;
      if (successor) return successor.stop();
      if (stopped) return;
      if (send && allowed()) sample();
      stopped = true;
      if (send) save(false);
      detach();
    }

    // BFCache hides pause this tracker; pageshow resumes the same id and counters.
    for (const event of ["focus", "blur", "pagehide", "pageshow"]) listeners.push([window, event, transition]);
    listeners.push([document, "visibilitychange", transition]);
    for (const [target, event, callback] of listeners) target.addEventListener(event, callback);
    timer = setInterval(tick, 1000);
    bucket(Date.now());
    save();
    return { download, stop };
  }

  window.acwStartEngagement = startEngagement;
})();`;
