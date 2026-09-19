# PDF.js Distribution

Version: 6.3.289, official legacy (compatibility) distribution.
Source: https://github.com/mozilla/pdf.js/releases/tag/v6.3.289
Archive: pdfjs-6.3.289-legacy-dist.zip
SHA-256: 51683fac4aff7dd31ed91e9ab735a2098a78d50899d1ec529aed6dc8aa19400d

The build modules and viewer module (with their source maps) come from this
archive. Markup, styles, fonts and other assets are shared with the same-version
modern distribution. Retain LICENSE and all upstream license notices.

Local changes: viewer.mjs takes its document only from defaultUrl, never the
file query parameter. acw-*.js/css provide site integration, diagnostics and styling.
The Worker adds the site metadata and CSP in src/pdf-viewer.mjs. Regenerate the
HTML template with scripts/prepare-pdfjs-template.mjs only if upstream markup changes.

When updating, keep viewer and worker versions identical and reapply the file-query
restriction. Run the browser smoke test in Chromium and WebKit with missing modern
APIs to exercise polyfills. Compatibility does not guarantee every old browser works.
