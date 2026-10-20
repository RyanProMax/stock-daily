import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isReportDate, ReportValidationError, validateReportPayload, type ReportKind, type ReportPayload } from "../contracts/reports";
import { parseDailyRow, parseWeeklyRow } from "./reports";

export type ReportBindings = { DB?: D1Database; REMOTE_DATA_ORIGIN?: string; REPORT_WRITE_TOKENS?: string };
const tables = { daily: { table: "daily_reports", key: "report_date" }, weekly: { table: "weekly_reports", key: "week_end" } } as const;
interface StoredRow {
  content: string; revision: number; headline: string; summary: string; generatedAt: string;
  edition?: number; dataCut?: string; agentModel: string; reportDate?: string; weekStart?: string; weekEnd?: string;
}
interface Receipt {
  writerId: string; idempotencyKey: string; kind: ReportKind; key: string; requestHash: string;
  revision: number; contentHash: string; etag: string; acceptedAt: string;
}
class WriteError extends Error {
  constructor(readonly status: 400 | 401 | 409 | 412 | 415 | 422 | 428 | 503, message: string) { super(message); }
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export async function contentHash(value: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function writerIdentity(env: ReportBindings, authorization: string | undefined) {
  let tokens: Record<string, string>;
  try {
    tokens = JSON.parse(env.REPORT_WRITE_TOKENS ?? "null");
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens) || Object.keys(tokens).length === 0 || Object.keys(tokens).length > 16
      || !Object.entries(tokens).every(([id, token]) => /^[a-zA-Z0-9_-]{1,64}$/.test(id) && typeof token === "string" && token.length >= 32 && token.length <= 256 && !/\s/.test(token))) throw new Error();
  } catch { throw new WriteError(503, "Report writing is not configured."); }
  const bearer = authorization?.match(/^Bearer ([^\s]{1,256})$/)?.[1];
  if (!bearer) throw new WriteError(401, "Report writer authentication required.");
  const actual = await contentHash(bearer);
  for (const [id, token] of Object.entries(tokens)) {
    const expected = await contentHash(token);
    let difference = 0;
    for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
    if (difference === 0) return id;
  }
  throw new WriteError(401, "Report writer authentication required.");
}
export async function readReportState(db: D1Database, kind: ReportKind, key: string) {
  const { table, key: keyColumn } = tables[kind];
  const columns = kind === "daily" ? "report_date AS reportDate, edition, data_cut AS dataCut" : "week_start AS weekStart, week_end AS weekEnd";
  const row = await db.prepare(`SELECT ${columns}, headline, summary, generated_at AS generatedAt, agent_model AS agentModel, content, revision FROM ${table} WHERE ${keyColumn} = ?`).bind(key).first<StoredRow>();
  if (!row) return null;
  const stored = JSON.parse(row.content);
  const payload = stored.schemaVersion === undefined ? null : validateReportPayload(kind, stored);
  const hash = await contentHash(payload ?? { ...row, revision: undefined });
  const revision = row.revision ?? 0;
  return { row, payload, meta: { revision, contentHash: hash, etag: `"${revision}-${hash}"` } };
}
export async function readApiReport(db: D1Database, kind: ReportKind, key: string) {
  const state = await readReportState(db, kind, key);
  if (!state) return null;
  // Parse the exact row whose ETag was computed, including for legacy content.
  // A second SELECT could return different content with the first row's ETag.
  const data = state.payload ?? (kind === "daily"
    ? parseDailyRow({ ...state.row, reportDate: key, edition: state.row.edition!, dataCut: state.row.dataCut! })
    : parseWeeklyRow({ ...state.row, weekEnd: key, weekStart: state.row.weekStart! }));
  return { data, meta: state.meta };
}
async function readReceipt(db: D1Database, writerId: string, idempotencyKey: string) {
  return db.prepare(`SELECT writer_id AS writerId, idempotency_key AS idempotencyKey, report_kind AS kind, report_key AS key,
    request_hash AS requestHash, revision, content_hash AS contentHash, etag, accepted_at AS acceptedAt
    FROM report_writes WHERE writer_id = ? AND idempotency_key = ?`).bind(writerId, idempotencyKey).first<Receipt>();
}
function publicReceipt(receipt: Receipt) {
  return { kind: receipt.kind, key: receipt.key, revision: receipt.revision, contentHash: receipt.contentHash, etag: receipt.etag, acceptedAt: receipt.acceptedAt };
}
async function persistReport(db: D1Database, kind: ReportKind, key: string, payload: ReportPayload, writerId: string, idempotencyKey: string, condition: string) {
  const requestHash = await contentHash({ kind, key, payload });
  const replay = async () => {
    const receipt = await readReceipt(db, writerId, idempotencyKey);
    if (receipt && receipt.requestHash !== requestHash) throw new WriteError(409, "Idempotency key was used for another request.");
    return receipt;
  };
  const priorReceipt = await replay();
  if (priorReceipt) return publicReceipt(priorReceipt);
  const current = await readReportState(db, kind, key);
  if ((current && current.meta.etag !== condition) || (!current && condition !== "*")) throw new WriteError(412, "Report version changed; read and merge before retrying.");
  if (current) {
    if (Date.parse(payload.generatedAt) < Date.parse(current.row.generatedAt)) throw new WriteError(409, "An older report cannot replace a newer report.");
    if (payload.schemaVersion === "daily-v1") {
      const stored = current.payload ?? JSON.parse(current.row.content);
      for (const market of ["CN", "US"] as const) {
        if (typeof stored.marketAsOf?.[market] === "string" && payload.marketAsOf[market] < stored.marketAsOf[market]) throw new WriteError(409, "Market dates cannot move backwards.");
      }
    }
  }
  const hash = await contentHash(payload);
  const revision = current && current.meta.contentHash === hash ? current.meta.revision : (current?.meta.revision ?? 0) + 1;
  const etag = `"${revision}-${hash}"`;
  const content = canonicalJson(payload);
  const { table, key: keyColumn } = tables[kind];
  let write: D1PreparedStatement;
  if (current) {
    write = db.prepare(`UPDATE ${table} SET headline = ?, summary = ?, generated_at = ?, content = ?, agent_model = 'external-agent', revision = ?, updated_at = CURRENT_TIMESTAMP
      ${kind === "daily" ? ", data_cut = ?" : ", week_start = ?"}
      WHERE ${keyColumn} = ? AND revision = ? AND content = ? AND generated_at = ?
      AND headline = ? AND summary = ? AND agent_model = ?
      ${kind === "daily" ? "AND edition = ? AND data_cut = ?" : "AND week_start = ?"}`).bind(
        payload.headline, payload.summary, payload.generatedAt, content, revision,
        payload.schemaVersion === "daily-v1" ? `CN ${payload.marketAsOf.CN} · US ${payload.marketAsOf.US}` : payload.weekStart,
        key, current.meta.revision, current.row.content, current.row.generatedAt,
        current.row.headline, current.row.summary, current.row.agentModel,
        ...(kind === "daily" ? [current.row.edition!, current.row.dataCut!] : [current.row.weekStart!]),
      );
  } else if (payload.schemaVersion === "daily-v1") {
    write = db.prepare(`INSERT INTO daily_reports (report_date, edition, headline, summary, generated_at, data_cut, agent_model, content, revision)
      VALUES (?, (SELECT COALESCE(MAX(edition), 0) + 1 FROM daily_reports), ?, ?, ?, ?, 'external-agent', ?, ?)
      ON CONFLICT(report_date) DO NOTHING`).bind(key, payload.headline, payload.summary, payload.generatedAt, `CN ${payload.marketAsOf.CN} · US ${payload.marketAsOf.US}`, content, revision);
  } else {
    write = db.prepare(`INSERT INTO weekly_reports (week_end, week_start, headline, summary, generated_at, agent_model, content, revision)
      VALUES (?, ?, ?, ?, ?, 'external-agent', ?, ?) ON CONFLICT(week_end) DO NOTHING`).bind(key, payload.weekStart, payload.headline, payload.summary, payload.generatedAt, content, revision);
  }
  const receipt: Receipt = { writerId, idempotencyKey, kind, key, requestHash, revision, contentHash: hash, etag, acceptedAt: new Date().toISOString() };
  try {
    // changes() belongs to the preceding write in this transaction. A failed
    // compare-and-swap makes revision NULL, violating NOT NULL and rolling back
    // the entire D1 batch, including the content write and receipt.
    await db.batch([write, db.prepare(`INSERT INTO report_writes
      (writer_id, idempotency_key, report_kind, report_key, request_hash, revision, content_hash, etag, accepted_at)
      VALUES (?, ?, ?, ?, ?, CASE WHEN changes() = 1 THEN ? ELSE NULL END, ?, ?, ?)`)
      .bind(writerId, idempotencyKey, kind, key, requestHash, revision, hash, etag, receipt.acceptedAt)]);
  } catch {
    const concurrentReceipt = await replay();
    if (concurrentReceipt) return publicReceipt(concurrentReceipt);
    const latest = await readReportState(db, kind, key);
    if (latest?.meta.etag !== current?.meta.etag) throw new WriteError(412, "Report version changed; read and merge before retrying.");
    throw new WriteError(503, "Report was not accepted; read back before retrying the same request.");
  }
  return publicReceipt(receipt);
}
const limit = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ error: { message: "Report exceeds 1 MiB.", status: 413 } }, 413);
} });
export const reportWriteRoutes = new Hono<{ Bindings: ReportBindings }>();
for (const kind of ["daily", "weekly"] as const) {
  reportWriteRoutes.put(kind === "daily" ? "/reports/:key" : "/weekly/:key", limit, async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const writerId = await writerIdentity(c.env, c.req.header("Authorization"));
      if (!c.env.DB || c.env.REMOTE_DATA_ORIGIN) throw new WriteError(503, "Report writing is unavailable.");
      const key = c.req.param("key");
      if (!isReportDate(key)) throw new WriteError(400, "Report date must be a valid YYYY-MM-DD date.");
      if (c.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new WriteError(415, "Use application/json.");
      const idempotencyKey = c.req.header("Idempotency-Key");
      if (!idempotencyKey || !/^[a-zA-Z0-9._:-]{1,128}$/.test(idempotencyKey)) throw new WriteError(400, "A valid Idempotency-Key is required.");
      const match = c.req.header("If-Match"), create = c.req.header("If-None-Match");
      if (match && !/^"[0-9]+-[a-f0-9]{64}"$/.test(match)) throw new WriteError(400, "If-Match must contain the ETag returned by GET.");
      if ((!match && create !== "*") || (match && create)) throw new WriteError(428, "Use If-Match for updates or If-None-Match: * for creation.");
      let input: unknown;
      try { input = await c.req.json(); } catch { throw new WriteError(400, "Invalid JSON."); }
      const payload = validateReportPayload(kind, input);
      if ((payload.schemaVersion === "daily-v1" ? payload.reportDate : payload.weekEnd) !== key) throw new WriteError(422, "Path date and report date differ.");
      const data = await persistReport(c.env.DB, kind, key, payload, writerId, idempotencyKey, match ?? "*");
      c.header("ETag", data.etag);
      return c.json({ data });
    } catch (error) {
      const status = error instanceof WriteError ? error.status : error instanceof ReportValidationError ? 422 : 503;
      const message = error instanceof WriteError || error instanceof ReportValidationError ? error.message : "Report writing is unavailable.";
      return c.json({ error: { message, status } }, status);
    }
  });
}
