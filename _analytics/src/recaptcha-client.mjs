export default String.raw`let recaptchaLoading;
  const assessedVisits = new Set();

  function loadRecaptcha(key) {
    if (!recaptchaLoading) recaptchaLoading = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Assessment unavailable")), 12000);
      const script = document.createElement("script");
      script.src = "https://www.google.com/recaptcha/api.js?render=" + encodeURIComponent(key);
      script.async = true;
      script.onload = () => window.grecaptcha.ready(() => { clearTimeout(timer); resolve(window.grecaptcha); });
      script.onerror = () => { clearTimeout(timer); reject(new Error("Assessment unavailable")); };
      document.head.appendChild(script);
    });
    return recaptchaLoading;
  }

  async function assessVisit(id, kind) {
    const key = window.acwRecaptchaSiteKey;
    if (!key || !allowed() || assessedVisits.has(id)) return;
    assessedVisits.add(id);
    const api = await loadRecaptcha(key);
    if (!allowed()) return;
    const token = await api.execute(key, { action: kind === "page_view" ? "homepage_view" : "pdf_view" });
    if (!allowed() || typeof token !== "string") return;
    // This never gates rendering or engagement and never invokes a challenge.
    await post("/__analytics/assessment", JSON.stringify({ id, token }));
  }`;
