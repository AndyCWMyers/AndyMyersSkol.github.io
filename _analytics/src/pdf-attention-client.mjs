export default String.raw`function pdfAttention({ bucket, active, allowed }) {
    const viewer = window.PDFViewerApplication?.pdfViewer;
    const total = viewer?.pagesCount;
    const container = document.getElementById?.("viewerContainer");
    if (!container || !Number.isInteger(total) || total < 1 || total > 10000) return null;
    const nodes = Array.from({ length: total }, (_, i) => viewer.getPageView(i)?.div).filter(Boolean);
    const candidates = new Set(nodes);
    const elapsed = new WeakMap();
    let top = container.scrollTop, left = container.scrollLeft;
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) candidates.add(entry.target);
        else candidates.delete(entry.target);
      }
    }, { root: container }) : null;

    function state(item) {
      if (!item.pdfAttention) {
        item.pdfAttention = { total, scrolled: 0, pages: Array(Math.ceil(total / 32)).fill(0), seconds: Array(total).fill(0) };
        elapsed.set(item, Array(total).fill(0));
      }
      return item.pdfAttention;
    }

    function sample(item, milliseconds = 0) {
      const value = state(item);
      if (!active() || !allowed()) return;
      const root = container.getBoundingClientRect();
      const visible = [];
      for (const node of candidates) {
        const rect = node.getBoundingClientRect();
        const height = Math.min(rect.bottom, root.bottom) - Math.max(rect.top, root.top);
        const width = Math.min(rect.right, root.right) - Math.max(rect.left, root.left);
        const page = Number(node.dataset.pageNumber) - 1;
        if (!Number.isInteger(page) || page < 0 || page >= total || rect.height <= 0 || width <= 0
          || height < Math.min(rect.height, root.height) / 2) continue;
        value.pages[page >>> 5] = (value.pages[page >>> 5] | (1 << (page % 32))) >>> 0;
        visible.push(page);
      }
      // Split overlapping pages, retaining fractional seconds until checkpoints.
      const times = elapsed.get(item);
      for (const page of visible) {
        times[page] += milliseconds / visible.length;
        value.seconds[page] = Math.floor(times[page] / 1000);
      }
    }

    function scroll() {
      const changed = top !== container.scrollTop || left !== container.scrollLeft;
      top = container.scrollTop; left = container.scrollLeft;
      if (!changed || !active() || !allowed()) return;
      const item = bucket(Date.now());
      if (item) { state(item).scrolled = 1; sample(item); }
    }
    for (const node of nodes) observer?.observe(node);
    container.addEventListener("scroll", scroll, { passive: true });
    // Bound dense page counters plus bitsets below the 64 KiB keepalive limit.
    const maxHours = Math.min(16, Math.max(1, Math.floor(63000 / (total * 5 + Math.ceil(total / 32) * 11 + 200))));
    return { maxHours, initialize: state, sample, detach() {
      observer?.disconnect();
      container.removeEventListener("scroll", scroll);
    } };
  }`;
