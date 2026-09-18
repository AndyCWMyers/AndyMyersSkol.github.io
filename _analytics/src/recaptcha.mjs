const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validAssessment(body) {
  return body && UUID.test(body.id || "") && typeof body.token === "string"
    && body.token.length >= 20 && body.token.length <= 12000;
}

export function verifiedScore(value, hostname, action, now) {
  if (!value || value.success !== true || value.hostname !== hostname || value.action !== action
    || typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 1
    // Over-quota responses can otherwise look like successful static 0.9 scores.
    || (value["error-codes"] && (!Array.isArray(value["error-codes"]) || value["error-codes"].length))) return null;
  const issued = Date.parse(value.challenge_ts);
  return Number.isFinite(issued) && issued >= now - 120000 && issued <= now + 30000 ? value.score : null;
}

export async function assessVisit(env, body, visitor, hostname, now = Date.now()) {
  if (!validAssessment(body)) return 400;
  // Atomically reserve one assessment per visit. Retries and concurrent requests
  // cannot repeatedly consume Google quota or overwrite the first score.
  const claimed = await env.DB.prepare(`UPDATE reading_sessions SET recaptcha_status = 'pending'
    WHERE id = ? AND visitor_hash = ? AND recaptcha_status = 'unassessed'
      AND started_at >= ? AND started_at <= ? AND is_personal = 0
      AND visitor_hash NOT IN (SELECT visitor_hash FROM personal_visitors)
    RETURNING kind`).bind(body.id, visitor, Math.floor(now / 1000) - 600, Math.floor(now / 1000) + 60).all();
  if (!claimed.results.length) return 204;
  const action = claimed.results[0].kind === "pdf_request" ? "pdf_view" : "homepage_view";
  let score = null, status = "unavailable";
  try {
    const url = "https://www.google.com/recaptcha/api/siteverify";
    const options = {
      method: "POST", body: new URLSearchParams({ secret: env.RECAPTCHA_SECRET, response: body.token }),
      signal: AbortSignal.timeout(8000), redirect: "manual",
    };
    const response = env.RECAPTCHA_FETCH ? await env.RECAPTCHA_FETCH(url, options) : await fetch(url, options);
    if (response.ok) {
      score = verifiedScore(await response.json(), hostname, action, now);
      status = score === null ? "invalid" : "assessed";
    } else status = `unavailable_http_${response.status}`;
  } catch (error) {
    const message = String(error?.message || "");
    status = /Illegal invocation/i.test(message) ? "unavailable_receiver"
      : /not a function/i.test(message) ? "unavailable_runtime"
      : /redirect/i.test(message) ? "unavailable_redirect"
      : error?.name === "TimeoutError" || error?.name === "AbortError" ? "unavailable_timeout"
      : error?.name === "SyntaxError" ? "unavailable_response" : "unavailable_network";
  }
  // Store no tokens, secrets, Google cookies, or additional visitor identifiers.
  await env.DB.prepare(`UPDATE reading_sessions SET recaptcha_score = ?, recaptcha_at = ?, recaptcha_status = ?
    WHERE id = ? AND visitor_hash = ? AND recaptcha_status = 'pending'`)
    .bind(score, score === null ? null : Math.floor(now / 1000), status, body.id, visitor).run();
  return 204;
}
