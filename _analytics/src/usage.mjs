// Account-wide Cloudflare usage, independent of visitor filters and D1 queries.
const DAY = 86400000;
const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
export const FREE_LIMITS = { requests: 100000, rowsRead: 5000000, rowsWritten: 100000,
  storageBytes: 5 * 1000 ** 3, websiteStorageBytes: 500 * 1000 ** 2 };

export function usageQuery(account, start, end) {
  return { query: `query Usage($account: string!, $start: Date!, $end: Date!, $from: Time!, $until: Time!) {
    viewer { accounts(filter: {accountTag: $account}) {
      workers: workersInvocationsAdaptive(limit: 31, filter: {datetime_geq: $from, datetime_lt: $until}) {
        dimensions { date } sum { requests }
      }
      d1: d1AnalyticsAdaptiveGroups(limit: 31, filter: {date_geq: $start, date_leq: $end}) {
        dimensions { date } sum { rowsRead rowsWritten }
      }
      storage: d1StorageAdaptiveGroups(limit: 10000, filter: {date_geq: $start, date_leq: $end}) {
        dimensions { date databaseId } max { databaseSizeBytes }
      }
    } }
  }`, variables: { account, start, end, from: `${start}T00:00:00Z`, until: new Date(Date.parse(end) + DAY).toISOString() } };
}

function count(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid usage count");
  return value;
}

export function normalizeUsage(payload, start, end, databaseId, now = Date.now()) {
  const accounts = payload.data?.viewer?.accounts;
  if (payload.errors?.length || !Array.isArray(accounts) || accounts.length !== 1) throw new Error("Usage unavailable");
  const account = accounts[0];
  for (const [key, limit] of [["workers", 31], ["d1", 31], ["storage", 10000]]) {
    if (!Array.isArray(account[key]) || account[key].length >= limit) throw new Error("Incomplete usage response");
  }
  const days = new Map();
  for (let at = Date.parse(start); at <= Date.parse(end); at += DAY) {
    const date = new Date(at).toISOString().slice(0, 10);
    days.set(date, { date, requests: 0, rowsRead: 0, rowsWritten: 0, storageBytes: null, websiteStorageBytes: null });
  }
  for (const [key, fields] of [["workers", ["requests"]], ["d1", ["rowsRead", "rowsWritten"]]]) {
    for (const row of account[key]) {
      const day = days.get(row.dimensions?.date);
      if (!day) throw new Error("Mismatched usage dates");
      for (const field of fields) day[field] += count(row.sum?.[field]);
    }
  }
  const seen = new Set();
  for (const row of account.storage) {
    const { date, databaseId: id } = row.dimensions || {}, day = days.get(date), key = `${date}:${id}`;
    if (!day || !id || seen.has(key)) throw new Error("Invalid storage groups");
    seen.add(key);
    const bytes = count(row.max?.databaseSizeBytes);
    day.storageBytes = (day.storageBytes ?? 0) + bytes;
    if (id === databaseId) day.websiteStorageBytes = bytes;
  }
  return { status: "ready", scope: "account", timeZone: "UTC", plan: "free", start, end,
    generatedAt: new Date(now).toISOString(), limits: FREE_LIMITS,
    rows: [...days.values()].reverse() };
}

export function createUsageReader({ fetcher = fetch, now = Date.now } = {}) {
  let cached, pending, identity;
  return async function readUsage(env) {
    if (!env.CF_USAGE_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_DATABASE_ID) throw new Error("Usage not configured");
    const key = `${env.CF_ACCOUNT_ID}:${env.CF_DATABASE_ID}:${env.CF_USAGE_TOKEN}`;
    if (identity !== key) { cached = undefined; pending = undefined; identity = key; }
    const at = now(), end = new Date(at).toISOString().slice(0, 10);
    if (cached && cached.end === end && at - Date.parse(cached.generatedAt) < 300000) return cached;
    if (pending) return pending;
    const start = new Date(Date.parse(end) - 29 * DAY).toISOString().slice(0, 10);
    pending = (async () => {
      const response = await fetcher(GRAPHQL, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(6000),
        headers: { Authorization: `Bearer ${env.CF_USAGE_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(usageQuery(env.CF_ACCOUNT_ID, start, end)) });
      if (!response.ok) throw new Error("Usage unavailable");
      const value = normalizeUsage(await response.json(), start, end, env.CF_DATABASE_ID, at);
      cached = value;
      return value;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

export const readUsage = createUsageReader();
