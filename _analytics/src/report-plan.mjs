// Named plans keep inactive tabs out of D1, while old clients/CSV retain all fields.
export const QUERY_NAMES = ["totals", "daily", "pages", "outbound", "countries", "referrers", "devices", "campaigns",
  "pdfVisitors", "pdfVisitorsByPath", "items", "breakdowns", "personalActivity", "states", "counties", "countyViews",
  "locationBreakdowns", "cities", "countryViews", "cityViews"];
export const REPORT_PLANS = {
  all: QUERY_NAMES,
  summary: ["totals", "personalActivity"],
  overview: ["items"],
  papers: ["items"],
  outbound: ["items"],
  geography: ["cities"],
  states: ["states"],
  counties: ["counties", "countyViews"],
  countries: ["countryViews"],
  cities: ["cityViews"],
  pdf_pages: [],
  homepage_attention: [],
  sources: ["referrers"],
  devices: ["devices"],
  detail: ["items", "breakdowns", "locationBreakdowns"],
};

// Country request totals are exactly additive over city groups. Distinct-user
// maps keep their own membership queries; their counts must never be summed.
export function countryCounts(cities) {
  const groups = new Map();
  for (const row of cities) {
    const key = JSON.stringify([row.country, row.kind]);
    const group = groups.get(key) || { name: row.country, kind: row.kind, count: 0 };
    group.count += row.count;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

export function queryUsage(entries) {
  const queries = entries.map(([name, result]) => ({ name,
    rowsRead: result.meta?.rows_read ?? null, rowsWritten: result.meta?.rows_written ?? null,
    durationMs: result.meta?.duration ?? null }));
  return { queryCount: queries.length,
    rowsRead: queries.every(query => query.rowsRead !== null) ? queries.reduce((sum, query) => sum + query.rowsRead, 0) : null,
    queries };
}
