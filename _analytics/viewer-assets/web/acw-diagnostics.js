/* Small pre-module bootstrap: retain a raw-PDF escape hatch even if the viewer fails. */
(function () {
  "use strict";
  var meta = document.querySelector('meta[name="acw-pdf-diagnostic"]');
  var tracking = document.querySelector('meta[name="acw-tracking"]');
  var id = meta ? meta.content : "";
  var sent = {}, rendered = false, timer, visibleSince = 0, remaining = 60000;

  function allowed() {
    return tracking && tracking.content === "true" && /^[0-9a-f-]{36}$/.test(id) && !navigator.globalPrivacyControl &&
      navigator.doNotTrack !== "1" && window.doNotTrack !== "1" && navigator.msDoNotTrack !== "1" &&
      !(document.cookie || "").split(";").some(function (part) { return part.trim() === "__Host-acw_ignore=1"; });
  }

  function fallback() {
    var element = document.querySelector("#acwPdfError");
    if (element) element.hidden = false;
    else document.addEventListener("DOMContentLoaded", fallback, { once: true });
  }

  function signal(stage, code, status) {
    if (stage === "rendered") { rendered = true; clearTimeout(timer); }
    if (!allowed() || sent[stage] || typeof fetch !== "function") return;
    sent[stage] = true;
    function send(attempt) {
      if (!allowed()) return;
      fetch("/__analytics/pdf-diagnostic", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "text/plain" }, keepalive: true,
        body: JSON.stringify({ id: id, stage: stage, code: code || "", status: status || 0 })
      }).then(function (response) {
        if ((response.status === 404 || response.status >= 500) && attempt < 2)
          setTimeout(function () { send(attempt + 1); }, 1000 * (attempt + 1));
      }).catch(function () {
        if (attempt < 2) setTimeout(function () { send(attempt + 1); }, 1000 * (attempt + 1));
      });
    }
    send(0);
  }

  function fail(code) {
    if (rendered) return;
    clearTimeout(timer);
    fallback();
    signal("error", code);
  }

  function ownScript(url) {
    // Do not capture extension errors or third-party assessment failures.
    return typeof url === "string" && /\/__(?:pdfjs|analytics)\//.test(url);
  }

  function onError(event) {
    if (event.target && event.target.tagName === "SCRIPT" && ownScript(event.target.src)) fail("script_error");
    else if (ownScript(event.filename)) fail("runtime_error");
  }

  function onRejection(event) {
    if (!rendered && ownScript(event.reason && event.reason.stack)) fail("promise_error");
  }

  function watch() {
    clearTimeout(timer);
    if (visibleSince) remaining = Math.max(0, remaining - (Date.now() - visibleSince));
    visibleSince = 0;
    if (rendered || document.visibilityState !== "visible") return;
    visibleSince = Date.now();
    timer = setTimeout(function () { fail("startup_timeout"); }, remaining);
  }

  window.acwPdfDiagnostic = { signal: signal };
  if (typeof Promise !== "function" || typeof Promise.withResolvers !== "function") fail("unsupported_browser");
  window.addEventListener("error", onError, true);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("pagehide", function () { clearTimeout(timer); visibleSince = 0; });
  window.addEventListener("pageshow", watch);
  document.addEventListener("visibilitychange", watch);
  watch();
})();
