import Database from "@steward/sqlite";
import { recordAudit } from "@steward/audit-log";
import type { ActionItem, ActionKind, ActionStatus, ActionTextLanguage, Flow, FlowMatch, UpsertAction, UpsertFlow } from "./types.ts";
import { normalizeActionTextLanguage } from "./action-language.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'normal',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  due_at INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_status_due ON actions(status, due_at);
CREATE INDEX IF NOT EXISTS idx_actions_kind ON actions(kind);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_messages (
  message_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seen_at ON seen_messages(seen_at);
CREATE TABLE IF NOT EXISTS flows (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  when_text TEXT NOT NULL,
  guidance TEXT NOT NULL,
  exclusions TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  embedding TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flows_enabled ON flows(enabled, updated_at);
`;

const AUTOMATION_SETTINGS_KEY = "automationSettings";

export interface ActionAutomationSettings {
  enabled: boolean;
  /** Create Action Center reminders for upcoming Calendar events. */
  calendarEnabled: boolean;
  calendarEnabledAt?: number | null;
  /** Language for user-facing Action card text; default lets the planner follow context. */
  textLanguage: ActionTextLanguage;
  /** Unix timestamp: after a re-enable, only newer source items may create Actions. */
  enabledAt: number | null;
  updatedAt: number | null;
}

export class ActionStore {
  private constructor(readonly raw: Database.Database) {}

  static open(path: string): ActionStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    return new ActionStore(db);
  }

  upsert(input: UpsertAction, opts: { mergeIntoId?: number } = {}): { id: number; inserted: boolean; updated: boolean } {
    const now = Math.floor(Date.now() / 1000);
    const existing = typeof opts.mergeIntoId === "number"
      ? this.getExistingById(opts.mergeIntoId)
      : this.findExisting(input);
    const payloadObject = existing && typeof opts.mergeIntoId === "number"
      ? mergeRelatedPayload(existing, input, now)
      : input.payload ?? {};
    const payload = JSON.stringify(payloadObject);

    if (!existing) {
      const info = this.raw.prepare(
        `INSERT INTO actions(source_key,source_kind,kind,status,priority,title,summary,due_at,payload,created_at,updated_at)
         VALUES (@source_key,@source_kind,@kind,'new',@priority,@title,@summary,@due_at,@payload,@now,@now)`,
      ).run({
        source_key: input.sourceKey,
        source_kind: input.sourceKind,
        kind: input.kind,
        priority: input.priority ?? "normal",
        title: input.title,
        summary: input.summary,
        due_at: input.dueAt ?? null,
        payload,
        now,
      });
      const id = Number(info.lastInsertRowid);
      recordAudit({
        actor: "scheduler",
        eventType: "action.created",
        risk: input.priority === "high" ? "medium" : "low",
        summary: input.title,
        actionId: id,
        payload: {
          sourceKey: input.sourceKey, sourceKind: input.sourceKind, kind: input.kind,
          priority: input.priority, summary: input.summary, dueAt: input.dueAt,
          appliedFlowIds: appliedFlowIds(payloadObject),
        },
      });
      return { id, inserted: true, updated: false };
    }

    // Completed/dismissed actions are intentionally sticky: future scans should
    // not resurrect something the user already handled unless its source key
    // changes (e.g. a newer message id). For mail threads, however, a newer
    // message in the same thread is a new user-visible event, so reopen it.
    const reopening = existing.status === "done" || existing.status === "dismissed";
    if (reopening) {
      if (!shouldReopenHandledMail(existing.payload, input.payload)) {
        return { id: existing.id, inserted: false, updated: false };
      }
    }

    this.raw.prepare(
      `UPDATE actions
       SET source_key=@source_key, source_kind=@source_kind, kind=@kind,
           status=@status, priority=@priority, title=@title,
           summary=@summary, due_at=@due_at, payload=@payload, updated_at=@now
       WHERE id=@id`,
    ).run({
      id: existing.id,
      source_key: typeof opts.mergeIntoId === "number" ? existing.sourceKey : input.sourceKey,
      source_kind: input.sourceKind,
      kind: input.kind,
      status: reopening ? "new" : existing.status,
      priority: input.priority ?? "normal",
      title: input.title,
      summary: input.summary,
      due_at: input.dueAt ?? null,
      payload,
      now,
    });
    if (reopening) {
      recordAudit({
        actor: "scheduler",
        eventType: "action.reopened",
        risk: "low",
        summary: input.title,
        actionId: existing.id,
        payload: {
          sourceKey: input.sourceKey, sourceKind: input.sourceKind, kind: input.kind,
          reason: "new activity on a previously handled thread", appliedFlowIds: appliedFlowIds(payloadObject),
        },
      });
    } else {
      recordAudit({
        actor: "scheduler", eventType: "action.updated", risk: "low", summary: input.title,
        actionId: existing.id,
        payload: {
          sourceKey: input.sourceKey, sourceKind: input.sourceKind, kind: input.kind,
          summary: input.summary, appliedFlowIds: appliedFlowIds(payloadObject),
        },
      });
    }
    return { id: existing.id, inserted: false, updated: true };
  }

  private getExistingById(id: number): ExistingAction | undefined {
    const row = this.raw.prepare("SELECT id, source_key, status, title, summary, payload, updated_at FROM actions WHERE id=?")
      .get(id) as ExistingActionRow | undefined;
    return row ? existingFromRow(row) : undefined;
  }

  private findExisting(input: UpsertAction): ExistingAction | undefined {
    const byKey = this.raw.prepare(
      `SELECT id, source_key, status, title, summary, payload, updated_at FROM actions
       WHERE source_key=? OR EXISTS (
         SELECT 1 FROM json_each(actions.payload, '$.relatedSourceKeys') WHERE value=?
       )
       LIMIT 1`,
    ).get(input.sourceKey, input.sourceKey) as ExistingActionRow | undefined;
    if (byKey) return existingFromRow(byKey);

    const threadId = input.sourceKind === "mail" ? input.payload?.threadId : null;
    if (typeof threadId !== "number" || !Number.isFinite(threadId)) return undefined;

    // Migration bridge for older rows keyed by message id: if they already
    // represent the same thread, update that row instead of creating a duplicate.
    const byThread = this.raw.prepare(
      `SELECT id, source_key, status, title, summary, payload, updated_at FROM actions
       WHERE source_kind='mail'
         AND (json_extract(payload, '$.threadId') = ? OR EXISTS (
           SELECT 1 FROM json_each(actions.payload, '$.relatedThreadIds') WHERE value=?
         ))
       ORDER BY updated_at DESC
       LIMIT 1`,
    ).get(threadId, threadId) as ExistingActionRow | undefined;
    return byThread ? existingFromRow(byThread) : undefined;
  }

  /** Update only an action's summary (and updated_at) — never its status. Used when a
   * message on a different thread appears to resolve/update an open action, so the
   * user reviews and confirms the resolution themselves rather than it auto-closing. */
  updateSummary(id: number, summary: string): boolean {
    const info = this.raw.prepare("UPDATE actions SET summary=?, updated_at=? WHERE id=?")
      .run(summary, Math.floor(Date.now() / 1000), id);
    return info.changes > 0;
  }

  mark(id: number, status: ActionStatus): boolean {
    const info = this.raw.prepare("UPDATE actions SET status=?, updated_at=? WHERE id=?")
      .run(status, Math.floor(Date.now() / 1000), id);
    return info.changes > 0;
  }

  get(id: number): ActionItem | null {
    const row = this.raw.prepare("SELECT * FROM actions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToAction(row) : null;
  }

  list(opts: { includeDone?: boolean; hideExpired?: boolean; status?: ActionStatus; kind?: ActionKind; limit?: number } = {}): ActionItem[] {
    // Defence in depth: callers other than the MCP tool also use the store, so
    // enforce the same cap here rather than trusting schema validation alone.
    const requestedLimit = typeof opts.limit === "number" && Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 50;
    const limit = Math.max(1, Math.min(100, requestedLimit));
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      conditions.push("status = ?");
      params.push(opts.status);
    } else if (!opts.includeDone) {
      conditions.push("status IN ('new','read')");
    }
    if (opts.kind) {
      conditions.push("kind = ?");
      params.push(opts.kind);
    }
    if (opts.hideExpired) {
      conditions.push("(due_at IS NULL OR due_at >= ?)");
      params.push(Math.floor(Date.now() / 1000));
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    const rows = this.raw.prepare(
      `SELECT * FROM actions
       ${where}
       ORDER BY COALESCE(due_at, 9223372036854775807), priority DESC, updated_at DESC
       LIMIT ?`,
    ).all(...params) as Record<string, unknown>[];
    return rows.map(rowToAction);
  }

  counts(opts: { includeDone?: boolean; hideExpired?: boolean } = {}): Record<ActionStatus, number> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (!opts.includeDone && Object.keys(opts).length > 0) conditions.push("status IN ('new','read')");
    if (opts.hideExpired) {
      conditions.push("(due_at IS NULL OR due_at >= ?)");
      params.push(Math.floor(Date.now() / 1000));
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.raw.prepare(`SELECT status, count(*) AS cnt FROM actions ${where} GROUP BY status`).all(...params) as
      { status: ActionStatus; cnt: number }[];
    return { new: 0, read: 0, done: 0, dismissed: 0, ...Object.fromEntries(rows.map((r) => [r.status, r.cnt])) };
  }

  setMeta(key: string, value: unknown): void {
    this.raw.prepare(
      `INSERT INTO meta(key,value,updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(key, JSON.stringify(value), Math.floor(Date.now() / 1000));
  }

  getMeta<T = unknown>(key: string): T | null {
    const row = this.raw.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  getAutomationSettings(): ActionAutomationSettings {
    const saved = this.getMeta<Partial<ActionAutomationSettings>>(AUTOMATION_SETTINGS_KEY);
    return {
      enabled: typeof saved?.enabled === "boolean" ? saved.enabled : true,
      calendarEnabled: typeof saved?.calendarEnabled === "boolean" ? saved.calendarEnabled : true,
      ...(saved?.calendarEnabledAt == null ? {} : { calendarEnabledAt: finiteNumberOrNull(saved.calendarEnabledAt) }),
      textLanguage: normalizeActionTextLanguage(saved?.textLanguage),
      enabledAt: finiteNumberOrNull(saved?.enabledAt),
      updatedAt: finiteNumberOrNull(saved?.updatedAt),
    };
  }

  setAutomationEnabled(enabled: boolean, now = Math.floor(Date.now() / 1000)): ActionAutomationSettings {
    const current = this.getAutomationSettings();
    if (current.enabled === enabled) return current;
    const next: ActionAutomationSettings = {
      enabled,
      calendarEnabled: current.calendarEnabled,
      ...(current.calendarEnabledAt == null ? {} : { calendarEnabledAt: current.calendarEnabledAt }),
      textLanguage: current.textLanguage,
      enabledAt: enabled ? now : null,
      updatedAt: now,
    };
    this.setMeta(AUTOMATION_SETTINGS_KEY, next);
    return next;
  }

  setCalendarEnabled(calendarEnabled: boolean, now = Math.floor(Date.now() / 1000)): ActionAutomationSettings {
    const current = this.getAutomationSettings();
    if (current.calendarEnabled === calendarEnabled) return current;
    const next: ActionAutomationSettings = { ...current, calendarEnabled, ...(calendarEnabled ? { calendarEnabledAt: now } : {}), updatedAt: now };
    this.setMeta(AUTOMATION_SETTINGS_KEY, next);
    return next;
  }

  setTextLanguage(textLanguage: ActionTextLanguage, now = Math.floor(Date.now() / 1000)): ActionAutomationSettings {
    const current = this.getAutomationSettings();
    if (current.textLanguage === textLanguage) return current;
    const next: ActionAutomationSettings = { ...current, textLanguage, updatedAt: now };
    this.setMeta(AUTOMATION_SETTINGS_KEY, next);
    return next;
  }

  // --- "already evaluated" ledger: mail we've run the planner on, so scans work
  //     only on genuinely new mail (or new replies) instead of re-evaluating. ---

  /** Message ids already evaluated (optionally only those seen at/after `sinceTs`). */
  loadSeen(sinceTs?: number): Set<string> {
    const rows = (typeof sinceTs === "number"
      ? this.raw.prepare("SELECT message_id FROM seen_messages WHERE seen_at >= ?").all(sinceTs)
      : this.raw.prepare("SELECT message_id FROM seen_messages").all()) as { message_id: string }[];
    return new Set(rows.map((r) => r.message_id));
  }

  markSeen(messageIds: string[], seenAt = Math.floor(Date.now() / 1000)): void {
    if (messageIds.length === 0) return;
    const stmt = this.raw.prepare("INSERT OR IGNORE INTO seen_messages(message_id, seen_at) VALUES (?, ?)");
    const tx = this.raw.transaction((ids: string[]) => { for (const id of ids) if (id) stmt.run(id, seenAt); });
    tx(messageIds);
  }

  hasAnySeen(): boolean {
    return !!this.raw.prepare("SELECT 1 FROM seen_messages LIMIT 1").get();
  }

  /** Drop old ledger rows (outside the scan window) to keep the table bounded. */
  pruneSeen(beforeTs: number): void {
    this.raw.prepare("DELETE FROM seen_messages WHERE seen_at < ?").run(beforeTs);
  }

  createFlow(input: UpsertFlow, embedding: number[] | null = null): Flow {
    const clean = normalizeFlowInput(input);
    const now = Math.floor(Date.now() / 1000);
    const info = this.raw.prepare(
      `INSERT INTO flows(name,when_text,guidance,exclusions,enabled,version,embedding,created_at,updated_at)
       VALUES (?,?,?,?,?,1,?,?,?)`,
    ).run(clean.name, clean.when, clean.guidance, clean.exclusions, clean.enabled ? 1 : 0, serializeEmbedding(embedding), now, now);
    return this.getFlow(Number(info.lastInsertRowid))!;
  }

  updateFlow(id: number, input: Partial<UpsertFlow>, embedding?: number[] | null): Flow | null {
    const current = this.getFlow(id);
    if (!current) return null;
    const clean = normalizeFlowInput({ ...current, ...input });
    const now = Math.floor(Date.now() / 1000);
    const storedEmbedding = embedding === undefined
      ? (this.raw.prepare("SELECT embedding FROM flows WHERE id=?").get(id) as { embedding: string | null }).embedding
      : serializeEmbedding(embedding);
    this.raw.prepare(
      `UPDATE flows SET name=?,when_text=?,guidance=?,exclusions=?,enabled=?,version=version+1,embedding=?,updated_at=? WHERE id=?`,
    ).run(clean.name, clean.when, clean.guidance, clean.exclusions, clean.enabled ? 1 : 0, storedEmbedding, now, id);
    return this.getFlow(id);
  }

  setFlowEnabled(id: number, enabled: boolean): Flow | null {
    return this.updateFlow(id, { enabled });
  }

  deleteFlow(id: number): boolean {
    return this.raw.prepare("DELETE FROM flows WHERE id=?").run(id).changes > 0;
  }

  getFlow(id: number): Flow | null {
    const row = this.raw.prepare("SELECT * FROM flows WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToFlow(row) : null;
  }

  listFlows(opts: { enabledOnly?: boolean; limit?: number } = {}): Flow[] {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 100);
    const rows = this.raw.prepare(
      `SELECT * FROM flows ${opts.enabledOnly ? "WHERE enabled=1" : ""} ORDER BY updated_at DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[];
    return rows.map(rowToFlow);
  }

  searchFlows(query: string, queryEmbedding: number[] | null, limit = 2): FlowMatch[] {
    const tokens = tokenize(query);
    const rows = this.raw.prepare("SELECT * FROM flows WHERE enabled=1").all() as Record<string, unknown>[];
    return rows.map((row) => {
      const flow = rowToFlow(row);
      const haystack = `${flow.name} ${flow.when}`;
      const lexical = lexicalScore(tokens, tokenize(haystack));
      const vector = cosine(queryEmbedding, parseEmbedding(row.embedding));
      const score = vector == null ? lexical : (vector * 0.72 + lexical * 0.28);
      return { ...flow, score };
    }).filter((match) => match.score >= 0.22)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(Math.floor(limit), 1), 2));
  }

  close(): void { this.raw.close(); }
}

function appliedFlowIds(payload: Record<string, unknown>): number[] {
  const snapshot = payload.contextSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
  const flows = (snapshot as Record<string, unknown>).flows;
  if (!Array.isArray(flows)) return [];
  return flows
    .map((flow) => flow && typeof flow === "object" ? Number((flow as Record<string, unknown>).id) : NaN)
    .filter(Number.isSafeInteger);
}

function normalizeFlowInput(input: UpsertFlow): Required<UpsertFlow> {
  const name = input.name?.trim().slice(0, 120);
  const when = input.when?.trim().slice(0, 600);
  const guidance = input.guidance?.trim().slice(0, 1600);
  const exclusions = (input.exclusions ?? "").trim().slice(0, 600);
  if (!name || !when || !guidance) throw new Error("name, when and guidance are required");
  return { name, when, guidance, exclusions, enabled: input.enabled !== false };
}

function rowToFlow(row: Record<string, unknown>): Flow {
  return { id: Number(row.id), name: String(row.name), when: String(row.when_text), guidance: String(row.guidance), exclusions: String(row.exclusions ?? ""), enabled: Number(row.enabled) === 1, version: Number(row.version), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

function serializeEmbedding(value: number[] | null): string | null {
  return value?.length ? JSON.stringify(value) : null;
}

function parseEmbedding(value: unknown): number[] | null {
  if (typeof value !== "string") return null;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) && parsed.every(Number.isFinite) ? parsed : null; } catch { return null; }
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9à-ÿ@]+/gi, " ").split(/\s+/).filter((t) => t.length >= 3));
}

function lexicalScore(query: Set<string>, document: Set<string>): number {
  if (!query.size || !document.size) return 0;
  let overlap = 0;
  for (const token of document) if (query.has(token)) overlap++;
  return Math.min(1, overlap / Math.max(2, Math.min(document.size, 8)));
}

function cosine(a: number[] | null, b: number[] | null): number | null {
  if (!a || !b || a.length !== b.length || !a.length) return null;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? Math.max(0, dot / Math.sqrt(aa * bb)) : null;
}

interface ExistingActionRow {
  id: number;
  source_key: string;
  status: ActionStatus;
  title: string;
  summary: string;
  payload: string;
  updated_at: number;
}

interface ExistingAction {
  id: number;
  sourceKey: string;
  status: ActionStatus;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  updatedAt: number;
}

function existingFromRow(row: ExistingActionRow): ExistingAction {
  return {
    id: row.id,
    sourceKey: row.source_key,
    status: row.status,
    title: row.title,
    summary: row.summary,
    payload: parsePayload(row.payload),
    updatedAt: row.updated_at,
  };
}

function mergeRelatedPayload(existing: ExistingAction, input: UpsertAction, now: number): Record<string, unknown> {
  const next = input.payload ?? {};
  const oldThreadId = finiteNumberOrNull(existing.payload.threadId);
  const nextThreadId = finiteNumberOrNull(next.threadId);
  const relatedSourceKeys = uniqueValues([
    ...stringArray(existing.payload.relatedSourceKeys),
    input.sourceKey,
  ]);
  const relatedThreadIds = uniqueValues([
    ...numberArray(existing.payload.relatedThreadIds),
    ...(oldThreadId == null ? [] : [oldThreadId]),
    ...(nextThreadId == null ? [] : [nextThreadId]),
  ]);
  const history = [
    ...objectArray(existing.payload.relatedHistory),
    {
      sourceKey: existing.sourceKey,
      title: existing.title,
      summary: existing.summary,
      threadId: oldThreadId,
      recordedAt: existing.updatedAt,
    },
  ].slice(-5);
  return {
    ...next,
    relatedSourceKeys,
    relatedThreadIds,
    relatedHistory: history,
    mergedAt: now,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number" && Number.isFinite(v)) : [];
}

function objectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)) : [];
}

function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rowToAction(r: Record<string, unknown>): ActionItem {
  const payload = parsePayload(r.payload);
  return {
    id: Number(r.id),
    sourceKey: String(r.source_key),
    sourceKind: r.source_kind as ActionItem["sourceKind"],
    kind: r.kind as ActionItem["kind"],
    status: r.status as ActionItem["status"],
    priority: r.priority as ActionItem["priority"],
    title: String(r.title ?? ""),
    summary: String(r.summary ?? ""),
    dueAt: r.due_at == null ? null : Number(r.due_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    payload,
  };
}

function parsePayload(value: unknown): Record<string, unknown> {
  try {
    const p = JSON.parse(String(value ?? "{}"));
    if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
  } catch { /* keep empty */ }
  return {};
}

function shouldReopenHandledMail(existingPayload: Record<string, unknown>, incomingPayload: Record<string, unknown> | undefined): boolean {
  if (!incomingPayload) return false;
  const existingThread = existingPayload.threadId;
  const incomingThread = incomingPayload.threadId;
  if (typeof existingThread !== "number" || existingThread !== incomingThread) return false;
  const existingDate = typeof existingPayload.date === "number" ? existingPayload.date : 0;
  const incomingDate = typeof incomingPayload.date === "number" ? incomingPayload.date : 0;
  const existingMessage = typeof existingPayload.messageId === "string" ? existingPayload.messageId : "";
  const incomingMessage = typeof incomingPayload.messageId === "string" ? incomingPayload.messageId : "";
  return incomingDate > existingDate && incomingMessage !== existingMessage;
}
