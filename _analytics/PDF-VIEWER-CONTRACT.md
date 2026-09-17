# Worker integration

The production Worker integrates these modules with its known-document allowlist
and private engagement reports.

## Routes and exports

- `src/pdf-viewer.mjs` exports `pdfViewerResponse(path, measurementId,
  trackingEnabled = true, diagnosticId = ''): Response`. The Worker must allowlist canonical PDF
  paths and invoke it only for browser GET navigation. Invalid paths throw.
  `measurementId` is reserved and intentionally unused: no browser GA event.
- `isPdfNavigation(request)` accepts GET requests explicitly accepting HTML,
  including browsers without Fetch Metadata. Explicit non-navigation destinations
  or modes, range requests, and HTML with quality zero are excluded. The Worker
  separately preserves bots, unknown document paths and explicit raw URLs.
- Serve the default string export of `src/engagement-client.mjs` at
  `/__analytics/engagement.js` with JavaScript content type. It installs
  `window.acwStartEngagement({id, path, kind})`, returning `{download(), stop()}`.
  Use kind `page_view` or `pdf_view`. Invoke after the corresponding view POST
  returns OK, so the backend's visitor cookie and session exist first. The helper
  never creates or edits cookies, uses storage, forwards GA, or collects IPs.
- Bind Wrangler ASSETS to `_analytics/viewer-assets`. Route `/__pdfjs/*` to ASSETS
  after stripping `/__pdfjs` from the pathname (e.g. `/__pdfjs/build/pdf.mjs` ->
  `/build/pdf.mjs`). Pass through correct MIME types, especially `.mjs` and `.wasm`.
  The Worker must run before asset handling on this prefix when doing rewriting.
- Do not render `/__pdfjs/web/viewer.html` as the navigation entry point. Render
  the original known `.pdf` URL with `pdfViewerResponse`. The adapted HTML base is
  `/__pdfjs/web/`; PDF fetching uses `path + '?__pdf=raw'`. Location and hash remain
  the original document URL. The query `file` cannot replace the selected PDF.
  The integration adds `X-ACW-PDF-Viewer: 1` only to this document's PDF.js
  loading options. The Worker excludes marked raw byte fetches from view counts,
  even without Fetch Metadata; the rendered acknowledgement owns the view event.
- Raw PDF handling, HEAD/robots/non-browser behavior, cookies, known-path
  selection, and the Worker-side GA view remain the caller's responsibility.

## View and engagement protocol

On the first successful page render while visible, the viewer POSTs
`/__analytics/event` with `{kind:'pdf_view', id, path,
referrer, source, medium, campaign}`. Referrer is an origin or empty string;
campaigns use the existing sanitized UTM rules. A single ID survives retries,
focus changes, and BFCache. The Worker creates the view row and engagement
session with that same ID. No synthetic GA page view is emitted by the viewer.
The ID comes from the server's diagnostic meta tag when present, otherwise a
fresh random UUID. Diagnostic requests to `/__analytics/pdf-diagnostic` report
startup, rendering, and at most one fixed error code. They require the matching
visitor cookie, respect privacy opt-outs, and never create view events. The
separate diagnostic row records the routing decision even without JavaScript.
Private history reports distinguish `untracked` (no session), `no_updates`
(session without accepted checkpoints), `outside_period` (checkpoints only outside
the selected dates), and `tracked` (checkpoints in the selected dates). Time and
download fields are omitted when no checkpoints exist in the selected dates;
zero is reserved for a received zero-valued measurement.

Engagement POSTs to `/__analytics/engagement` contain:

```
{id, seq, active, milliseconds, downloads, at,
 hours:[{hour, milliseconds, downloads}]}
```

`hour` is epoch seconds rounded down to a UTC hour. Every payload contains all
accumulated session buckets; sums equal global counters. Milliseconds are
integer cumulative engaged time, measured using monotonic 1-second samples only
while visible and focused, with no inactivity cutoff. Gaps over 5 seconds and
wall-clock discontinuities are discarded. Intervals crossing an hour boundary
are split at that boundary; each hour is capped at 3,600,000 ms. Clock changes
can undercount, intentionally. These are unverified client telemetry.

An initial zero-counter snapshot includes the current UTC hour immediately on
helper startup, with the current active state. Checkpoints occur every five
additional engaged minutes. Blur, hide, pagehide,
download, explicit stop, and resume also send cumulative state. `active` is the
state after that transition, not a claim about an unsampled future interval.
Fetch uses keepalive; a failed request retries at most twice, with the identical
body/sequence. A backend should take per-hour maxima and reject stale sequence
numbers for session state. Network delivery at browser termination is best effort.

At a 129th distinct UTC hour, the helper sends the complete old session with
`active:false`, then starts a new view with a fresh ID (`engagement:true`) and
waits for OK before starting its next tracker. New-view kind is preserved; this
is the sole automatic session/view rotation. A failed rotation stops tracking
and logs a warning rather than truncating old buckets. The original returned
handle delegates to the successor. Rotation uses empty campaign fields and an
origin-only referrer. 128 buckets fit within the 16,384-byte body limit.

Both modules honor DNT, GPC, and `__Host-acw_ignore=1` (also checked during
tracking/retries). The personal cookie does not suppress recording. With
`trackingEnabled=false`, all viewer functionality remains, but there are no
analytics requests and the helper script is not loaded.

`download()` also accepts an optional action-time epoch-millisecond argument for
the viewer's internal acknowledgement queue, so a download queued across midnight
is attributed to its original action hour rather than the acknowledgement hour.
Downloads mean native toolbar/keyboard download requests, not confirmed disk
saves. Native `download` event sources are filtered; print, annotation saves,
and key autorepeat do not increment. PDF annotation editing, scripting, local
file opening, file drops, and file-query overrides are disabled. Reading,
selection, search, thumbnails, navigation, zoom, print, and download are native
PDF.js features using native icons and localization.

JavaScript-disabled browsers get a concise `Open original PDF` link. Document,
page-render, and module-load failures expose the same raw-PDF link in an
error-only notice; normal viewing has no added notice.

## Verification

`node --test tests/engagement-client.test.mjs tests/pdf-viewer.test.mjs`

For the existing local Chrome and bundled Playwright runtime:

```sh
PLAYWRIGHT_MODULE=/Users/andrewmyers/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
PLAYWRIGHT_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node --test tests/pdf-viewer-browser.test.mjs
```

Run `node scripts/pdf-viewer-preview.mjs` and open
`http://127.0.0.1:8799/preview.pdf#page=2&zoom=100` for manual preview. Set `PORT`
to another port if needed. Add `?tracking=off` to test the privacy-disabled viewer.
Use `?diagnostics=on` to include mock diagnostic signals in the preview's events.

The optional real-browser smoke test is documented in its new test file. The
standalone preview script uses mock local analytics and a real bundled PDF, not
the production Worker or database. Nothing is deployed by these scripts.
