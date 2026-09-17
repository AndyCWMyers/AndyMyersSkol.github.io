// Isolated local preview: native PDF.js plus mock analytics, no production Worker.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pdfViewerResponse } from "../src/pdf-viewer.mjs";
import engagement from "../src/engagement-client.mjs";

const assets = fileURLToPath(new URL("../viewer-assets/", import.meta.url));
const mime = { ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".ftl": "text/plain", ".svg": "image/svg+xml",
  ".png": "image/png", ".wasm": "application/wasm", ".pdf": "application/pdf",
  ".ttf": "font/ttf", ".woff2": "font/woff2", ".html": "text/html" };

export function createPreviewServer() {
  const events = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
      if (request.method === "POST" && url.pathname.startsWith("/__analytics/")) {
        let body = "";
        for await (const part of request) body += part;
        events.push({ endpoint: url.pathname, body: JSON.parse(body) });
        response.writeHead(204, { "Set-Cookie": "preview_visitor=1; Path=/; SameSite=Lax" }).end();
        return;
      }
      if (url.pathname === "/__analytics/engagement.js") {
        response.writeHead(200, { "Content-Type": "text/javascript" }).end(engagement);
        return;
      }
      if (url.pathname === "/preview.pdf" && url.searchParams.get("__pdf") !== "raw") {
        const rendered = pdfViewerResponse("/preview.pdf", "", url.searchParams.get("tracking") !== "off",
          url.searchParams.get("diagnostics") === "on" ? crypto.randomUUID() : "");
        response.writeHead(rendered.status, Object.fromEntries(rendered.headers)).end(await rendered.text());
        return;
      }
      const relative = url.pathname === "/preview.pdf" ? "web/compressed.tracemonkey-pldi-09.pdf" :
        url.pathname.startsWith("/__pdfjs/") ? decodeURIComponent(url.pathname.slice("/__pdfjs/".length)) : "";
      const file = resolve(assets, relative);
      if (!relative || !file.startsWith(assets.endsWith(sep) ? assets : assets + sep)) {
        response.writeHead(404).end();
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream", "Content-Length": body.length }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return { server, events };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { server } = createPreviewServer();
  server.listen(Number(process.env.PORT || 8799), "127.0.0.1", () => {
    console.log(`PDF preview: http://127.0.0.1:${server.address().port}/preview.pdf#page=2&zoom=100`);
  });
}
