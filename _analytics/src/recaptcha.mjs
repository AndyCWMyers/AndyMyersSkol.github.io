const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validAssessment(body) {
  return body && UUID.test(body.id || "") && typeof body.token === "string"
    && body.token.length >= 20 && body.token.length <= 12000
    && (body.diagnostic === undefined || body.diagnostic === true);
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
  const diagnostic = body.diagnostic === true;
  const table = diagnostic ? "pdf_diagnostics" : "reading_sessions";
  const other = diagnostic ? "reading_sessions" : "pdf_diagnostics";
  const time = diagnostic ? "occurred_at" : "started_at";
  const claimed = await env.DB.prepare(`UPDATE ${table} SET recaptcha_status = 'pending'
    WHERE id = ? AND visitor_hash = ? AND recaptcha_status = 'unassessed'
      AND ${time} >= ? AND ${time} <= ? AND is_personal = 0
      AND visitor_hash NOT IN (SELECT visitor_hash FROM personal_visitors)
      ${diagnostic ? "AND route = 'viewer' AND bot = 0" : ""}
      AND NOT EXISTS (SELECT 1 FROM ${other} o WHERE o.id = ${table}.id
        AND o.visitor_hash = ${table}.visitor_hash AND o.recaptcha_status <> 'unassessed')
    RETURNING ${diagnostic ? "'pdf_request' AS kind" : "kind"}`)
    .bind(body.id, visitor, Math.floor(now / 1000) - 600, Math.floor(now / 1000) + 60).all();
  if (!claimed.results.length) {
    // A fresh viewer may beat its asynchronous diagnostic insert. Let the bounded
    // client retry recover that race without consuming an assessment token twice.
    if (diagnostic) {
      const exists = await env.DB.prepare("SELECT id FROM pdf_diagnostics WHERE id = ? AND visitor_hash = ?")
        .bind(body.id, visitor).all();
      if (!exists.results.length) return 404;
    }
    return 204;
  }
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
  const result = env.DB.prepare(`UPDATE ${table} SET recaptcha_score = ?, recaptcha_at = ?, recaptcha_status = ?
    WHERE id = ? AND visitor_hash = ? AND recaptcha_status = 'pending'`)
    .bind(score, score === null ? null : Math.floor(now / 1000), status, body.id, visitor);
  if (diagnostic) {
    // Rendering can finish during verification. A later session copies the result
    // at insertion; an already-created one receives it here, never a new session.
    await env.DB.batch([result, env.DB.prepare(`UPDATE reading_sessions SET recaptcha_score = ?, recaptcha_at = ?, recaptcha_status = ?
      WHERE id = ? AND visitor_hash = ? AND recaptcha_status IN ('pending','unassessed')`)
      .bind(score, score === null ? null : Math.floor(now / 1000), status, body.id, visitor)]);
  } else await result.run();
  return 204;
}
