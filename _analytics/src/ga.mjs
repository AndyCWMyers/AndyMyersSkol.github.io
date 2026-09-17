// GA credentials stay in the Worker. Native PDFs cannot report engagement time.
const SESSION_SECONDS = 1800;

export function pdfIdentity(request, now = Math.floor(Date.now() / 1000)) {
  const cookies = new Map((request.headers.get("Cookie") || "").split(";").map(part => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), part.slice(index + 1)];
  }));
  for (const name of ["__Host-acw_ga", "__Host-acw_pdf"]) {
    const [client, session, created] = (cookies.get(name) || "").split("|");
    if (/^\d{1,20}\.\d{1,20}$/.test(client || "") && /^\d{1,12}$/.test(session || "")
      && /^\d{1,12}$/.test(created || "") && Number(session) > 0 && Number(created) <= now && now - Number(created) < SESSION_SECONDS) {
      return { client, session: Number(session), created: Number(created) };
    }
  }
  return { client: `${crypto.getRandomValues(new Uint32Array(1))[0]}.${now}`, session: now, created: now };
}

export function pdfCookie(identity) {
  return `__Host-acw_pdf=${identity.client}|${identity.session}|${identity.created}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

export function pdfPayload(request, identity, info) {
  const url = new URL(request.url);
  const ua = request.headers.get("User-Agent") || "";
  const language = (request.headers.get("Accept-Language") || "").split(/[,;]/)[0];
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows"
    : /Macintosh|Mac OS X/.test(ua) ? "MacOS" : /Linux/.test(ua) ? "Linux" : "";
  const params = { page_location: `${url.origin}${url.pathname}`, page_title: `PDF: ${url.pathname.split("/").pop()}`.slice(0, 100),
    content_type: "pdf", session_id: identity.session };
  if (info.referrer) params.page_referrer = `https://${info.referrer}`;
  if (info.source) params.campaign_source = info.source;
  if (info.medium) params.campaign_medium = info.medium;
  if (info.campaign) params.campaign_name = info.campaign;
  const device = { category: info.device.toLowerCase(), browser: info.browser };
  if (os) device.operating_system = os;
  if (/^[a-z]{2,3}(?:-[a-zA-Z]{2,8})?$/.test(language)) device.language = language;
  const payload = { client_id: identity.client, consent: { ad_user_data: "DENIED", ad_personalization: "DENIED" },
    device, events: [{ name: "page_view", params }] };
  if (/^[A-Z]{2}$/.test(info.country) && info.country !== "XX") {
    payload.user_location = { country_id: info.country };
    if (/^[A-Z0-9]{1,3}$/.test(info.region)) payload.user_location.region_id = `${info.country}-${info.region}`;
  }
  return payload;
}

export async function sendPdfEvent(request, env, identity, info) {
  const endpoint = new URL("https://www.google-analytics.com/mp/collect");
  endpoint.searchParams.set("measurement_id", env.GA_MEASUREMENT_ID);
  endpoint.searchParams.set("api_secret", env.GA_API_SECRET);
  const response = await (env.GA_FETCH || fetch)(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pdfPayload(request, identity, info)), signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error("GA event delivery failed");
}
