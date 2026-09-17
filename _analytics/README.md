# Website Analytics

Cloudflare Worker and D1 deployed September 16, 2026. The private Command Center
Website Analytics dashboard reads aggregates and private browser histories through its local host.

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

`/__analytics/report` requires a bearer token. It returns aggregates by default;
`view=users` returns paginated anonymous browser summaries, and `user=<label>`
returns that browser's chronological events in the selected period. Both views
apply the same date, bot, and personal filters. Pages contain at most 100 rows;
`nextOffset` provides continuation without silently truncating histories.
The Command Center backend, not its browser bundle, holds this read-only token.
There is no SQL endpoint and alternate Workers hostnames are disabled.

## Measurement

- `page_view`: visible HTML page observed by the browser script.
- `page_request`: HTML retrieval through Cloudflare.
- `pdf_request`: successful initial PDF retrieval (200/206/304 when a PDF content
  type is supplied). Nonzero byte ranges are excluded. Repeated retrievals of the
  same PDF with the same browser cookie within five seconds count once. Very quick
  intentional reopens also coalesce; anonymous retries can still inflate counts.
  Cached/offline reads are not observable.
- `pdf_click`: a website link click, distinct from retrieval.
- `outbound_click`: an external HTTP(S) link, including WSJ, without query/hash.

## Own Visits And Distinct Browsers

Migration `0008_client_metadata.sql` adds OS family (from the request user agent)
and nullable `bot_score` (only the edge's `cf.botManagement.score`, integer 1-99).
Missing scores are not zero and are never inferred from the existing UA bot flag.
Numerical scores require Cloudflare Enterprise Bot Management; no plan change is
made here. Browser/device reports also group by OS, and user profiles/histories
expose the latest/per-event values. Neither field is backfilled for older events.
https://developers.cloudflare.com/bots/plans/bm-subscription/

Migration `0007_pdf_duplicates.sql` retains raw retrieval rows with `duplicate_of`
pointing to the counted request. A single atomic INSERT decides this at collection
time, including concurrent requests reaching separate Workers. The first counted
retrieval anchors the five-second window; retries do not extend it. No IP-based
matching is used. Reports, totals, maps, exports and user/IP histories omit flagged
rows. GA4 forwarding waits for that same decision, without delaying PDF delivery.
If the database write fails, the PDF still loads but no unverified GA event is sent.
The migration flags only historical same-second matching 200-then-304 pairs with
known browser identities. It deletes nothing and does not alter old GA4 events.

Open `https://www.andrewcwmyers.com/__analytics/preferences` in each browser/profile
used on the Mac Pro, MacBook Air, and iPhone. Check **Host**; changes save automatically.
The checkbox reflects the saved cookie after the page reloads. Reload open
website tabs. The one-year personal-marker cookie follows that browser across networks,
but clearing cookies, using a private window, or switching browser profiles requires
setting it again. An IP exclusion is deliberately not used: it could exclude other
Stanford/Hoover visitors and would fail when networks change. Uncheck **Host**
to unmark a browser; both states retain activity rather than disabling collection.
The page is never tracked; it needs no account credentials. The Command Center links
to it through **Analytics settings > Host browser setting**. Native app webviews and Safari/
Chrome may have separate cookie stores: use the browser actually used for the site.

The page contains only the Host checkbox and is absent from homepage links and the
sitemap. It sends both an `X-Robots-Tag: noindex, nofollow` header and a matching
robots meta tag. Do not disallow crawling in robots.txt: Google must fetch the page
to see noindex. This is not access control; the public repository exposes its URL.
The page only marks the visiting browser and never grants access to private reports.

Personal activity is retained in D1 with `is_personal=1` and forwarded to GA4 with
the event parameter `personal_activity=yes` (`no` for regular visitors). The homepage
pushes this value to the data layer before GTM loads. GTM's **Personal activity**
variable reads `personal_activity` (Data Layer Version 2), and **Tag1 > Shared event
settings** maps the event parameter `personal_activity` to `{{Personal activity}}`
for subsequent browser events. The Worker adds the same flag to PDF page views.
GA4's event-scoped custom dimension
**Personal activity** maps to `personal_activity`. Use report filters/comparisons,
not an active exclusion data filter: active data filters discard events permanently.
The existing Internal Traffic data filter was verified as **Testing**, not Active.
The flag is prospective; previously withheld GA4 events cannot be reconstructed.

The **Exclude my activity** dashboard switch is a display
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

The former **Do not record** option is no longer shown. Existing opt-out cookies
are still honored until the visitor explicitly changes the Host setting; legacy
form POSTs remain supported for already-open pages.
DNT/GPC always stop recording, even for marked personal browsers. Setting a marker
does not restore events that were never collected.

Eligible HTML/PDF requests and browser events receive a random Secure/HttpOnly/SameSite=Lax first-party
`__Host-acw_visitor` cookie lasting 30 days after the last tracked request. Only a SHA-256
hash of this random value is stored in D1, never an IP-derived fingerprint or the
raw cookie. Aggregate reports return distinct counts, not hashes. The authenticated
Users view labels browsers with the first 24 hex characters of their random-cookie
hash; these labels are not credentials and do not identify people. Counts deduplicate across
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

Country maps use `countryViews`, which counts page/PDF views and deduplicates
browser identities across all regions and documents within each country. The
`countries` detail dimension provides the same deduplication per destination,
including outbound destinations, without summing distinct counts across regions.
Both retain existing personal, bot, date and PDF-duplicate filters.

The Users list is newest-first with 15 users per page; individual histories retain
100 events per page and chronological order. Responses include `limit` so clients
can navigate backward correctly. The dashboard's red Live indicator means activity
within the past 20 minutes, not an open connection or verified human presence.

All date filters and daily buckets use `America/Los_Angeles` (Pacific midnight),
with daylight saving time handled by Intl. Timestamps remain stored as UTC epoch
seconds; the dashboard formats them explicitly as PST or PDT. Reports identify
their time zone, so old UTC snapshots are not relabeled as Pacific reports.

The original tabs remain. Homepage and CV are pinned first in Papers & CV, followed
by current public papers (including those with no views). Maintain `src/documents.mjs`
when changing public paper titles or links; its tests verify titles and local assets.
Unlisted PDFs with activity also appear under their paths. Selecting a page, paper,
CV, or outbound destination opens a right-side panel with country/region, inbound
source, browser, device, and available campaign aggregates for that item and period.
The time chart has its own **Traffic plot** tab. Papers & CV includes a views/users
bar chart with independently toggleable labels; Geography includes a U.S. state
map and state totals. The wide detail panel supports individual browser histories
in the **Users** tab. Marked personal browsers display **You** in a distinct color.
Geography, inbound sources, and browser/device tables separate webpage views,
PDF requests, and outbound clicks into three count columns.
All main figures and detail queries exclude bots.
PDF link clicks and HTML request logs are not added to document-view counts.

The same first-party visitor identity now covers visible page views and outbound
clicks, not only PDF requests. HTML responses establish it before the browser script
runs; a collector response also sets it for previously cached pages. Only the
private Users view returns pseudonymous browser labels, never raw cookies, full
hashes. IPs are available only in authenticated individual profiles, not aggregate
reports or the user listing. Historic missing identities remain unknown. Histories are fetched
on demand through the host and are not saved in the browser's offline report cache.

Inbound sources distinguish **Direct** (a captured request with no referrer supplied)
from **Unknown** (missing/invalid capture, including older browser events). Direct
does not prove someone typed a URL: privacy policies and apps may strip referrers.
Browser events send only the landing referrer's origin, rather than incorrectly
using the collector endpoint's same-site Referer header. Only the domain is stored.
Migration `0002_referrer_status.sql` preserves all historic counts without guessing
the sources of unclassified events. Detail tables show at most 50 groups per dimension.
Migration `0003_personal_activity.sql` adds personal-event classification and a
hashed browser-identity registry without guessing the owner of historic events.

At the owner's request, raw IP addresses are retained prospectively in private D1
and shown in authenticated individual user profiles. No browser fingerprints are
created, and IP addresses do not determine visitor identity or personal filters.
DNT/GPC opt-outs are honored by this collector. Browser
and bot classifications are coarse heuristics, not verified human identities.
Referrers are domains only; geographic data is country/region and an estimated U.S.
county (or county equivalent). Only UTM marketing
tags are retained from incoming query strings. Do not put personal data in UTMs.

### Estimated Counties

Migration `0004_county_geography.sql` adds `county` and `county_fips` without
backfilling historic visits. New events use Cloudflare's city-level IP coordinates
to find a containing Census county using Turf's point-in-polygon implementation.
Only edge metadata is trusted, not submitted browser location fields. Coordinates,
postal codes are not retained or sent to a lookup service. City names are retained
prospectively via migration `0006_city.sql`; IP
retention is separate, as described below.
This applies to page/PDF requests and browser page/click events, with the existing
opt-outs and personal filters unchanged. County data is not added to GA4.

No county is assigned when city/coordinates are missing, the state conflicts,
the point is outside the polygons, or more than one polygon matches. There is no
nearest-county fallback. These are IP-location estimates, not GPS or residence;
VPNs, mobile networks and simplified boundaries can mislocate visitors. Historic
and unmatched U.S. visits remain explicitly unknown. International visits keep
country/region only. County equivalents include DC, Alaska boroughs and Connecticut
planning regions; Puerto Rico municipalities are supported.

Boundaries: U.S. Census Bureau 2025 Cartographic Boundary counties, 1:5,000,000:
https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_county_5m.zip
https://www.census.gov/geographies/mapping-files/2025/geo/carto-boundary-file.html
Download and unzip the archive; regenerate with
`node scripts/build-counties.mjs /path/to/cb_2025_us_county_5m.shp`.
The generator retains official GEOIDs/names/states and rounds coordinates to five
decimals; it does not further simplify shapes. Copy the generated `src/us-counties.json`
to the Command Center's Website Analytics directory, then build that app. This is
public boundary data, not visitor data. Shapefile is a development-only converter;
Turf is bundled in the Worker. No paid geocoding API is required; existing Worker
and D1 usage limits still apply.

The map's States/Counties switch shows view or distinct-viewer totals. County
traffic tables separate page views, PDF requests and outbound clicks. County
distinct counts deduplicate within county across all viewed documents, not by
summing paper counts. Unknown counties appear in tables but cannot be mapped.
Per-item panels, individual browser histories and CSV exports include counties.

### Private IP History

Migration `0005_ip_address.sql` adds `ip_address` prospectively. Only the validated
Cloudflare `CF-Connecting-IP` header is used (or real IPv6 in Pseudo IPv4 overwrite
mode), never browser JSON, X-Forwarded-For, or X-Real-IP. Addresses identify network
connections, not people; VPNs/shared connections and Worker proxy requests can
represent intermediaries. Historical blank IPs stay unrecorded.

The bearer-protected individual profile returns every distinct address in its
selected Pacific date range, with first/last seen and event counts across the full
filtered history, independent of its 100-event page. Each history event also shows
its IP. Bot, privacy and personal filters still apply. Aggregate reports, CSVs and
user lists omit IPs. Profiles are fetched on demand, not offline-cached. Addresses
are not sent to GA4, geocoders, logs or Git, and are not used to merge identities.
No automatic IP deletion is configured; review retention and the site's privacy
disclosures to reflect this additional collection.

### City And Profile Map

`0006_city.sql` preserves the edge-reported city on new events. Browser-submitted
cities are ignored; missing historical city names remain unknown. City breakdowns
group by city, region, and country to distinguish names shared by multiple places.
Profiles, viewing histories, paper details, Geography's Cities mode and CSV exports
show cities. City data is not added to GA4 by this change.

The private profile's small state map highlights the latest estimated county in
the selected period, with a city label. It is a county-area map, not a city/GPS pin;
no coordinates or external geocoding/tile requests are introduced. Unsupported
international states and missing county geometry have explicit fallback states.
History groups have dated horizontal dividers using Pacific midnight, including
DST changes; event numbering continues across groups and history pages.

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
