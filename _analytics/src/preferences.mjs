const EXCLUSION_COOKIE = "__Host-acw_ignore";
const PERSONAL_COOKIE = "__Host-acw_personal";
const VISITOR_COOKIE = "__Host-acw_visitor";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Preserve the origin on this page's same-origin form POST, without external referrers.
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" };

export function cookieValue(request, name) {
  const prefix = `${name}=`;
  return (request.headers.get("Cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length) || "";
}

export function excludedBrowser(request) {
  return cookieValue(request, EXCLUSION_COOKIE) === "1";
}

export function personalBrowser(request) {
  return cookieValue(request, PERSONAL_COOKIE) === "1";
}

export function visitorIdentity(request) {
  const existing = cookieValue(request, VISITOR_COOKIE);
  const value = UUID.test(existing) ? existing : crypto.randomUUID();
  return { value, cookie: `${VISITOR_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000` };
}

export async function visitorHash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function preferenceBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  let text = "", length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) return text;
    length += value.length;
    if (length > 64) { await reader.cancel(); throw new Error("Invalid preference"); }
    text += new TextDecoder().decode(value);
  }
}

export async function preferences(request, env = {}) {
  const url = new URL(request.url);
  if (url.hostname !== "www.andrewcwmyers.com") return new Response(null, { status: 303,
    headers: { ...HEADERS, Location: "https://www.andrewcwmyers.com/__analytics/preferences" } });
  if (request.method === "POST") {
    if (request.headers.get("Origin") !== url.origin) return new Response("Forbidden", { status: 403, headers: HEADERS });
    // Only this fixed form body is accepted; no identifiers or tokens are submitted.
    if (Number(request.headers.get("Content-Length")) > 64) return new Response("Invalid preference", { status: 400, headers: HEADERS });
    let body;
    try { body = await preferenceBody(request); } catch { return new Response("Invalid preference", { status: 400, headers: HEADERS }); }
    const modes = { "exclude=1": "excluded", "": "included", "mode=excluded": "excluded", "mode=included": "included", "mode=personal": "personal" };
    if (!Object.hasOwn(modes, body)) return new Response("Invalid preference", { status: 400, headers: HEADERS });
    const mode = modes[body], exclude = mode === "excluded", personal = mode === "personal";
    const headers = new Headers({ ...HEADERS, Location: `/__analytics/preferences?saved=${mode}` });
    if (personal) {
      if (!env.DB) return new Response("Preference unavailable", { status: 503, headers: HEADERS });
      const visitor = visitorIdentity(request);
      // Recognize earlier events only when this same random browser identity exists.
      await env.DB.prepare("INSERT OR IGNORE INTO personal_visitors(visitor_hash) VALUES (?)").bind(await visitorHash(visitor.value)).run();
      headers.append("Set-Cookie", visitor.cookie);
    } else if (personalBrowser(request)) {
      // Unmarking starts a new identity; earlier marked activity remains filterable.
      headers.append("Set-Cookie", `${VISITOR_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    }
    headers.append("Set-Cookie", `${EXCLUSION_COOKIE}=${exclude ? "1" : ""}; Path=/; Secure; SameSite=Lax; Max-Age=${exclude ? 31536000 : 0}`);
    headers.append("Set-Cookie", `${PERSONAL_COOKIE}=${personal ? "1" : ""}; Path=/; Secure; SameSite=Lax; Max-Age=${personal ? 31536000 : 0}`);
    if (exclude || personal) for (const name of [...(exclude ? [VISITOR_COOKIE] : []), "__Host-acw_ga", "__Host-acw_pdf"]) {
      headers.append("Set-Cookie", `${name}=; Path=/; Secure; SameSite=Lax; Max-Age=0`);
    }
    return new Response(null, { status: 303, headers });
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: HEADERS });
  const excluded = excludedBrowser(request);
  const personal = personalBrowser(request);
  const privacySignal = request.headers.get("DNT") === "1" || request.headers.get("Sec-GPC") === "1";
  const saved = url.searchParams.get("saved");
  const failed = (saved === "excluded" && !excluded) || (saved === "personal" && !personal);
  const status = failed ? "Preference was not saved. Check this browser's cookie settings." : privacySignal ? "This browser sends a privacy opt-out signal; activity is not recorded." : excluded ? "This browser is excluded. Activity is not recorded." : personal ? "This browser is marked as your activity." : "This browser is included.";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Analytics Preferences | Andrew C. W. Myers</title><style>
body{margin:0;padding:48px 24px;color:#273437;background:#fafbfb;font:16px/1.6 system-ui,sans-serif;letter-spacing:0}main{max-width:560px;margin:auto}h1{font-size:26px;line-height:1.3}p{margin:20px 0}form{border-block:1px solid #d7dfdf;padding:24px 0}label{display:flex;gap:12px;align-items:center;margin:12px 0}input{width:20px;height:20px;flex:0 0 20px;accent-color:#176b64}button{display:block;margin-top:24px;padding:10px 16px;font:inherit;border:1px solid #176b64;border-radius:4px;background:#176b64;color:white;cursor:pointer}a{color:#176b64}small{display:block;color:#59676b;margin-top:24px}form small{margin:6px 0 20px;font-size:13px}
</style></head><body><main><a href="/">Andrew C. W. Myers</a><h1>Analytics preferences</h1><p role="status">${status}</p>
<form method="post" action="/__analytics/preferences">
<label><input type="radio" name="mode" value="included" ${!excluded && !personal ? "checked" : ""}>Regular visitor</label>
<label><input type="radio" name="mode" value="personal" ${personal && !excluded ? "checked" : ""}>Mark as my activity</label>
<small>Personal activity is retained in the private dashboard, where you can hide or show it. It is not sent to Google Analytics.</small>
<label><input type="radio" name="mode" value="excluded" ${excluded ? "checked" : ""}>Do not record this browser</label>
<button type="submit">Save preference</button></form>
<small>These preferences apply to page views, PDF requests and link clicks. Mark each browser/profile separately and reload open website tabs after saving. Clearing cookies resets the preference. Older visits without an identifiable browser cannot be classified as yours. Privacy opt-out signals always stop collection.</small>
</main></body></html>`, { headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
}
