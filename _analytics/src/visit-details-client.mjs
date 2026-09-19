export default String.raw`function visitDetails(kind) {
    const initialViewport = [window.innerWidth, window.innerHeight];
    return function snapshot() {
      const result = { languages: (navigator.languages || [navigator.language]).slice(0, 5),
        initialViewport, viewport: [window.innerWidth, window.innerHeight] };
      const nav = performance.getEntriesByType?.("navigation")?.[0];
      if (nav) {
        result.navigation = nav.type;
        if (nav.responseStart > 0) result.responseMs = Math.round(nav.responseStart);
        if (nav.domContentLoadedEventEnd > 0) result.domMs = Math.round(nav.domContentLoadedEventEnd);
        if (nav.loadEventEnd > 0) result.loadMs = Math.round(nav.loadEventEnd);
      }
      if (kind !== "page_view" && Number.isFinite(window.acwPdfRenderMs)) result.pdfRenderMs = Math.round(window.acwPdfRenderMs);
      return result;
    };
  }

  function pdfInteractions({ bucket, active, allowed }) {
    const app = window.PDFViewerApplication, bus = app?.eventBus;
    if (!bus?.on) return null;
    const handlers = [];
    let searchTimer;
    function state(item) {
      return item.interactions ||= { searches: 0, prints: 0, outline: 0, zoom: 0 };
    }
    function count(key) {
      if (!active() || !allowed()) return;
      const item = bucket(Date.now());
      if (item) { const value = state(item); value[key] = Math.min(10000, value[key] + 1); }
    }
    function on(name, fn) { bus.on(name, fn); handlers.push([name, fn]); }
    function find(event) {
      if (event.type === "again") { clearTimeout(searchTimer); count("searches"); }
      else if (!event.type) {
        clearTimeout(searchTimer);
        // Debounce typing, retain only a count, never the search text.
        if (event.query?.length) searchTimer = setTimeout(() => count("searches"), 700);
      }
    }
    function outline(event) {
      if (event.isTrusted && event.target?.closest?.("#outlinesView a")) count("outline");
    }
    function zoomKey(event) {
      if (event.isTrusted && !event.repeat && (event.ctrlKey || event.metaKey)
        && ["+", "=", "-", "0"].includes(event.key)) count("zoom");
    }
    on("find", find);
    on("beforeprint", () => count("prints"));
    on("zoomin", () => count("zoom"));
    on("zoomout", () => count("zoom"));
    on("scalechanged", () => count("zoom"));
    document.addEventListener("click", outline);
    window.addEventListener("keydown", zoomKey);
    return { initialize: state, detach() {
      clearTimeout(searchTimer);
      for (const [name, fn] of handlers) bus.off(name, fn);
      document.removeEventListener("click", outline);
      window.removeEventListener("keydown", zoomKey);
    } };
  }`;
