# Website Analytics

Cloudflare Worker and D1 deployed September 16, 2026. The private Command Center
Website Analytics dashboard reads aggregates and private browser histories through its local host.

The Cloudflare Worker proxies the existing GitHub Pages origin. Normal content
and PDF updates still publish through GitHub Pages. PDF URLs and bytes stay the
same; supported browser navigation now opens the bundled PDF.js viewer. The
homepage design is unchanged. The `_analytics` directory is not published by Jekyll.

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
7. DNSSEC was restored September 17, 2026 at 15:47 UTC: Cloudflare signs the zone
   and Squarespace publishes DS key tag `2371`, algorithm `13`, digest type `2`,
   digest `E92595BFA98C451C9D35FC6118955FDE057FD0FBB880880A195990F2F521E02A`.
   The `.com` registry serves the matching DS and Google Public DNS validates
   website answers. At verification, Stanford resolvers still cached the former
   DS (key tag `33919`) and could return SERVFAIL until expiry or a resolver-side
   cache flush. Publishing the new DS cannot evict that old cached record.
   For future migrations, remove the old DS and wait its full TTL before changing
   nameservers; waiting only the NS TTL is insufficient. Enable signing on the
   new authoritative servers and verify their DNSKEY before publishing a new DS.

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
- `pdf_request`: a successfully rendered PDF.js view, or a native initial PDF retrieval (200/206/304 when a PDF content
  type is supplied). Nonzero byte ranges are excluded. Repeated retrievals of the
  same PDF with the same browser cookie within five seconds count once. Very quick
  intentional native reopens also coalesce; anonymous retries can still inflate counts.
  PDF.js uses a stable view ID instead: retries of that ID count once, separate
  rendered opens count separately, and its raw byte fetches are not extra views.
  Cached/offline reads are not observable.
- `pdf_click`: a website link click, distinct from retrieval.
- `outbound_click`: an external HTTP(S) link, including WSJ, without query/hash.

### Reading Time And Downloads

Migration `0011_reading_sessions.sql` adds session state and UTC-hour cumulative
reading buckets, linked to existing view IDs. It does not change historical rows.
The shared homepage/PDF tracker counts time only while visible and focused, with
no inactivity cutoff. Suspended timers and clock jumps are discarded. It sends
an initial state, then at 15, 30, 45 and 60 engaged seconds, followed by five
additional engaged minutes between saves, plus pause, resume, exit and download
actions. Pause/download saves do not postpone first-minute milestones. Hidden or
unfocused time does not advance the schedule. Browser termination delivery is
best effort; an abrupt close
can lose the unsent interval. Multiple foreground windows may overlap.

Each save updates one session and only hourly buckets whose counters increased.
Sequence checks and cumulative counters prevent retries or out-of-order delivery
from adding time/downloads twice; session and bucket writes are transactional.
Index maintenance can increase billable D1 writes beyond the number of logical
rows. Hour buckets preserve Pacific date filtering, including DST and sessions
crossing midnight. A session with 128 distinct observed hours rotates to a new
view ID; normal visits do not rotate. `liveAt` comes from an active check-in, with
a 315-second freshness tolerance; a received pause clears it immediately. This
is recent activity, not guaranteed real-time presence.

### Homepage Attention

Migration `0014_homepage_attention.sql` adds nullable, unindexed JSON to the
existing `reading_hours` row. New homepage trackers record section reach,
maximum viewport-bottom depth, whether scroll position changed while active,
and per-entry visible milliseconds, abstract/summary opens and expanded visible
milliseconds. Stable numeric `data-acw-item` IDs map to the server catalog in
`homepage-attention.mjs`; never reuse IDs. `data-acw-section` is the section index.

IntersectionObserver narrows candidates; the existing one-second reading sample
checks that at least half the entry (or half the viewport for tall entries) is
visible. Abstract visibility can also qualify the containing entry. Entries
with less than two cumulative visible seconds and no opens are omitted from
reports. Multiple entries can accrue time simultaneously; this is exposure,
not eye tracking. Scroll includes anchor jumps and browser-driven position changes,
not just manual gestures. Initial viewport depth is not evidence of scrolling.

Scroll/toggle handlers only update memory. Attention rides on existing cumulative
checkpoints, with no extra timer, network call or per-interaction database row.
Only changed hourly JSON is written; a metadata-only change can update an hour
even without added time. The current 15-entry/128-hour maximum fits a 64,512-byte
request bound, below the 64 KiB keepalive body limit; tests enforce that budget.
Concurrent keepalive requests and abrupt exits can still lose unsent updates.
Host/privacy exclusions are unchanged. Nothing is sent to Google Analytics.

Only authenticated individual histories include attention, folded into the existing
hourly history query and scoped to the selected dates. The Command Center shows it
in collapsed Homepage activity details. Historical NULL remains Not measured.
Sequence guards and monotonic hourly counters prevent stale updates, double-counted
opens, cross-user updates, or erasure of already-recorded attention.

### PDF Attention

Migration `0015_pdf_attention.sql` adds nullable, unindexed `pdf_attention` JSON
to those same hourly rows. PDF.js records active scroll-position changes and a
compact bitset of visible page numbers. The initial page counts; pre-rendered or
offscreen pages do not. A page qualifies when at least half its height (or half
the viewer height for tall pages) is visible, with positive horizontal overlap.
The existing one-second sample and scroll listener update memory only. Page
navigation jumps count as scrolling. These are visible pages, not proof of reading;
page numbers include covers and need not match the document's printed labels.

The private history query unions bitsets within the selected dates, reporting
distinct pages viewed, total pages, furthest page and scrolling in a collapsed
PDF activity dropdown. Old/native requests remain Not measured. No extra queries,
per-page rows, timers or requests are added; changed JSON uses the existing hour
write. Host and privacy exclusions remain unchanged, and no activity goes to GA.
Bitset validation and atomic monotonic guards prevent erasure and invalid pages.
PDF attention supports up to 10,000 pages and rotates after 16 observed UTC-hour
buckets using the existing continuation flow, keeping even worst-case bodies
below 64,512 bytes. Larger documents keep ordinary timing without page detail.
Unsent changes can still be lost on abrupt exits. Nothing is backfilled.

Downloads count PDF.js toolbar/keyboard download requests, not verified saved
files. Browser-menu Save As, cancelled saves, offline reading, native fallback
reading time and reading outside this viewer cannot be measured reliably. Print
actions do not count as downloads. Privacy signals/opt-outs suppress all these
events. Marked personal browsers retain views and viewer-session confirmation, but
do not send reading-time/download updates or periodic live check-ins. The Worker
also discards personal engagement updates (including older cached clients), using
the host cookie, session marker, and personal-visitor registry. Historical personal
measurements remain stored and display-filterable; no data is deleted. Personal
sessions without measurements show Not measured, not zero.
Reading updates stay in private D1, not GA4; a rendered PDF view is forwarded to
GA4 once through the existing server integration.

Papers & CV and charts expose reading hours including the homepage; downloads
remain PDF-only with a dash for the homepage. Profiles separately show PDF reading time, homepage time and downloads,
plus per-view measurements. PDF history labels distinguish tracked viewer sessions,
sessions without reading updates, and requests with no tracked viewer session.
Missing updates remain Not measured, including sessions created without a first
checkpoint; only received zero-valued updates show zero. A history item
opened before the selected period can appear as Continued for reading within it,
without incrementing the period's view count. Users show short Most recent page
labels. Retired Cloudflare bot scores are not collected. Visible Users/profile
views refresh once per minute; hidden tabs do not poll.

### Google Visit Scores

Migration `0016_recaptcha_scores.sql` adds nullable Google reCAPTCHA v3 scores,
assessment times and a one-assessment status to existing reading sessions. These
are separate from the retired Cloudflare `bot_score` field: **0 is more likely
automated, 1 more likely legitimate**. Scores are probabilistic, not proof of a
person or bot. Cloudflare remains authoritative for all visits and metadata;
scores never block content, challenge visitors or change aggregate counts.

After the homepage or PDF.js collector confirms a visit, the browser requests
one score-only token with action `homepage_view` or `pdf_view`. Reading checkpoints
do not request more scores. The standard Google badge stays visible. Host browsers,
DNT/GPC and opted-out browsers do not load the script or submit assessments.
Native/raw PDFs, blocked scripts, failures and old visits remain Unassessed.

The public site key is domain-restricted to `andrewcwmyers.com` and its subdomains
in the no-billing Andy Website Analytics Google project. `RECAPTCHA_SECRET` is an
encrypted Worker secret, never included in Git or browser code. The server binds
the visit ID to the existing HttpOnly browser identity, atomically claims one
assessment, verifies hostname/action/token age and rejects every Google error,
including quota responses with a placeholder 0.9. Tokens are not stored. The
server sends only the token and secret, not raw IPs or internal visitor IDs;
Google's browser script independently receives normal browser/network signals.

Each attempted assessment adds one Worker call (apart from bounded transport
retries), one Google verification and two logical D1 row updates. No per-heartbeat
assessment or extra event row is added. Scores reuse existing authenticated user
and history queries. The list/profile reports the most recent valid assessment
within the selected dates; each history entry retains its own score. Missing later
assessments do not erase earlier valid scores. No backfill or automatic deletion.

Google's setup currently includes 10,000 assessments/month at no cost; billing
was not enabled. Exhaustion/failure leaves scores unavailable without affecting
website access. Review quota and privacy disclosures before expanding collection.
See [v3](https://developers.google.com/recaptcha/docs/v3),
[verification](https://developers.google.com/recaptcha/docs/verify), and
[quota and CSP guidance](https://developers.google.com/recaptcha/docs/faq).

The real generic PDF.js release and licenses are in `viewer-assets/` and deployed
through the private ASSETS binding, served at `/__pdfjs/`. The Worker allowlists
known documents and serves its HTML at the original PDF URL for explicit document
or iframe navigations (`Sec-Fetch-Mode: navigate`), even without HTML in Accept.
Accepting HTML remains a fallback when Fetch Metadata is missing. Original bytes
remain available at `?__pdf=raw`. Explicit non-navigation fetches, range requests,
HEAD, bots and PDF-only clients without clear navigation headers retain
native PDF responses. Search, thumbnails, zoom, navigation, print and download
remain native PDF.js controls. Local-file opening, scripting and editing are
disabled. Internal PDF.js byte fetches carry `X-ACW-PDF-Viewer: 1` so older browsers
without Fetch Metadata do not count the bytes and rendered view twice. This marker
only suppresses redundant analytics, not access control. See
`PDF-VIEWER-CONTRACT.md` for the browser/Worker protocol.

PDF routing diagnostics are stored separately in `pdf_diagnostics` (migration
0013), never in event counts, engagement totals or GA4. Initial external known-PDF
GETs record viewer/raw routing reason, response status, and bounded User-Agent,
Accept, Sec-Fetch-Dest/Mode and Range headers. Cookies, authorization headers,
query strings, arbitrary error messages and stacks are not stored. Internal
PDF.js byte requests and nonzero continuation ranges are excluded. A dedicated
60-per-IP/minute diagnostic limit bounds both inserts and browser signals without
blocking content or consuming the ordinary event collector's limit.

The viewer reports script startup, first rendered page, and at most one coded
error per load. A server-generated ID ties these to the initial request and the
confirmed viewer session; writes require the matching visitor cookie and origin.
Signals have at most two retries for route-insert races or transient failures;
duplicate updates do not rewrite rows. A normal tracked load adds one diagnostic
insert and two updates (plus SQLite index costs), not periodic heartbeat writes.
Missing signals remain unknown: they can mean blocking, unsupported JavaScript,
an early exit, rate limiting, or a failed diagnostic request. A client-reported
User-Agent can suggest a tool but is not verified identity.

Profiles expose the latest 50 diagnostics in the selected period, including
requests without a counted viewer event. Authenticated `view=pdf_diagnostics`
also supports `user`, `page` and 50-row `offset` pagination for investigation of
requests that never established any user activity. Diagnostic queries are indexed
and run only for profiles or explicit diagnostic reports. Retention is 30 days,
with opportunistic cleanup on future inserts; there is no recurring cleanup job.
Privacy opt-outs suppress inserts and signals; personal-activity filters apply.
Historical requests have no diagnostic headers and are not backfilled.

## Own Visits And Distinct Browsers

Migration `0008_client_metadata.sql` adds OS family (from the request user agent)
and a legacy nullable `bot_score` column. New writes leave that column null, and
reports no longer expose bot scores. Existing stored scores are not deleted.
Browser/device reports group by OS; existing user-agent bot filtering is unchanged.

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

The report endpoint accepts scoped `view` values: `summary`, `overview`, `papers`,
`outbound`, `geography`, `sources`, `devices`, `states`, `counties`, `countries`, and
`detail` (requiring a bound `section=main|outbound` and `name`). These execute only
their named query plans. Omitted `view` or `view=all` retains the complete report
for older clients and explicit CSV export. `view=users` lists paginated visitors;
`view=live` selects active reading sessions checked in within 315 seconds, plus
recorded page views, PDF requests and outbound clicks within 300 seconds when that
event has no reading session or no received check-in. A paused tracked session
does not fall back to its opening event. This also covers host visits without
reading measurement. Known bots, duplicate requests and unidentified visits are
excluded. The same indexed, read-only calculation supplies list and profile
`liveAt`/`liveUntil` values; fallback activity requires no new stored data. Overview
falls back to the three most recent users if none are live. Optional `page=/...`
scopes aggregates and reading summaries to a canonical page path; Users then
selects the cohort that viewed it while retaining each user's full-period history.
Migration `0012_page_filter.sql` adds page/time and active-session indexes.
Tab/map switches and destination details fetch on demand. All queries
preserve date, personal, bot, duplicate and distinct-browser semantics.

Paper-detail predicates exactly match the canonical page/time expression index.
Multi-dimension breakdowns materialize their filtered activity once per query,
instead of rereading raw events for each dimension. Live reports resolve the
recent cohort first, skip historical queries when empty, and reuse that cohort
for both indexed user-history lookup and live badges. These optimizations add no
persistent data, indexes or writes, and do not extend cache lifetimes. Query-plan
and result-equivalence tests cover page aliases, distinct counts, filters and CSV
results. On September 17, 2026, live D1 checks measured 351 to 3 rows read for an
empty live report and 2,628 to 345 for the CV detail panel; actual savings depend
on the selected period and traffic.

Migration `0010_headline_summaries.sql` maintains hourly event counters and
visitor memberships with atomic SQLite triggers. `view=summary` reads these
compact tables for unfiltered-page counts, plus reading-hour summaries for the
reading/download headline. Page-filtered counts use the indexed events table.
Exact distinct counts deduplicate visitor hashes
across the selected range; hourly/daily distinct counts are never added together.
Pacific midnight aligns with hourly UTC buckets even across daylight saving time.
The personal-browser registry is applied at read time, so marking a browser still
filters its earlier known-identity visits. Unidentified requests stay unidentified.
The migration backfills existing counts without changing any raw event. Inserts,
updates and deletes keep both summaries consistent, excluding flagged duplicates.
This trades up to two additional summary-row writes per counted event for cheaper
headline reads. Exact distinct counts still read compact visitor memberships and
can approach one membership per view when every visitor is new; they are not a
constant-cost counter. Other tabs and explicit full-report exports retain their
existing event queries. The summaries can be checked against `view=all`.

Authenticated responses include `queryUsage` with named query counts, rows read,
rows written and duration from D1 metadata (null when unavailable). No SQL, tokens,
IPs or visitor identities are included in these diagnostics. Cache hits reuse the
original execution measurements; they do not themselves repeat those D1 reads.
The Command Center caches scoped aggregates and user-list pages for one minute,
coalesces matching concurrent requests, and never caches individual histories/IPs.
Migration `0009_user_history_index.sql` adds an expression/time index matching
profile labels and filters. Both history and full-period IP queries use it; no
recorded events are modified or removed. User-list grouping still examines the
selected period, so its LIMIT is not a guarantee of only fifteen rows read.

Country maps use `countryViews`, which counts page/PDF views and deduplicates
browser identities across all regions and documents within each country. The
`countries` detail dimension provides the same deduplication per destination,
including outbound destinations, without summing distinct counts across regions.
Both retain existing personal, bot, date and PDF-duplicate filters.

The Users list is newest-first with 15 users per page; individual histories retain
100 events per page, newest first. Responses include `limit` so clients
can navigate backward correctly. The red Live indicator uses active reading
check-ins within five minutes plus 15 seconds of tolerance, or the five-minute
unmeasured-activity fallback above. Neither proves the user is still online.

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
Tabs are Overview, Papers & CV, Users, Geography, Inbound, Outbound, Browsers.
Overview includes live/recent users, a single-series paper chart (views, distinct
users, reading hours or downloads), and Geography with states as the default.
Alaska/Hawaii share the composite USA map. There is no Traffic plot tab or state
totals dropdown. A shared page selector applies across tabs and CSV. The wide detail panel supports individual browser histories
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

PDF bytes, ETags and URLs remain unchanged. Eligible native PDF responses request browser
revalidation so later online opens can be observed. Native PDF reading time,
scroll depth, offline opens and reliable unique-reader counts remain unavailable;
the PDF.js reading measurements described above are prospective only.
GA4 may not show these events in engagement/realtime metrics because no engagement
duration is invented. The Command Center uses independent Cloudflare aggregates;
GA4 historical reports remain in Google Analytics. GA4 Data API import is not set up.

## Limits And Recovery

The authenticated report endpoint's `view=usage` reads Cloudflare's GraphQL
account metrics without querying D1. A dedicated Account Analytics:Read token
for this account is stored only as the encrypted `CF_USAGE_TOKEN` Worker secret.
`CF_ACCOUNT_ID` and `CF_DATABASE_ID` identify the account and website database.
The Command Center Controls sidebar requests this only when opened, with
five-minute in-memory caches and coalesced pending reads at the Worker and host.
Errors remain unavailable, not fabricated zero usage; usage is not stored in
the browser's offline cache. Visitor/page/personal filters do not affect it.

The rolling 30-day report groups Worker requests and D1 rows read/written by UTC
day, matching the daily reset rather than the dashboard's Pacific visitor dates.
Storage is the sum of reported per-database daily peaks, not bytes written that
day or a live storage snapshot; absent storage samples remain unknown.
The UI compares against Free-plan allowances (confirmed September 17, 2026):
100,000 Worker requests, 5 million D1 row reads, 100,000 row writes per day;
5 GB account storage and 500 MB per database. Update the reference allowances
and labeling if the account upgrades. Cloudflare's metrics can lag and use
adaptive sampling; these are operational estimates, not an invoice.
Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/).

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
