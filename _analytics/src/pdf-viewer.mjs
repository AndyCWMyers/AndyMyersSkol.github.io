import viewerHTML from "./pdf-viewer-template.mjs";
import { viewerDocuments as documents } from "./documents.mjs";

export function isPdfNavigation(request) {
  return pdfNavigationReason(request) === "viewer";
}

export function pdfNavigationReason(request) {
  if (request.method !== "GET") return "method";
  if (request.headers.has("Range")) return "range_request";
  const destination = request.headers.get("Sec-Fetch-Dest"), mode = request.headers.get("Sec-Fetch-Mode");
  if (destination && !["document", "iframe"].includes(destination)) return "non_document_destination";
  if (mode && mode !== "navigate") return "non_navigation_mode";
  // Explicit document navigation is sufficient even without HTML in Accept.
  if (mode === "navigate" && ["document", "iframe"].includes(destination)) return "viewer";
  // Older browsers may omit Fetch Metadata. Explicit HTML acceptance is sufficient.
  const html = (request.headers.get("Accept") || "").split(",").some(value => {
    const [type, ...parameters] = value.trim().toLowerCase().split(";");
    const quality = parameters.find(parameter => parameter.trim().startsWith("q="));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return type.trim() === "text/html" && q > 0 && q <= 1;
  });
  return html ? "viewer" : "html_not_accepted";
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
export function pdfViewerResponse(path, measurementId, trackingEnabled = true, diagnosticId = "") {
  if (!validPath(path)) throw new TypeError("Expected a canonical, same-origin PDF pathname");
  if (diagnosticId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(diagnosticId)) throw new TypeError("Invalid diagnostic ID");
  const title = documents.find(document => document.name === path)?.title || decodeURIComponent(path.split("/").pop());
  const rawLink = `<a href="${escapeAttribute(path + "?__pdf=raw")}">Open original PDF</a>`;
  const head = `<base href="/__pdfjs/web/" />
    <meta name="citation_title" content="${escapeAttribute(title)}" />
    <meta name="citation_pdf_url" content="${escapeAttribute('https://www.andrewcwmyers.com' + path + '?__pdf=reference')}" />
    <meta name="acw-pdf-path" content="${escapeAttribute(path)}" />
    <meta name="acw-pdf-title" content="${escapeAttribute(title)}" />
    <meta name="acw-tracking" content="${trackingEnabled ? "true" : "false"}" />
    <meta name="acw-pdf-diagnostic" content="${trackingEnabled ? diagnosticId : ""}" />
    <script src="acw-diagnostics.js"></script>
    ${trackingEnabled ? '<script src="/__analytics/engagement.js"></script>' : ""}
    <script src="acw-viewer.js"></script>`;
  const html = viewerHTML
    .replace("<head>", "<head>\n" + head)
    .replace("<title>PDF.js viewer</title>", `<title>${escapeAttribute(title)}</title>`)
    .replace('<body tabindex="0">', `<body tabindex="0">
    <noscript><p class="acwPdfFallback">${rawLink}</p></noscript>
    <p id="acwPdfError" class="acwPdfFallback" role="alert" hidden>PDF preview unavailable. ${rawLink}</p>`)
    .replace("script-src 'self' 'wasm-unsafe-eval';", "script-src 'self' 'wasm-unsafe-eval' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/;")
    .replace("connect-src * blob: data:; base-uri 'none';", "connect-src 'self' blob: data: https://www.google.com/recaptcha/; frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/; base-uri 'self';")
    .replace('<link rel="stylesheet" href="viewer.css" />', '<link rel="stylesheet" href="viewer.css" />\n<link rel="stylesheet" href="acw-viewer.css" />');
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src blob:; font-src 'self' data:; connect-src 'self' blob: data: https://www.google.com/recaptcha/; frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/; base-uri 'self'; form-action 'none'; frame-ancestors 'self'",
  } });
}
