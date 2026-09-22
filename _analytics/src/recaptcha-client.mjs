export default String.raw`let recaptchaLoading;
  const assessedVisits = new Map();

  function loadRecaptcha(key) {
    if (!recaptchaLoading) recaptchaLoading = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!allowed()) throw new Error("Assessment disabled");
        try {
          return await new Promise((resolve, reject) => {
            let settled = false;
            const script = document.createElement("script");
            const finish = success => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              script.onload = script.onerror = null;
              if (success) resolve(window.grecaptcha);
              else { script.remove?.(); reject(new Error("Assessment unavailable")); }
            };
            const timer = setTimeout(() => finish(false), 12000);
            script.src = "https://www.google.com/recaptcha/api.js?render=" + encodeURIComponent(key);
            script.async = true;
            script.onload = () => {
              try { window.grecaptcha.ready(() => finish(true)); } catch { finish(false); }
            };
            script.onerror = () => finish(false);
            document.head.appendChild(script);
          });
        } catch (error) {
          if (attempt === 1 || !allowed()) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    })();
    return recaptchaLoading;
  }

  async function assessVisit(id, kind, status = () => {}, diagnostic = false) {
    const key = window.acwRecaptchaSiteKey;
    if (!key || !allowed()) return;
    const existing = assessedVisits.get(id);
    if (existing) {
      existing.listeners.add(status);
      status(existing.status);
      return existing.promise;
    }
    const visit = { status: "loading", listeners: new Set([status]), promise: null };
    assessedVisits.set(id, visit);
    const update = value => { visit.status = value; for (const listener of visit.listeners) listener(value); };
    visit.promise = runAssessment(id, kind, diagnostic, key, update);
    return visit.promise;
  }

  async function runAssessment(id, kind, diagnostic, key, status) {
    status("loading");
    let api, token;
    try { api = await loadRecaptcha(key); } catch { status("script_failed"); return; }
    if (!allowed()) return;
    status("executing");
    let timer;
    try {
      token = await Promise.race([
        api.execute(key, { action: kind === "page_view" ? "homepage_view" : "pdf_view" }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Assessment unavailable")), 12000); }),
      ]);
    }
    catch { status("execution_failed"); return; }
    finally { clearTimeout(timer); }
    if (!allowed() || typeof token !== "string") return;
    // This never gates rendering or engagement and never invokes a challenge.
    status(await post("/__analytics/assessment", JSON.stringify({ id, token, ...(diagnostic ? { diagnostic: true } : {}) })) ? "submitted" : "submission_failed");
  }`;
