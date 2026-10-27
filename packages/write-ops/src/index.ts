import { CompanyScope } from "../../../apps/wetrop/src/scope.ts";
import Database from "@steward/sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { recordAudit, type AuditActor } from "@steward/audit-log";

export type WriteOpStatus =
  | "scheduled"
  | "started"
  | "script_returned"
  | "confirmed"
  | "unknown"
  | "failed"
  | "restart_prepared"
  | "retrying"
  | "retry_exhausted"
  | "needs_review";

export type WriteOpKind =
  | "telegram.send"
  | "document.publish"
  | "mail.send"
  | "mail.reply"
  | "calendar.create"
  | "calendar.update"
  | "calendar.delete";

export interface WriteOpInput {
  kind: WriteOpKind;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface WriteOpRow extends WriteOpInput {
  id: string;
  status: WriteOpStatus;
  attempts: number;
  confirmAttempts: number;
  startedAt: number;
  attemptedAt?: number | null;
  updatedAt: number;
  scriptFinishedAt: number | null;
  scriptFinishedAtMs?: number | null;
  confirmedAt: number | null;
  /** For status "scheduled": unix seconds at/after which the op should be sent. */
  scheduledFor: number | null;
  lastError: string | null;
  result: Record<string, unknown> | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS write_ops (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  confirm_attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  script_finished_at INTEGER,
  confirmed_at INTEGER,
  scheduled_for INTEGER,
  input_json TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  result_json TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_write_ops_status ON write_ops(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_write_ops_kind_started ON write_ops(kind, started_at);
`;

export function writeOpsDir(): string {
  return new CompanyScope().mkdir(".wetrop/database/write-ops", true);
}

export function writeOpsDbPath(): string {
  return join(writeOpsDir(), "ops.db");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function bodySnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

export class WriteOpsStore {
  readonly raw: Database.Database;
  /**
   * Who this instance's state transitions get attributed to in the audit log.
   * mail-mcp/calendar-mcp open a store within a live chat turn ("host", the
   * default); apps/scheduler opens its own instance to fire due sends and
   * reconcile confirmations with no session attached — pass "scheduler" there
   * so the Audit page doesn't misattribute unattended retries to a live user.
   */
  private readonly actor: AuditActor;

  constructor(db: Database.Database, actor: AuditActor = "host") {
    this.raw = db;
    this.actor = actor;
    this.raw.pragma("journal_mode = WAL");
    this.raw.exec(SCHEMA);
    // Migrate older DBs that predate scheduled sends (add the column BEFORE its
    // index — an old table lacks the column, so the index can't be in SCHEMA).
    const cols = new Set((this.raw.prepare("PRAGMA table_info(write_ops)").all() as { name: string }[]).map((c) => c.name));
    if (!cols.has("scheduled_for")) this.raw.exec("ALTER TABLE write_ops ADD COLUMN scheduled_for INTEGER");
    if (!cols.has("script_finished_at_ms")) this.raw.exec("ALTER TABLE write_ops ADD COLUMN script_finished_at_ms INTEGER");
    if (!cols.has("attempted_at")) this.raw.exec("ALTER TABLE write_ops ADD COLUMN attempted_at INTEGER");
    this.raw.exec("CREATE INDEX IF NOT EXISTS idx_write_ops_scheduled ON write_ops(status, scheduled_for)");
  }

  static open(path = writeOpsDbPath(), actor: AuditActor = "host"): WriteOpsStore {
    return new WriteOpsStore(new Database(path), actor);
  }

  close(): void {
    this.raw.close();
  }

  start(op: WriteOpInput): string {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare(
      `INSERT INTO write_ops
       (id, kind, status, attempts, confirm_attempts, started_at, updated_at, input_json, expected_json)
       VALUES (?, ?, 'started', 1, 0, ?, ?, ?, ?)`,
    ).run(id, op.kind, now, now, JSON.stringify(op.input), JSON.stringify(op.expected));
    auditWriteOp(this.actor, "write.started", id, op.kind, "high", true, { input: op.input, expected: op.expected });
    return id;
  }

  /** Enqueue a deferred send/reply to fire at `scheduledFor` (unix seconds). */
  startScheduled(op: WriteOpInput, scheduledFor: number): string {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare(
      `INSERT INTO write_ops
       (id, kind, status, attempts, confirm_attempts, started_at, updated_at, scheduled_for, input_json, expected_json)
       VALUES (?, ?, 'scheduled', 0, 0, ?, ?, ?, ?, ?)`,
    ).run(id, op.kind, now, now, scheduledFor, JSON.stringify(op.input), JSON.stringify(op.expected));
    auditWriteOp(this.actor, "write.scheduled", id, op.kind, "high", true, { input: op.input, expected: op.expected, scheduledFor });
    return id;
  }

  /** Scheduled ops whose time has come (status 'scheduled' and due). */
  dueScheduled(now: number, limit = 50): WriteOpRow[] {
    const rows = this.raw.prepare(
      "SELECT * FROM write_ops WHERE status='scheduled' AND scheduled_for <= ? ORDER BY scheduled_for ASC LIMIT ?",
    ).all(now, limit) as Record<string, unknown>[];
    return rows.map(rowToWriteOp);
  }

  /** Atomic pre-send claim; a crash leaves started/uncertain, never scheduled again. */
  claimScheduled(id: string, now = Math.floor(Date.now() / 1000)): WriteOpRow | null {
    const changed = this.raw.prepare(`UPDATE write_ops SET status='started', attempts=attempts+1,
      attempted_at=?, updated_at=? WHERE id=? AND status='scheduled' AND scheduled_for<=?`)
      .run(now, now, id, now).changes;
    if (!changed) return null;
    const row = this.get(id)!;
    auditWriteOp(this.actor, "write.claimed", id, row.kind, "high", true, { attemptedAt: now });
    return row;
  }

  markNeedsReview(id: string, error: string): void {
    this.raw.prepare("UPDATE write_ops SET status='needs_review', updated_at=?, last_error=? WHERE id=?")
      .run(Math.floor(Date.now() / 1000), error, id);
    const row = this.get(id);
    auditWriteOp(this.actor, "write.needs_review", id, row?.kind ?? "mail.send", "high", false, { error });
  }

  listForReview(limit = 20): WriteOpRow[] {
    return (this.raw.prepare("SELECT * FROM write_ops WHERE status IN ('needs_review','retry_exhausted') ORDER BY updated_at DESC LIMIT ?")
      .all(Math.min(100, Math.max(1, Math.floor(limit)))) as Record<string, unknown>[]).map(rowToWriteOp);
  }

  /** All still-pending scheduled ops (for listing). */
  listScheduled(limit = 100): WriteOpRow[] {
    const rows = this.raw.prepare(
      "SELECT * FROM write_ops WHERE status='scheduled' ORDER BY scheduled_for ASC LIMIT ?",
    ).all(limit) as Record<string, unknown>[];
    return rows.map(rowToWriteOp);
  }

  /** Cancel a still-pending scheduled op. Returns false if it isn't scheduled (e.g. already fired). */
  cancelScheduled(id: string): boolean {
    const row = this.get(id);
    const changed = this.raw.prepare("DELETE FROM write_ops WHERE id=? AND status='scheduled'").run(id).changes > 0;
    if (changed) auditWriteOp(this.actor, "write.cancelled", id, row?.kind ?? "mail.send", "high", true, { row });
    return changed;
  }

  scriptReturned(id: string, result: Record<string, unknown> = {}): void {
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare(
      `UPDATE write_ops
       SET status='script_returned', script_finished_at=?, script_finished_at_ms=?, updated_at=?, result_json=?, last_error=NULL
       WHERE id=?`,
    ).run(now, Date.now(), now, JSON.stringify(result), id);
    const row = this.get(id);
    auditWriteOp(this.actor, "write.script_returned", id, row?.kind ?? "mail.send", "high", true, { result, row });
  }

  failed(id: string, err: unknown): void {
    const now = Math.floor(Date.now() / 1000);
    const message = err instanceof Error ? err.message : String(err);
    const status: WriteOpStatus = /timed out|timeout|-1712|connection is invalid|-609/i.test(message) ? "unknown" : "failed";
    this.raw.prepare(
      `UPDATE write_ops
       SET status=?, script_finished_at=?, script_finished_at_ms=?, updated_at=?, last_error=?
       WHERE id=?`,
    ).run(status, now, Date.now(), now, message, id);
    const row = this.get(id);
    auditWriteOp(this.actor, `write.${status}`, id, row?.kind ?? "mail.send", "high", false, { error: message, row });
  }

  markConfirmed(id: string, result: Record<string, unknown> = {}): void {
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare(
      `UPDATE write_ops
       SET status='confirmed', confirmed_at=?, updated_at=?, result_json=?
       WHERE id=?`,
    ).run(now, now, JSON.stringify(result), id);
    const row = this.get(id);
    auditWriteOp(this.actor, "write.confirmed", id, row?.kind ?? "mail.send", "high", true, { result, row });
  }

  incrementConfirmAttempt(id: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare("UPDATE write_ops SET confirm_attempts=confirm_attempts+1, updated_at=? WHERE id=?").run(now, id);
    const row = this.get(id);
    auditWriteOp(this.actor, "write.confirm_attempt", id, row?.kind ?? "mail.send", "medium", true, { row });
  }

  markRetrying(id: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare("UPDATE write_ops SET status='retrying', attempts=attempts+1, updated_at=? WHERE id=?").run(now, id);
    const row = this.get(id);
    auditWriteOp(this.actor, "write.retrying", id, row?.kind ?? "mail.send", "high", true, { row });
  }

  markRestartPrepared(id: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare("UPDATE write_ops SET status='restart_prepared', updated_at=? WHERE id=?").run(now, id);
    const row = this.get(id);
    auditWriteOp(this.actor, "write.restart_prepared", id, row?.kind ?? "mail.send", "high", true, { row });
  }

  markRetryExhausted(id: string, error: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.raw.prepare("UPDATE write_ops SET status='retry_exhausted', updated_at=?, last_error=? WHERE id=?").run(now, error, id);
    const row = this.get(id);
    auditWriteOp(this.actor, "write.retry_exhausted", id, row?.kind ?? "mail.send", "high", false, { error, row });
  }

  get(id: string): WriteOpRow | null {
    const row = this.raw.prepare("SELECT * FROM write_ops WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToWriteOp(row) : null;
  }

  pendingForConfirmation(kinds: WriteOpKind[], limit = 100): WriteOpRow[] {
    const placeholders = kinds.map(() => "?").join(",");
    const staleStartedBefore = Math.floor(Date.now() / 1000) - 60;
    const rows = this.raw.prepare(
      `SELECT * FROM write_ops
       WHERE kind IN (${placeholders})
         AND (status IN ('script_returned','unknown','failed','restart_prepared','retrying')
              OR (status='started' AND updated_at<=?))
       ORDER BY started_at ASC
       LIMIT ?`,
    ).all(...kinds, staleStartedBefore, limit) as Record<string, unknown>[];
    return rows.map(rowToWriteOp);
  }
}

function auditWriteOp(
  actor: AuditActor,
  eventType: string,
  id: string,
  kind: WriteOpKind,
  risk: "medium" | "high",
  ok: boolean,
  payload: Record<string, unknown>,
): void {
  recordAudit({
    actor,
    eventType,
    risk,
    summary: `${kind} ${id}: ${eventType.replace(/^write\./, "")}`,
    ok,
    correlationId: id,
    payload: { id, kind, ...payload },
  });
}

function rowToWriteOp(row: Record<string, unknown>): WriteOpRow {
  return {
    id: row.id as string,
    kind: row.kind as WriteOpKind,
    status: row.status as WriteOpStatus,
    attempts: Number(row.attempts ?? 0),
    confirmAttempts: Number(row.confirm_attempts ?? 0),
    startedAt: Number(row.started_at),
    attemptedAt: row.attempted_at == null ? null : Number(row.attempted_at),
    updatedAt: Number(row.updated_at),
    scriptFinishedAt: row.script_finished_at == null ? null : Number(row.script_finished_at),
    scriptFinishedAtMs: row.script_finished_at_ms == null ? null : Number(row.script_finished_at_ms),
    confirmedAt: row.confirmed_at == null ? null : Number(row.confirmed_at),
    scheduledFor: row.scheduled_for == null ? null : Number(row.scheduled_for),
    input: JSON.parse((row.input_json as string) || "{}"),
    expected: JSON.parse((row.expected_json as string) || "{}"),
    result: row.result_json == null ? null : JSON.parse(row.result_json as string),
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}
