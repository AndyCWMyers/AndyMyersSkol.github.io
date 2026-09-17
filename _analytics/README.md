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
   apply `schema.sql` remotely, then `npx wrangler d1 migrations apply DB --remote`.
   On an existing database, apply pending migrations before deploying Worker code.
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

## Own Visits And Distinct Browsers

Open `https://www.andrewcwmyers.com/__analytics/preferences` in each browser/profile
used on the Mac Pro, MacBook Air, and iPhone. Select **Mark as my activity** and save.
The confirmed page must say **This browser is marked as your activity**. Reload open
website tabs. The one-year personal-marker cookie follows that browser across networks,
but clearing cookies, using a private window, or switching browser profiles requires
setting it again. An IP exclusion is deliberately not used: it could exclude other
Stanford/Hoover visitors and would fail when networks change. Choose **Regular visitor**
to unmark a browser, or **Do not record this browser** to stop collection altogether.
The page is never tracked; it needs no account credentials. The Command Center links
to it through **Analytics settings > Set browser exclusion token**. Native app webviews and Safari/
Chrome may have separate cookie stores: use the browser actually used for the site.

Personal activity is retained in D1 with `is_personal=1`, but is not forwarded to
GA4 and does not load GTM. The **Exclude my activity** dashboard switch is a display
filter, enabled by default and remembered locally. It applies to every total, tab,
detail panel, chart and CSV export. Turning it off includes personal activity.
The authenticated report's `excludePersonal=1|0` flag is validated end to end, and
server/offline caches cannot substitute the opposite filter's data.

Marking a browser also registers the SHA-256 hash of its existing random visitor
cookie in `personal_visitors`, allowing previously recorded events with that same
identity to be filtered. No IP, location or browser heuristic is used to guess
ownership. Earlier anonymous events remain unclassified, not deleted. Unmarking
rotates the visitor identity so future regular visits are not silently filtered.
The settings menu reports the number of identified personal events in the period.

**Do not record** retains the original opt-out behavior: no D1 or GA4 activity.
Existing opt-out cookies are not automatically converted into personal recording.
DNT/GPC always stop recording, even for marked personal browsers. Setting a marker
does not restore events that were never collected.

Eligible HTML/PDF requests and browser events receive a random Secure/HttpOnly/SameSite=Lax first-party
`__Host-acw_visitor` cookie lasting 30 days after the last tracked request. Only a SHA-256
hash of this random value is stored in D1, never an IP-derived fingerprint or the
raw cookie. Reports return distinct counts, not hashes. Counts deduplicate across
the selected date range and per document or outbound destination. Dashboard labels
use **Distinct users**, with the cookie limitations in tooltips. These are **estimated browsers, not
identified people**. Different devices, cleared/blocked cookies, private windows,
and unrecognized bots can inflate them; shared browser profiles can merge people.
Browser cookie policies may shorten the lifetime. DNT/GPC and exclusions still apply.

Visitor hashes were introduced prospectively on September 16, 2026 (Pacific).
Historical rows retain an empty hash. Reports expose their unidentified-request
count; the dashboard shows **Not measured** for historic-only data and an asterisk
when distinct counts omit some requests. No fabricated visitor backfill is used.

## Dashboard Details

The original tabs remain. Homepage and CV are pinned first in Papers & CV, followed
by current public papers (including those with no views). Maintain `src/documents.mjs`
when changing public paper titles or links; its tests verify titles and local assets.
Unlisted PDFs with activity also appear under their paths. Selecting a page, paper,
CV, or outbound destination opens a right-side panel with country/region, inbound
source, browser, device, and available campaign aggregates for that item and period.
The time chart is at the bottom. All main figures and detail queries exclude bots.
PDF link clicks and HTML request logs are not added to document-view counts.

The same first-party visitor identity now covers visible page views and outbound
clicks, not only PDF requests. HTML responses establish it before the browser script
runs; a collector response also sets it for previously cached pages. No identifiers
are returned by the report endpoint. Historic missing identities remain unknown.

Inbound sources distinguish **Direct** (a captured request with no referrer supplied)
from **Unknown** (missing/invalid capture, including older browser events). Direct
does not prove someone typed a URL: privacy policies and apps may strip referrers.
Browser events send only the landing referrer's origin, rather than incorrectly
using the collector endpoint's same-site Referer header. Only the domain is stored.
Migration `0002_referrer_status.sql` preserves all historic counts without guessing
the sources of unclassified events. Detail tables show at most 50 groups per dimension.
Migration `0003_personal_activity.sql` adds personal-event classification and a
hashed browser-identity registry without guessing the owner of historic events.

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
GA4, not D1; D1's separate PDF-browser hash is described above. A direct PDF visit is not guaranteed to join later HTML visits or
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
