// Self-contained so the same normalization runs before browser transmission.
export function inboundUrl(value) {
  if (typeof value !== "string" || value.length > 16384) return "";
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
    const sensitive = /[\u0000-\u001f\u007f]|[^\s/@]+@[^\s/]+\.[^\s/]+|\bBearer\s|\beyJ[\w-]+\.[\w-]+\./i;
    const path = decodeURIComponent(url.pathname);
    if (sensitive.test(path) || /\/(?:token|secret|password|reset-password|auth|oauth)\//i.test(path)) return url.origin;
    const entries = [...url.searchParams];
    url.hash = "";
    url.search = "";
    if (url.href.length > 1200) return url.origin;
    let count = 0;
    for (const [key, value] of entries) {
      // Keep attribution/search parameters, not arbitrary form, account or auth data.
      if (!/^(?:utm_[a-z0-9_]{1,40}|gclid|dclid|gbraid|wbraid|gclsrc|gad_source|gad_campaignid|msclkid|fbclid|ttclid|twclid|li_fat_id|srsltid|irclickid|yclid|q|query|search|search_query|keyword|keywords|p)$/i.test(key)
        || /token|secret|password|email|phone|address|user_?id/i.test(key)
        || !value || value.length > 300 || sensitive.test(value) || count >= 24) continue;
      const previous = url.search;
      url.searchParams.append(key, value);
      if (url.href.length > 1200) { url.search = previous; continue; }
      count++;
    }
    return url.href;
  } catch { return ""; }
}

export function inboundDetails(referrer, landing, via) {
  return { referrerUrl: inboundUrl(referrer), landingUrl: inboundUrl(landing), via };
}

export function parseInbound(value) {
  try { return value ? JSON.parse(value) : undefined; } catch { return undefined; }
}
