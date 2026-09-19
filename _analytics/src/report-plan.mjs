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
  geography: ["countries", "cities"],
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

export function queryUsage(entries) {
  const queries = entries.map(([name, result]) => ({ name,
    rowsRead: result.meta?.rows_read ?? null, rowsWritten: result.meta?.rows_written ?? null,
    durationMs: result.meta?.duration ?? null }));
  return { queryCount: queries.length,
    rowsRead: queries.every(query => query.rowsRead !== null) ? queries.reduce((sum, query) => sum + query.rowsRead, 0) : null,
    queries };
}
