const ACTIONS = ["searches", "prints", "outline", "zoom"];
const CLIENT_STATUSES = new Set(["not_configured", "loading", "executing", "submitted", "script_failed", "execution_failed", "submission_failed"]);

// Explicit allowlists prevent client payloads from becoming arbitrary data storage.
export function clientDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  if (Array.isArray(value.languages)) result.languages = value.languages.filter(v => typeof v === "string" && /^[a-zA-Z0-9-]{1,35}$/.test(v)).slice(0, 5);
  for (const key of ["viewport", "initialViewport"]) {
    const v = value[key];
    if (Array.isArray(v) && v.length === 2 && v.every(n => Number.isInteger(n) && n > 0 && n <= 20000)) result[key] = v;
  }
  if (["navigate", "reload", "back_forward", "prerender"].includes(value.navigation)) result.navigation = value.navigation;
  for (const key of ["responseMs", "domMs", "loadMs", "pdfRenderMs"]) {
    if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 3600000) result[key] = value[key];
  }
  if (CLIENT_STATUSES.has(value.assessment)) result.assessment = value.assessment;
  return Object.keys(result).length ? result : null;
}

export function validInteractions(value) {
  return value === undefined || Boolean(value && Object.keys(value).sort().join(",") === [...ACTIONS].sort().join(",")
    && ACTIONS.every(key => Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 10000));
}

export const INTERACTIONS_MONOTONIC = `(h.interactions IS NULL OR (json_type(j.value,'$.interactions') = 'object'
  AND NOT EXISTS (SELECT 1 FROM json_each(h.interactions) old_action
    WHERE COALESCE(json_extract(j.value,'$.interactions.' || old_action.key),-1) < old_action.value)))`;

export function summarizeInteractions(values) {
  const recorded = values.filter(Boolean);
  if (!recorded.length) return undefined;
  return Object.fromEntries(ACTIONS.map(key => [key, recorded.reduce((n, value) => n + value[key], 0)]));
}
