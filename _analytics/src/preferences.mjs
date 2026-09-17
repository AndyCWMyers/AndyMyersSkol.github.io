const EXCLUSION_COOKIE = "__Host-acw_ignore";
const VISITOR_COOKIE = "__Host-acw_visitor";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

export function cookieValue(request, name) {
  const prefix = `${name}=`;
  return (request.headers.get("Cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length) || "";
}

export function excludedBrowser(request) {
  return cookieValue(request, EXCLUSION_COOKIE) === "1";
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

export async function preferences(request) {
  const url = new URL(request.url);
  if (url.hostname !== "www.andrewcwmyers.com") return new Response(null, { status: 303,
    headers: { ...HEADERS, Location: "https://www.andrewcwmyers.com/__analytics/preferences" } });
  if (request.method === "POST") {
    if (request.headers.get("Origin") !== url.origin) return new Response("Forbidden", { status: 403, headers: HEADERS });
    // Only this fixed form body is accepted; no identifiers or tokens are submitted.
    if (Number(request.headers.get("Content-Length")) > 64) return new Response("Invalid preference", { status: 400, headers: HEADERS });
    let body;
    try { body = await preferenceBody(request); } catch { return new Response("Invalid preference", { status: 400, headers: HEADERS }); }
    if (body !== "exclude=1" && body !== "") return new Response("Invalid preference", { status: 400, headers: HEADERS });
    const exclude = body === "exclude=1";
    const headers = new Headers({ ...HEADERS, Location: `/__analytics/preferences?saved=${exclude ? "excluded" : "included"}` });
    headers.append("Set-Cookie", `${EXCLUSION_COOKIE}=${exclude ? "1" : ""}; Path=/; Secure; SameSite=Lax; Max-Age=${exclude ? 31536000 : 0}`);
    if (exclude) for (const name of [VISITOR_COOKIE, "__Host-acw_ga", "__Host-acw_pdf"]) {
      headers.append("Set-Cookie", `${name}=; Path=/; Secure; SameSite=Lax; Max-Age=0`);
    }
    return new Response(null, { status: 303, headers });
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: HEADERS });
  const excluded = excludedBrowser(request);
  const privacySignal = request.headers.get("DNT") === "1" || request.headers.get("Sec-GPC") === "1";
  const failed = url.searchParams.get("saved") === "excluded" && !excluded;
  const status = failed ? "Preference was not saved. Check this browser's cookie settings." : excluded ? "This browser is excluded." : privacySignal ? "This browser sends a privacy opt-out signal." : "This browser is included.";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Analytics Preferences | Andrew C. W. Myers</title><style>
body{margin:0;padding:48px 24px;color:#273437;background:#fafbfb;font:16px/1.6 system-ui,sans-serif;letter-spacing:0}main{max-width:560px;margin:auto}h1{font-size:26px;line-height:1.3}p{margin:20px 0}form{border-block:1px solid #d7dfdf;padding:24px 0}label{display:flex;gap:12px;align-items:center}input{width:20px;height:20px;accent-color:#176b64}button{display:block;margin-top:24px;padding:10px 16px;font:inherit;border:1px solid #176b64;border-radius:4px;background:#176b64;color:white;cursor:pointer}a{color:#176b64}small{display:block;color:#59676b;margin-top:24px}
</style></head><body><main><a href="/">Andrew C. W. Myers</a><h1>Analytics preferences</h1><p role="status">${status}</p>
<form method="post" action="/__analytics/preferences"><label><input type="checkbox" name="exclude" value="1" ${excluded ? "checked" : ""}>Exclude this browser</label><button type="submit">Save preference</button></form>
<small>The preference applies to future website views, PDF requests and link clicks in this browser. It does not remove past events. Browser profiles, private windows and other devices have separate preferences. Clearing cookies resets it. Privacy opt-out signals remain respected.</small>
</main></body></html>`, { headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
}
