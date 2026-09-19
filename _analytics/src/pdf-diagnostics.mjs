import { visitorHash, personalBrowser } from "./preferences.mjs";
import { automatedClient } from "./automated-client.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ERRORS = new Set(["render_error", "document_error", "initialization_error", "script_error", "runtime_error", "promise_error", "unsupported_browser", "startup_timeout", "tracking_http", "tracking_network", "engagement_start_error"]);
const STAGES = { started: "started_at", initialized: "initialized_at", loaded: "loaded_at", rendered: "rendered_at" };
let cleanupDay = "";

function header(request, name, limit) {
  return (request.headers.get(name) || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);
}

export async function recordPdfDiagnostic(db, request, { id, path, reason, status, visitorId, bot = 0 }) {
  if (!db) return;
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`INSERT OR IGNORE INTO pdf_diagnostics
    (id,occurred_at,visitor_hash,path,route,reason,status,user_agent,accept_header,fetch_dest,fetch_mode,range_header,is_personal,bot)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, now, visitorId ? await visitorHash(visitorId) : "", path,
      reason === "viewer" ? "viewer" : "raw", reason, status, header(request, "User-Agent", 512),
      header(request, "Accept", 256), header(request, "Sec-Fetch-Dest", 32), header(request, "Sec-Fetch-Mode", 32),
      header(request, "Range", 100), personalBrowser(request) ? 1 : 0, bot).run();
  // Short-lived diagnostics: cleanup is opportunistic, never a request-blocking job.
  const day = new Date().toISOString().slice(0, 10);
  if (cleanupDay !== day) {
    cleanupDay = day;
    try { await db.prepare("DELETE FROM pdf_diagnostics WHERE occurred_at < ?").bind(now - 30 * 86400).run(); }
    catch { cleanupDay = ""; }
  }
}

export function validDiagnosticSignal(body) {
  return body && UUID.test(body.id || "") && (Object.hasOwn(STAGES, body.stage) || body.stage === "error")
    && (body.stage !== "error" || (ERRORS.has(body.code) && Number.isInteger(body.status) && body.status >= 0 && body.status <= 599));
}

export async function updatePdfDiagnostic(db, body, visitor, now = Math.floor(Date.now() / 1000)) {
  const field = STAGES[body.stage];
  const set = body.stage === "error" ? "error_code = ?, error_status = ?, error_at = ?" : `${field} = ?`;
  const empty = body.stage === "error" ? "error_at = 0" : `${field} = 0`;
  const values = body.stage === "error" ? [body.code, body.status, now] : [now];
  const result = await db.prepare(`UPDATE pdf_diagnostics SET ${set}
    WHERE id = ? AND visitor_hash = ? AND route = 'viewer' AND occurred_at >= ? AND ${empty}`)
    .bind(...values, body.id, visitor, now - 86400).run();
  if ((result.meta?.changes ?? result.changes) > 0) return 204;
  const existing = await db.prepare("SELECT id FROM pdf_diagnostics WHERE id = ? AND visitor_hash = ? AND route = 'viewer' AND occurred_at >= ?")
    .bind(body.id, visitor, now - 86400).all();
  return existing.results.length ? 204 : 404;
}

export async function pdfDiagnostics(db, dates, excludePersonal, user = "", offset = 0, path = "") {
  const result = await db.prepare(`SELECT d.id, d.occurred_at AS time, d.path, d.route, d.reason, d.status,
    d.user_agent AS userAgent, d.accept_header AS accept, d.fetch_dest AS destination, d.fetch_mode AS mode,
    d.range_header AS range, d.started_at AS startedAt, d.initialized_at AS initializedAt,
    d.loaded_at AS loadedAt, d.rendered_at AS renderedAt,
    d.error_code AS errorCode, d.error_status AS errorStatus, d.error_at AS errorAt,
    EXISTS(SELECT 1 FROM reading_sessions s WHERE s.id = d.id AND s.visitor_hash = d.visitor_hash) AS confirmed
    FROM pdf_diagnostics d WHERE d.occurred_at >= ? AND d.occurred_at < ?
    ${user ? "AND substr(d.visitor_hash,1,24) = ?" : ""} ${path ? "AND d.path = ?" : ""}
    ${excludePersonal ? "AND d.is_personal = 0 AND NOT EXISTS(SELECT 1 FROM personal_visitors p WHERE p.visitor_hash = d.visitor_hash)" : ""}
    ORDER BY d.occurred_at DESC, d.id LIMIT 51 OFFSET ?`)
    .bind(dates.from, dates.until, ...(user ? [user] : []), ...(path ? [path] : []), offset).all();
  return { rows: result.results.slice(0, 50).map(row => ({ ...row, automatedClient: automatedClient(row.userAgent) })),
    nextOffset: result.results.length > 50 ? offset + 50 : null, measured: ["pdfDiagnostics", result] };
}
