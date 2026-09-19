// Optional integration: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs
// node --test tests/pdf-viewer-browser.test.mjs
// Uses the installed browser runtime; adds no dependency to this project.
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPreviewServer } from "../scripts/pdf-viewer-preview.mjs";

test("real generic viewer desktop/mobile: rendering, native controls, hooks, hashes and privacy", {
  skip: !process.env.PLAYWRIGHT_MODULE, timeout: 120000,
}, async () => {
  const engines = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
  const engine = process.env.PLAYWRIGHT_BROWSER || "chromium";
  const browser = await engines[engine].launch({ headless: true,
    ...(engine === "chromium" && process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
  const { server, events } = createPreviewServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1,
        isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
      // Exercise the compatibility build's polyfills, not just a modern browser.
      await context.addInitScript(() => { URL.parse = undefined; Math.sumPrecise = undefined; Uint8Array.fromBase64 = undefined; });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const failures = [], errors = [], requests = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("response", response => { if (response.status() >= 400) failures.push(response.url()); });
      page.on("request", request => requests.push(request.url()));
      await page.goto(base + "/preview.pdf?diagnostics=on&file=%2Fwrong.pdf&utm_source=smoke#page=2&zoom=100");
      try {
        await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer.getPageView(1)?.renderingState === 3);
      } catch (error) {
        console.error({ engine, viewport, errors, failures, diagnostics: events.filter(e => e.endpoint.endsWith("pdf-diagnostic")) });
        throw error;
      }
      await page.waitForFunction(() => document.querySelector("#numPages").textContent.length > 0);
      assert.equal(await page.evaluate(() => window.PDFViewerApplication.page), 2);
      assert.equal(await page.evaluate(() => window.PDFViewerApplication.pdfViewer.currentScale), 1);
      assert.equal(new URL(page.url()).pathname, "/preview.pdf");
      assert.equal(new URL(page.url()).hash, "#page=2&zoom=100");
      assert(requests.some(url => url === base + "/preview.pdf?__pdf=raw"));
      assert(!requests.some(url => new URL(url).pathname === "/wrong.pdf"));
      const pixels = await page.evaluate(() => {
        const canvas = document.querySelector('.page[data-page-number="2"] canvas');
        const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
        let dark = 0;
        for (let i = 0; i < data.length; i += 16) if (data[i] < 160 && data[i + 3] > 0) dark++;
        return dark;
      });
      assert(pixels > 100, "actual PDF content must render, not a blank canvas");
      assert.equal(await page.locator("#editorModeButtons").isVisible(), false);
      await page.locator("#zoomInButton").click();
      await page.waitForFunction(() => window.PDFViewerApplication.pdfViewer.currentScale > 1);
      await page.locator("#zoomOutButton").click();
      await page.waitForFunction(() => window.PDFViewerApplication.pdfViewer.currentScale === 1);
      await page.locator("#pageNumber").fill("3");
      await page.locator("#pageNumber").press("Enter");
      await page.waitForFunction(() => window.PDFViewerApplication.page === 3);
      await page.locator("#viewsManagerToggleButton").click();
      await page.waitForFunction(() => document.querySelectorAll("#thumbnailsView img, #thumbnailsView canvas").length > 0);
      await page.locator("#viewsManagerToggleButton").click();
      await page.locator("#viewFindButton").click();
      await page.locator("#findInput").fill("trace");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.PDFViewerApplication.findController.pageMatches.some(matches => matches?.length));
      await page.keyboard.press("Escape");
      await page.screenshot({ path: join(tmpdir(), `acw-pdf-viewer-${viewport.width}.png`) });
      // Only the visible native toolbar controls are compared; the document may scroll.
      const boxes = await page.locator("#toolbarViewer button:visible, #toolbarViewer input:visible, #toolbarViewer select:visible").evaluateAll(nodes => nodes.map(node => {
        const r = node.getBoundingClientRect(); return { id: node.id, x: r.x, right: r.right, y: r.y, bottom: r.bottom };
      }));
      for (const box of boxes) assert(box.x >= -1 && box.right <= viewport.width + 1, `control outside viewport: ${box.id}`);
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        assert(!(a.x < b.right - 1 && b.x < a.right - 1 && a.y < b.bottom - 1 && b.y < a.bottom - 1), `overlapping controls ${a.id}/${b.id}`);
      }
      const before = events.filter(e => e.endpoint === "/__analytics/event").length;
      assert(before > 0);
      const view = events.filter(e => e.endpoint === "/__analytics/event").at(-1).body;
      assert.equal(view.kind, "pdf_view");
      assert.deepEqual(new Set(events.filter(e => e.endpoint === "/__analytics/pdf-diagnostic" && e.body.id === view.id).map(e => e.body.stage)),
        new Set(["started", "initialized", "loaded", "rendered"]));
      const downloaded = page.waitForEvent("download");
      if (await page.locator("#downloadButton").isVisible()) await page.locator("#downloadButton").click();
      else { await page.locator("#secondaryToolbarToggleButton").click(); await page.locator("#secondaryDownload").click(); }
      await downloaded;
      await page.waitForFunction(() => true);
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(events.filter(e => e.endpoint === "/__analytics/engagement" && e.body.id === view.id).at(-1).body.downloads, 1);
      const shortcut = page.waitForEvent("download");
      await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
      await shortcut;
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(events.filter(e => e.endpoint === "/__analytics/engagement" && e.body.id === view.id).at(-1).body.downloads, 2);
      assert.equal(events.filter(e => e.endpoint === "/__analytics/event").length, before);
      await page.evaluate(() => { window.nativePrintRequests = 0; window.print = () => { window.nativePrintRequests++; }; });
      if (await page.locator("#printButton").isVisible()) await page.locator("#printButton").click();
      else { await page.locator("#secondaryToolbarToggleButton").click(); await page.locator("#secondaryPrint").click(); }
      await page.waitForFunction(() => window.nativePrintRequests === 1);
      assert.equal(events.filter(e => e.endpoint === "/__analytics/engagement" && e.body.id === view.id).at(-1).body.downloads, 2);
      assert.deepEqual(failures, []);
      assert.deepEqual(errors, []);
      await context.close();
    }
    const page = await browser.newPage();
    const analytics = [];
    page.on("request", request => { if (request.url().includes("/__analytics/")) analytics.push(request.url()); });
    await page.goto(base + "/preview.pdf?tracking=off");
    await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer.getPageView(0)?.renderingState === 3);
    assert.deepEqual(analytics, []);
    await page.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
