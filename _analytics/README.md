# Website Analytics

Cloudflare Worker and D1 deployed September 16, 2026. The private Command Center
Website Analytics dashboard reads these aggregates through its local host.

The Cloudflare Worker proxies the existing GitHub Pages origin. Normal content
and PDF updates still publish through GitHub Pages. No PDF URL or page design
changes. The `_analytics` directory is not published by Jekyll.

## Deployment

1. `npm ci`, then `npm test` and `npm run test:bundle`. The bundle test catches
   transformations that unit tests of the source alone cannot. Bump the script's
   version query in `index.html` when changing the browser collector.
2. Authorize the official Wrangler CLI with Workers, Workers Routes, D1 write,
   account/user/zone read permissions. Store credentials outside the repository.
3. Create a dedicated D1 database, add its DB binding to `wrangler.jsonc`, and
   apply `schema.sql` remotely.
4. Set a cryptographically random `READ_TOKEN` using `wrangler secret put`.
5. Set Cloudflare SSL to Full (strict). Preserve all registrar DNS records.
6. Deploy only after reviewing the routes, then migrate DNS and verify PDFs,
   HTML, byte ranges, redirects, analytics writes, and unauthorized API denial.
7. After the previous nameserver TTL expires, re-enable DNSSEC with Cloudflare's
   new DS record at Squarespace. The migration occurred September 17 at 01:23 UTC;
   the previous NS TTL was 21,600 seconds, so do not publish the new DS before
   September 17 at 07:23 UTC. DNSSEC restoration is scheduled for a one-time
   follow-up at 07:30 UTC (12:30 a.m. Pacific), pending successful completion.

`/__analytics/report` requires a bearer token and returns aggregate reports only.
The Command Center backend, not its browser bundle, holds this read-only token.
There is no SQL endpoint and alternate Workers hostnames are disabled.

## Measurement

- `page_view`: visible HTML page observed by the browser script.
- `page_request`: HTML retrieval through Cloudflare.
- `pdf_request`: successful initial PDF retrieval (200/206/304 when a PDF content
  type is supplied). Nonzero byte ranges are excluded. Anonymous initial-range
  retries can still inflate counts. Cached/offline reads are not observable.
- `pdf_click`: a website link click, distinct from retrieval.
- `outbound_click`: an external HTTP(S) link, including WSJ, without query/hash.

No raw IPs or browser fingerprints are stored. IPs are used only by Cloudflare's
ephemeral rate limiter. DNT/GPC opt-outs are honored by this collector. Browser
and bot classifications are coarse heuristics, not verified human identities.
Referrers are domains only; geographic data is country/region. Only UTM marketing
tags are retained from incoming query strings. Do not put personal data in UTMs.

Existing GTM/GA4 tagging remains in place. Confirmed live property: `465165532`,
stream: `9879831300`, measurement ID: `G-82ZD3DWY3B`. The Worker forwards non-bot,
non-opted-out PDF retrieval starts as GA4 `page_view` events with `content_type`
`pdf`, URL, referral domain, country/region and coarse device/browser metadata.
`GA_API_SECRET` is a Worker secret, never a browser or Git credential.

The browser uses Google's documented `get` command to obtain available GA client
and session IDs for a Secure, SameSite=Lax, 30-minute `__Host-acw_ga` cookie. Direct
PDF visitors without that context receive a random 30-minute `__Host-acw_pdf`
cookie (also HttpOnly). No IP-derived identity is used. These identifiers go to
GA4, not D1. A direct PDF visit is not guaranteed to join later HTML visits or
recover historical acquisition attribution. Advertising use/personalization is
denied for server events. The owner acknowledged the required privacy rights and
disclosures before enabling this integration; this is not a compliance audit.

PDF bytes, ETags and URLs remain unchanged. Eligible PDF responses request browser
revalidation so later online opens can be observed. Native PDF reading time,
scroll depth, offline opens and reliable unique-reader counts are unavailable.
GA4 may not show these events in engagement/realtime metrics because no engagement
duration is invented. The Command Center uses independent Cloudflare aggregates;
GA4 historical reports remain in Google Analytics. GA4 Data API import is not set up.

## Limits And Recovery

Free Workers: 100,000 invocations/day; D1 free quotas also apply. An in-code
analytics failure does not block content; public GET/HEAD requests also use
Cloudflare's exception pass-through to GitHub Pages. This does not protect against
every resource failure: exhaustion of the Worker account
quota can prevent the Worker from running. Remove the two Worker routes to
bypass analytics and continue serving GitHub Pages through Cloudflare. Switching
the records to DNS-only also bypasses Cloudflare after DNS caches expire.

No automatic retention deletion is enabled yet. At this site's current traffic,
review database size before adding retention or archives. Do not claim indefinite
free storage. Export using `wrangler d1 export` to a private location, never Git.
