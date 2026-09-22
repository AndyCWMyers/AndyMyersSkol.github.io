/* Site integration for the pinned PDF.js generic viewer. No PDF parsing here. */
(() => {
  "use strict";
  const path = document.querySelector('meta[name="acw-pdf-path"]').content;
  const paperTitle = document.querySelector('meta[name="acw-pdf-title"]')?.content;
  const tracking = document.querySelector('meta[name="acw-tracking"]').content === "true";
  const rawURL = path + "?__pdf=raw";
  const diagnosticValue = document.querySelector('meta[name="acw-pdf-diagnostic"]')?.content || "";
  const diagnosticId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(diagnosticValue) ? diagnosticValue : "";
  let rendered = false, starting = false, tracker = null;
  const queuedDownloads = [];
  let attempts = 0, retryTimer, id;

  function allowed() {
    return tracking && !navigator.globalPrivacyControl && navigator.doNotTrack !== "1" &&
      window.doNotTrack !== "1" && navigator.msDoNotTrack !== "1" &&
      !(document.cookie || "").split(";").some(part => part.trim() === "__Host-acw_ignore=1");
  }

  function diagnose(stage, code = "", status = 0, error) {
    window.acwPdfDiagnostic?.signal(stage, code, status, error);
  }

  async function start() {
    if (!rendered || starting || tracker || attempts >= 3 || !allowed() || document.visibilityState !== "visible") return;
    starting = true;
    attempts++;
    id ||= diagnosticId || crypto.randomUUID();
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
          inbound: window.acwInboundDetails?.(),
          source: campaign("utm_source"), medium: campaign("utm_medium"), campaign: campaign("utm_campaign") }) });
      if (response.ok && allowed()) {
        try { tracker = window.acwStartEngagement({ id, path, kind: "pdf_view" }); }
        catch { diagnose("error", "engagement_start_error"); return; }
        for (const at of queuedDownloads) tracker.download(at);
        queuedDownloads.length = 0;
      } else if (!response.ok && attempts >= 3) diagnose("error", "tracking_http", response.status);
    } catch { if (attempts >= 3) diagnose("error", "tracking_network"); } finally {
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
    // Keep catalog titles instead of PDF metadata or the raw-file URL.
    if (paperTitle) {
      const setTitle = app.setTitle;
      app.setTitle = function () { return setTitle.call(this, paperTitle); };
      app.setTitle();
    }
    const open = app.open;
    app.open = function (args) {
      // Mark internal byte/range fetches even when Fetch Metadata is unavailable.
      if (args.url === rawURL) args = { ...args, httpHeaders: { ...args.httpHeaders, "X-ACW-PDF-Viewer": "1" } };
      return open.call(this, args);
    };
    window.PDFViewerApplicationOptions.setAll({
      defaultUrl: rawURL, disablePreferences: true, annotationEditorMode: -1,
      annotationMode: 1, enableScripting: false, enableComment: false,
      enableSignatureEditor: false, enableAltText: false, enableAltTextModelDownload: false,
      enableGuessAltText: false, enableHighlightFloatingButton: false,
      enableMerge: false, enableSplitMerge: false, enableNova: false,
      viewerCssTheme: 1, viewOnLoad: 1, sidebarViewOnLoad: 0, historyUpdateUrl: false,
      workerSrc: "/__pdfjs/build/pdf.worker.mjs", cMapUrl: "/__pdfjs/web/cmaps/",
      standardFontDataUrl: "/__pdfjs/web/standard_fonts/", wasmUrl: "/__pdfjs/web/wasm/",
      iccUrl: "/__pdfjs/web/iccs/", imageResourcesPath: "/__pdfjs/web/images/",
      sandboxBundleSrc: "/__pdfjs/build/pdf.sandbox.mjs",
    });
    app.initializedPromise.then(() => {
      diagnose("initialized");
      app.eventBus.on("documentloaded", () => diagnose("loaded"));
      app.eventBus.on("pagerendered", event => {
        if (event.error) { showError("render_error", event.error); return; }
        if (event.cssTransform) return;
        if (!rendered) window.acwPdfRenderMs = performance.now();
        rendered = true;
        const message = document.querySelector("#acwPdfError");
        if (message) message.hidden = true;
        diagnose("rendered");
        void start();
      });
      app.eventBus.on("download", onDownload);
      app.eventBus.on("documenterror", event => showError("document_error", event?.reason || event));
    }).catch(error => showError("initialization_error", error));
  }

  function showError(code, error) {
    diagnose("error", code, 0, error);
    const message = document.querySelector("#acwPdfError");
    if (message) message.hidden = false;
    else document.addEventListener("DOMContentLoaded", () => { const message = document.querySelector("#acwPdfError"); if (message) message.hidden = false; }, { once: true });
    tracker?.stop();
  }

  function onScriptError(event) {
    if (event.target?.tagName === "SCRIPT" && /\/__(?:pdfjs|analytics)\//.test(event.target.src)) showError("script_error");
  }

  document.addEventListener("webviewerloaded", () => { try { configure(); } catch (error) { showError("initialization_error", error); } }, { once: true });
  document.addEventListener("visibilitychange", start);
  window.addEventListener("pageshow", start);
  window.addEventListener("pagehide", () => clearTimeout(retryTimer));
  window.addEventListener("keydown", onKeydown, { capture: true });
  document.addEventListener("drop", blockLocalFile, { capture: true });
  document.addEventListener("change", blockLocalFile, { capture: true });
  window.addEventListener("error", onScriptError, { capture: true });
  diagnose("started");
  // Scoring does not start the reading timer or mark the PDF as rendered.
  if (allowed() && diagnosticId) window.acwAssessPdf?.(diagnosticId)?.catch(() => {});
})();
