# PDF.js 6.3.289

Official modern generic distribution, obtained September 17, 2026:

- Getting started: https://mozilla.github.io/pdf.js/getting_started/
- Release: https://github.com/mozilla/pdf.js/releases/tag/v6.3.289
- Archive: https://github.com/mozilla/pdf.js/releases/download/v6.3.289/pdfjs-6.3.289-dist.zip
- Release metadata: https://api.github.com/repos/mozilla/pdf.js/releases/tags/v6.3.289
- GitHub release asset ID: 535207711
- Archive SHA-256 (verified against GitHub's asset digest before extraction):
  `98c5832ffe7af4edd59853476a478c0d4d4d76dd49c1701f4c86f7182725cdf9`

The complete archive is retained, including build files, source maps, sample PDF,
native icons, CMaps, standard fonts, ICC profiles, WASM, locales, and licenses.
The only upstream code modification is the marked ACW line in `web/viewer.mjs`:
ignore the `file` query parameter and use the configured `defaultUrl` exclusively
(plus the final newline added by the patch tool).
Source maps are the upstream originals. `web/viewer.html` is unmodified.

Site additions are `web/acw-viewer.js` and `web/acw-viewer.css`.
`../scripts/prepare-pdfjs-template.mjs` mechanically serializes `web/viewer.html`
into a JavaScript string in `../src/pdf-viewer-template.mjs`. It does not build
a replacement viewer or alter the original DOM. Run it when upgrading PDF.js.
`../src/pdf-viewer.mjs` adapts that markup per response.

Do not update only the display or worker module: upgrade the entire release and
review the native event hooks and local-file restrictions with the viewer tests.
