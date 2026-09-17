import viewerHTML from "./pdf-viewer-template.mjs";

export function isPdfNavigation(request) {
  if (request.method !== "GET" || request.headers.has("Range")) return false;
  const destination = request.headers.get("Sec-Fetch-Dest"), mode = request.headers.get("Sec-Fetch-Mode");
  if (destination && !["document", "iframe"].includes(destination)) return false;
  if (mode && mode !== "navigate") return false;
  // Older browsers may omit Fetch Metadata. Explicit HTML acceptance is sufficient.
  return (request.headers.get("Accept") || "").split(",").some(value => {
    const [type, ...parameters] = value.trim().toLowerCase().split(";");
    const quality = parameters.find(parameter => parameter.trim().startsWith("q="));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return type.trim() === "text/html" && q > 0 && q <= 1;
  });
}

function escapeAttribute(value) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function validPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\\?#\u0000-\u0020\u007f]/.test(path)) return false;
  try {
    const decoded = decodeURIComponent(path);
    return !/[\\\u0000-\u001f\u007f]/.test(decoded) && !decoded.startsWith("//") && /\.pdf$/i.test(decoded) &&
      new URL(path, "https://viewer.invalid").pathname === path;
  } catch { return false; }
}

// The Worker owns the known-document allowlist and chooses browser GETs only.
// measurementId is intentionally unused: the Worker owns the single GA PDF view.
export function pdfViewerResponse(path, measurementId, trackingEnabled = true) {
  if (!validPath(path)) throw new TypeError("Expected a canonical, same-origin PDF pathname");
  const rawLink = `<a href="${escapeAttribute(path + "?__pdf=raw")}">Open original PDF</a>`;
  const head = `<base href="/__pdfjs/web/" />
    <meta name="acw-pdf-path" content="${escapeAttribute(path)}" />
    <meta name="acw-tracking" content="${trackingEnabled ? "true" : "false"}" />
    ${trackingEnabled ? '<script src="/__analytics/engagement.js"></script>' : ""}
    <script src="acw-viewer.js"></script>`;
  const html = viewerHTML
    .replace("<head>", "<head>\n" + head)
    .replace("<title>PDF.js viewer</title>", `<title>${escapeAttribute(decodeURIComponent(path.split("/").pop()))}</title>`)
    .replace('<body tabindex="0">', `<body tabindex="0">
    <noscript><p class="acwPdfFallback">${rawLink}</p></noscript>
    <p id="acwPdfError" class="acwPdfFallback" role="alert" hidden>PDF preview unavailable. ${rawLink}</p>`)
    .replace("connect-src * blob: data:; base-uri 'none';", "connect-src 'self' blob: data:; base-uri 'self';")
    .replace('<link rel="stylesheet" href="viewer.css" />', '<link rel="stylesheet" href="viewer.css" />\n<link rel="stylesheet" href="acw-viewer.css" />');
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src blob:; font-src 'self' data:; connect-src 'self' blob: data:; base-uri 'self'; form-action 'none'; frame-ancestors 'self'",
  } });
}
