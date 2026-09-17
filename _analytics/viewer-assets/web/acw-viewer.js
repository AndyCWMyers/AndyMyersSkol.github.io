/* Site integration for the pinned PDF.js generic viewer. No PDF parsing here. */
(() => {
  "use strict";
  const path = document.querySelector('meta[name="acw-pdf-path"]').content;
  const tracking = document.querySelector('meta[name="acw-tracking"]').content === "true";
  const rawURL = path + "?__pdf=raw";
  let rendered = false, starting = false, tracker = null;
  const queuedDownloads = [];
  let attempts = 0, retryTimer, id;

  function allowed() {
    return tracking && !navigator.globalPrivacyControl && navigator.doNotTrack !== "1" &&
      window.doNotTrack !== "1" && navigator.msDoNotTrack !== "1" &&
      !(document.cookie || "").split(";").some(part => part.trim() === "__Host-acw_ignore=1");
  }

  async function start() {
    if (!rendered || starting || tracker || attempts >= 3 || !allowed() || document.visibilityState !== "visible") return;
    starting = true;
    attempts++;
    id ||= crypto.randomUUID();
    const query = new URL(location.href).searchParams;
    const campaign = key => (query.get(key) || "").replace(/[^a-zA-Z0-9_. -]/g, "").slice(0, 100);
    let referrer = "";
    try { referrer = new URL(document.referrer).origin; } catch {}
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch("/__analytics/event", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "text/plain" }, keepalive: true, signal: controller.signal,
        body: JSON.stringify({ kind: "pdf_view", id, path, referrer,
          source: campaign("utm_source"), medium: campaign("utm_medium"), campaign: campaign("utm_campaign") }) });
      if (response.ok && allowed()) {
        tracker = window.acwStartEngagement({ id, path, kind: "pdf_view" });
        for (const at of queuedDownloads) tracker.download(at);
        queuedDownloads.length = 0;
      }
    } catch {} finally {
      clearTimeout(timeout);
      starting = false;
      if (!tracker && attempts < 3 && allowed()) retryTimer = setTimeout(start, 1000 * 2 ** (attempts - 1));
    }
  }

  function onDownload({ source }) {
    const app = window.PDFViewerApplication;
    // Native toolbar and keyboard dispatch once per action; internal saves do not.
    if (!allowed() || !app.pdfDocument || ![window, app.toolbar, app.secondaryToolbar].includes(source)) return;
    if (tracker) tracker.download();
    else { queuedDownloads.push(Date.now()); void start(); }
  }

  function onKeydown(event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === "o" || (event.key.toLowerCase() === "s" && event.repeat)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function blockLocalFile(event) {
    if (event.type === "drop" || event.target.type === "file") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function configure() {
    const app = window.PDFViewerApplication;
    window.PDFViewerApplicationOptions.setAll({
      defaultUrl: rawURL, disablePreferences: true, annotationEditorMode: -1,
      annotationMode: 1, enableScripting: false, enableComment: false,
      enableSignatureEditor: false, enableAltText: false, enableAltTextModelDownload: false,
      enableGuessAltText: false, enableHighlightFloatingButton: false,
      enableMerge: false, enableSplitMerge: false, enableNova: false,
      viewerCssTheme: 1, viewOnLoad: 1, historyUpdateUrl: false,
      workerSrc: "/__pdfjs/build/pdf.worker.mjs", cMapUrl: "/__pdfjs/web/cmaps/",
      standardFontDataUrl: "/__pdfjs/web/standard_fonts/", wasmUrl: "/__pdfjs/web/wasm/",
      iccUrl: "/__pdfjs/web/iccs/", imageResourcesPath: "/__pdfjs/web/images/",
      sandboxBundleSrc: "/__pdfjs/build/pdf.sandbox.mjs",
    });
    app.initializedPromise.then(() => {
      app.eventBus.on("pagerendered", event => {
        if (event.error) { showError(); return; }
        if (event.cssTransform) return;
        rendered = true;
        void start();
      });
      app.eventBus.on("download", onDownload);
      app.eventBus.on("documenterror", showError);
    }).catch(showError);
  }

  function showError() {
    const message = document.querySelector("#acwPdfError");
    if (message) message.hidden = false;
    else document.addEventListener("DOMContentLoaded", showError, { once: true });
    tracker?.stop();
  }

  function onScriptError(event) {
    if (event.target?.tagName === "SCRIPT" && event.target.src.includes("/__pdfjs/")) showError();
  }

  document.addEventListener("webviewerloaded", configure, { once: true });
  document.addEventListener("visibilitychange", start);
  window.addEventListener("pageshow", start);
  window.addEventListener("pagehide", () => clearTimeout(retryTimer));
  window.addEventListener("keydown", onKeydown, { capture: true });
  document.addEventListener("drop", blockLocalFile, { capture: true });
  document.addEventListener("change", blockLocalFile, { capture: true });
  window.addEventListener("error", onScriptError, { capture: true });
})();
