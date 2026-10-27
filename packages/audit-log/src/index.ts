import { CompanyScope } from "../../../apps/wetrop/src/scope.ts";
/**
 * Shared audit ledger. This records "what happened" across chat, tools,
 * approvals, actions, files, and system routes without changing the behavior of
 * those flows. Callers should treat it as best-effort: audit failures must not
 * break user work.
 */
import Database from "@steward/sqlite";
import { join } from "node:path";

export type AuditActor = "user" | "assistant" | "host" | "scheduler" | "tool" | "system";
export type AuditRisk = "low" | "medium" | "high";

export interface AuditSourceRef {
  type: string;
  id?: string | number;
  url?: string;
  path?: string;
  label?: string;
}

export interface AuditEventInput {
  ts?: number;
  actor: AuditActor;
  eventType: string;
  risk?: AuditRisk;
  summary: string;
  sessionId?: string | null;
  chatId?: string | null;
  actionId?: number | null;
  toolName?: string | null;
  toolCallId?: string | null;
  correlationId?: string | null;
  ok?: boolean | null;
  durationMs?: number | null;
  payload?: unknown;
  sourceRefs?: AuditSourceRef[];
}

export interface AuditEvent extends Required<Omit<AuditEventInput, "payload" | "sourceRefs">> {
  id: number;
  payloadJson: unknown;
  redactedPayloadJson: unknown;
  sourceRefs: AuditSourceRef[];
}

export interface AuditQuery {
  limit?: number;
  cursor?: number;
  since?: number;
  until?: number;
  actor?: AuditActor;
  eventType?: string;
  risk?: AuditRisk;
  chatId?: string;
  actionId?: number;
  toolName?: string;
  q?: string;
}

export interface AuditPage {
  events: AuditEvent[];
  nextCursor: number | null;
  totals: { events: number; highRisk: number; failed: number };
  byType: { eventType: string; count: number }[];
  byActor: { actor: AuditActor; count: number }[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  risk TEXT NOT NULL,
  summary TEXT NOT NULL,
  session_id TEXT,
  chat_id TEXT,
  action_id INTEGER,
  tool_name TEXT,
  tool_call_id TEXT,
  correlation_id TEXT,
  ok INTEGER,
  duration_ms INTEGER,
  payload_json TEXT NOT NULL,
  redacted_payload_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_events_ts ON audit_events(ts);
CREATE INDEX IF NOT EXISTS idx_audit_events_type_ts ON audit_events(event_type, ts);
CREATE INDEX IF NOT EXISTS idx_audit_events_chat_ts ON audit_events(chat_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_events_action_ts ON audit_events(action_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_events_tool_ts ON audit_events(tool_name, ts);
`;

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|passwd|authorization|cookie|set-cookie|private[_-]?key|access[_-]?key|refresh[_-]?token|auth)/i;
// Full-text fields (email/message bodies, HTML, file/page content) never belong
// in the audit trail — only a short snippet, matching the `bodySnippet()`
// convention @steward/write-ops already uses for the same reason.
const CONTENT_KEY_RE = /^(body|bodytext|html|htmlbody|content|markdown)$/i;
const CONTENT_SNIPPET_LEN = 120;
const MAX_STRING = 600;
const MAX_ARRAY = 40;
const MAX_OBJECT_KEYS = 80;
const MAX_DEPTH = 8;

function contentSnippet(text: string): string {
  return redactString(text).replace(/\s+/g, " ").trim().slice(0, CONTENT_SNIPPET_LEN);
}


export function auditDir(): string {
  return new CompanyScope().mkdir(".wetrop/audit", true);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[MaxDepth]";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`[${value.length - MAX_ARRAY} more items]`);
    return out;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    for (const [key, inner] of entries) {
      if (SECRET_KEY_RE.test(key)) {
        out[key] = "[Redacted]";
      } else if (CONTENT_KEY_RE.test(key) && typeof inner === "string") {
        out[key] = contentSnippet(inner);
      } else {
        out[key] = redact(inner, depth + 1);
      }
    }
    const total = Object.keys(value as Record<string, unknown>).length;
    if (total > MAX_OBJECT_KEYS) out.__truncatedKeys = total - MAX_OBJECT_KEYS;
    return out;
  }
  return String(value);
}

function redactString(value: string): string {
  const compact = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [Redacted]")
    .replace(/sk-[A-Za-z0-9._-]{12,}/g, "sk-[Redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[Redacted]@")
    .replace(/([?&](?:[^=&#\s]*(?:token|key|secret|password|auth)[^=&#\s]*)=)[^&#\s]*/gi, "$1[Redacted]")
    .replace(/((?:api[_-]?key|password|passwd|secret|access[_-]?token|authorization)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "$1[Redacted]")
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, "[Redacted private key]");
  return compact.length > MAX_STRING ? `${compact.slice(0, MAX_STRING)}…[truncated ${compact.length - MAX_STRING} chars]` : compact;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify(String(value));
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.floor(limit ?? 100), 1), 500);
}

export class AuditLog {
  readonly raw: Database.Database;

  constructor(db: Database.Database) {
    this.raw = db;
    this.raw.pragma("busy_timeout = 2000");
    this.raw.pragma("journal_mode = WAL");
    this.raw.exec(SCHEMA);
  }

  static open(): AuditLog {
    return new AuditLog(new Database(join(auditDir(), "audit.db")));
  }

  record(input: AuditEventInput): number {
    const ts = input.ts ?? Date.now();
    const risk = input.risk ?? "low";
    // Only the redacted form is ever written to disk — payload_json and
    // redacted_payload_json intentionally hold the same value. The raw,
    // unredacted payload never touches the database, so secrets/full email
    // bodies/document content passed in by callers can't leak through a DB
    // backup or file read even before redact() is fixed for a new field name.
    const redactedPayloadJson = safeJson(redact(input.payload ?? null));
    const payloadJson = redactedPayloadJson;
    const sourceRefsJson = safeJson(redact(input.sourceRefs ?? []));
    const result = this.raw.prepare(
      `INSERT INTO audit_events (
         ts, actor, event_type, risk, summary, session_id, chat_id, action_id,
         tool_name, tool_call_id, correlation_id, ok, duration_ms,
         payload_json, redacted_payload_json, source_refs_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ts, input.actor, input.eventType, risk, redactString(input.summary),
      input.sessionId ?? null, input.chatId ?? null, input.actionId ?? null,
      input.toolName ?? null, input.toolCallId ?? null, input.correlationId ?? null,
      input.ok == null ? null : input.ok ? 1 : 0,
      input.durationMs ?? null,
      payloadJson, redactedPayloadJson, sourceRefsJson,
    );
    return Number(result.lastInsertRowid);
  }

  query(query: AuditQuery = {}): AuditPage {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (query.cursor != null) { clauses.push("id < ?"); values.push(query.cursor); }
    if (query.since != null) { clauses.push("ts >= ?"); values.push(query.since); }
    if (query.until != null) { clauses.push("ts <= ?"); values.push(query.until); }
    if (query.actor) { clauses.push("actor = ?"); values.push(query.actor); }
    if (query.eventType) { clauses.push("event_type = ?"); values.push(query.eventType); }
    if (query.risk) { clauses.push("risk = ?"); values.push(query.risk); }
    if (query.chatId) { clauses.push("chat_id = ?"); values.push(query.chatId); }
    if (query.actionId != null) { clauses.push("action_id = ?"); values.push(query.actionId); }
    if (query.toolName) { clauses.push("tool_name = ?"); values.push(query.toolName); }
    if (query.q?.trim()) {
      clauses.push("(summary LIKE ? OR event_type LIKE ? OR tool_name LIKE ? OR redacted_payload_json LIKE ?)");
      const like = `%${query.q.trim()}%`;
      values.push(like, like, like, like);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = normalizeLimit(query.limit);
    const rows = this.raw.prepare(
      `SELECT * FROM audit_events ${where} ORDER BY id DESC LIMIT ?`,
    ).all(...values, limit) as AuditRow[];
    const events = rows.map(rowToEvent);
    const nextCursor = events.length === limit ? events[events.length - 1].id : null;
    const totals = this.raw.prepare(
      `SELECT COUNT(*) events,
              SUM(CASE WHEN risk = 'high' THEN 1 ELSE 0 END) highRisk,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) failed
       FROM audit_events ${where}`,
    ).get(...values) as AuditPage["totals"];
    const byType = this.raw.prepare(
      `SELECT event_type eventType, COUNT(*) count
       FROM audit_events ${where} GROUP BY event_type ORDER BY count DESC LIMIT 30`,
    ).all(...values) as AuditPage["byType"];
    const byActor = this.raw.prepare(
      `SELECT actor, COUNT(*) count
       FROM audit_events ${where} GROUP BY actor ORDER BY count DESC`,
    ).all(...values) as AuditPage["byActor"];
    return {
      events,
      nextCursor,
      totals: {
        events: Number(totals.events ?? 0),
        highRisk: Number(totals.highRisk ?? 0),
        failed: Number(totals.failed ?? 0),
      },
      byType,
      byActor,
    };
  }
}

interface AuditRow {
  id: number;
  ts: number;
  actor: AuditActor;
  event_type: string;
  risk: AuditRisk;
  summary: string;
  session_id: string | null;
  chat_id: string | null;
  action_id: number | null;
  tool_name: string | null;
  tool_call_id: string | null;
  correlation_id: string | null;
  ok: number | null;
  duration_ms: number | null;
  payload_json: string;
  redacted_payload_json: string;
  source_refs_json: string;
}

function rowToEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    ts: row.ts,
    actor: row.actor,
    eventType: row.event_type,
    risk: row.risk,
    summary: row.summary,
    sessionId: row.session_id,
    chatId: row.chat_id,
    actionId: row.action_id,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    correlationId: row.correlation_id,
    ok: row.ok == null ? null : row.ok === 1,
    durationMs: row.duration_ms,
    payloadJson: parseJson(row.payload_json),
    redactedPayloadJson: parseJson(row.redacted_payload_json),
    sourceRefs: parseJson(row.source_refs_json) as AuditSourceRef[],
  };
}

let singleton: AuditLog | undefined;
export function auditLog(): AuditLog {
  return (singleton ??= AuditLog.open());
}

export function recordAudit(input: AuditEventInput): void {
  try {
    auditLog().record(input);
  } catch {
    /* audit is never allowed to break the product path */
  }
}
