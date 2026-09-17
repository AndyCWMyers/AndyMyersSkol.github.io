// Keep browser code as text so Worker bundling cannot inject out-of-scope helpers.
export default String.raw`function startAnalytics(measurementId) {
  if (navigator.globalPrivacyControl || navigator.doNotTrack === "1") return;
  const endpoint = "/__analytics/event";

  function send(kind, target = "") {
    if ((document.cookie || "").split(";").some(part => part.trim() === "__Host-acw_ignore=1")) return;
    if (document.visibilityState !== "visible") return;
    const query = new URL(location.href).searchParams;
    let referrer = document.referrer === "" ? "" : null;
    try { referrer = new URL(document.referrer).origin; } catch {}
    const campaign = key => (query.get(key) || "").replace(/[^a-zA-Z0-9_. -]/g, "").slice(0, 100);
    const body = JSON.stringify({ id: crypto.randomUUID(), kind, path: location.pathname, target, referrer,
      source: campaign("utm_source"), medium: campaign("utm_medium"), campaign: campaign("utm_campaign") });
    if (!navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain" }))) {
      fetch(endpoint, { method: "POST", body, keepalive: true }).catch(() => {});
    }
  }

  function clicked(event) {
    if (event.type === "auxclick" && event.button !== 1) return;
    const link = event.target.closest?.("a[href]");
    if (!link) return;
    const target = new URL(link.href, location.href);
    if (!/^https?:$/.test(target.protocol)) return;
    target.hash = "";
    target.search = "";
    if (target.origin !== location.origin) send("outbound_click", target.href);
    else if (/\.pdf$/i.test(target.pathname)) send("pdf_click", target.pathname);
  }

  function visible() {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", visible);
    send("page_view");
  }

  function rememberGoogleSession() {
    if ((document.cookie || "").split(";").some(part => part.trim() === "__Host-acw_ignore=1" || part.trim() === "__Host-acw_personal=1")) return;
    if (!measurementId || !Array.isArray(window.dataLayer)) return;
    const tag = function () { window.dataLayer.push(arguments); };
    tag("get", measurementId, "client_id", client => {
      if (!/^\d{1,20}\.\d{1,20}$/.test(String(client))) return;
      tag("get", measurementId, "session_id", session => {
        if (!/^\d{1,12}$/.test(String(session)) || Number(session) <= 0) return;
        document.cookie = "__Host-acw_ga=" + client + "|" + session + "|" + Math.floor(Date.now() / 1000) + "; Path=/; Secure; SameSite=Lax; Max-Age=1800";
      });
    });
  }

  document.addEventListener("click", clicked, { capture: true });
  document.addEventListener("auxclick", clicked, { capture: true });
  document.addEventListener("visibilitychange", visible);
  visible();
  rememberGoogleSession();
}`;
