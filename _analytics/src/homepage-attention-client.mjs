export default String.raw`function homepageAttention({ bucket, active, allowed }) {
    const nodes = Array.from(document.querySelectorAll?.("[data-acw-section]") || []);
    if (!nodes.length) return null;
    const candidates = new Set(nodes), details = [];
    let lastScroll = window.scrollY;
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) candidates.add(entry.target);
        else candidates.delete(entry.target);
      }
    }) : null;

    function visible(node) {
      const rect = node.getBoundingClientRect();
      const height = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
      const width = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
      return rect.height > 0 && width > 0 && height >= Math.min(rect.height, window.innerHeight) / 2;
    }

    function state(item) {
      if (!item.attention) item.attention = { depth: 0, scrolled: 0, sections: 0, items: [] };
      return item.attention;
    }

    function metrics(value, id) {
      let row = value.items.find(row => row[0] === id);
      if (!row) { row = [id, 0, 0, 0]; value.items.push(row); value.items.sort((a, b) => a[0] - b[0]); }
      return row;
    }

    function depth(value) {
      const height = document.documentElement.scrollHeight;
      if (height > 0) value.depth = Math.max(value.depth, Math.min(100, Math.max(0, Math.round((window.scrollY + window.innerHeight) / height * 100))));
    }

    function sample(item, span) {
      const value = state(item);
      depth(value);
      for (const node of candidates) {
        const detail = node.querySelector("details");
        const abstract = detail?.open && detail.querySelector(".abstract-text");
        const abstractVisible = Boolean(abstract && visible(abstract));
        if (!visible(node) && !abstractVisible) continue;
        value.sections |= 1 << Number(node.dataset.acwSection);
        if (node.dataset.acwItem) {
          const row = metrics(value, Number(node.dataset.acwItem));
          row[1] += span;
          if (abstractVisible) row[3] += span;
        }
      }
    }

    function scroll() {
      const changed = window.scrollY !== lastScroll;
      lastScroll = window.scrollY;
      if (!changed || !active() || !allowed()) return;
      const item = bucket(Date.now());
      if (item) { const value = state(item); value.scrolled = 1; depth(value); }
    }
    window.addEventListener("scroll", scroll, { passive: true });

    for (const node of nodes) {
      observer?.observe(node);
      const detail = node.dataset.acwItem && node.querySelector("details");
      if (!detail) continue;
      let open = detail.open;
      const toggle = () => {
        const opening = detail.open && !open;
        open = detail.open;
        if (!opening || !active() || !allowed()) return;
        const item = bucket(Date.now());
        if (!item) return;
        const value = state(item), row = metrics(value, Number(node.dataset.acwItem));
        row[2] = Math.min(1000, row[2] + 1);
        // Toggle events update memory only, never trigger a network request.
      };
      detail.addEventListener("toggle", toggle);
      details.push([detail, toggle]);
    }
    // Rotate long homepage sessions before expanded item counters exceed keepalive limits.
    return { maxHours: 64, sample, initialize: state, detach() {
      observer?.disconnect();
      window.removeEventListener("scroll", scroll);
      for (const [detail, toggle] of details) detail.removeEventListener("toggle", toggle);
    } };
  }`;
