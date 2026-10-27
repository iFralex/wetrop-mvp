import Database from "@steward/sqlite";
import { randomUUID } from "node:crypto";
import type { DomainEvent, PendingWatchEvent, WatchDefinition, WatchRecord, WatchRule, WatchToolGrant } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  rules TEXT NOT NULL,
  instruction TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  snapshot TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  last_error TEXT,
  authorized_tools TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_watches_active ON watches(status, expires_at);
CREATE TABLE IF NOT EXISTS watch_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  watch_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  last_error TEXT,
  notification_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_watch_events_pending ON watch_events(status, created_at);
CREATE TABLE IF NOT EXISTS watch_event_rules (
  event_id TEXT NOT NULL,
  watch_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  PRIMARY KEY (event_id, rule_id)
);
CREATE INDEX IF NOT EXISTS idx_watch_event_rules_fired ON watch_event_rules(watch_id, rule_id);
CREATE TABLE IF NOT EXISTS watch_action_runs (
  action_key TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  last_error TEXT
);
`;

export class WatchStore {
  private constructor(readonly raw: Database.Database) {}

  static open(path: string): WatchStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    ensureColumn(db, "watch_events", "notification_text", "TEXT");
    ensureColumn(db, "watch_events", "matched_rules", "TEXT");
    ensureColumn(db, "watches", "authorized_tools", "TEXT NOT NULL DEFAULT '[]'");
    db.exec(`INSERT OR IGNORE INTO watch_event_rules(event_id,watch_id,rule_id)
      SELECT id,watch_id,rule_id FROM watch_events`);
    return new WatchStore(db);
  }

  create(definition: WatchDefinition, snapshot: unknown, defaultExpiry: number): WatchRecord {
    const now = Date.now();
    const record: WatchRecord = {
      ...definition, id: randomUUID(), status: "active", snapshot,
      expiresAt: definition.expiresAt ?? defaultExpiry, createdAt: now, updatedAt: now,
    };
    this.raw.prepare(`INSERT INTO watches
      (id,source,resource_ref,rules,instruction,chat_id,status,snapshot,expires_at,created_at,updated_at,authorized_tools)
      VALUES (@id,@source,@resourceRef,@rules,@instruction,@chatId,@status,@snapshot,@expiresAt,@createdAt,@updatedAt,@authorizedToolsJson)`)
      .run({ ...record, rules: JSON.stringify(record.rules), snapshot: JSON.stringify(snapshot), authorizedToolsJson: JSON.stringify(record.authorizedTools ?? []) });
    return record;
  }

  get(id: string): WatchRecord | null {
    const row = this.raw.prepare("SELECT * FROM watches WHERE id=?").get(id) as WatchRow | undefined;
    return row ? watchFromRow(row) : null;
  }

  stop(id: string): WatchRecord | null {
    this.raw.prepare("UPDATE watches SET status='stopped', updated_at=? WHERE id=? AND status='active'").run(Date.now(), id);
    return this.get(id);
  }

  expireDue(now = Date.now()): WatchRecord[] {
    const due = (this.raw.prepare("SELECT * FROM watches WHERE status='active' AND expires_at<=? ORDER BY created_at").all(now) as WatchRow[])
      .map(watchFromRow);
    if (!due.length) return [];
    this.raw.prepare("UPDATE watches SET status='expired', updated_at=? WHERE status='active' AND expires_at<=?").run(now, now);
    return due.map((watch) => ({ ...watch, status: "expired", updatedAt: now }));
  }

  active(): WatchRecord[] {
    return (this.raw.prepare("SELECT * FROM watches WHERE status='active' ORDER BY created_at").all() as WatchRow[]).map(watchFromRow);
  }

  updateSnapshot(id: string, snapshot: unknown, terminal: boolean): void {
    const now = Date.now();
    this.raw.prepare("UPDATE watches SET snapshot=?, status=?, last_checked_at=?, last_error=NULL, updated_at=? WHERE id=?")
      .run(JSON.stringify(snapshot), terminal ? "completed" : "active", now, now, id);
  }

  updateError(id: string, error: string): void {
    this.raw.prepare("UPDATE watches SET last_checked_at=?, last_error=?, updated_at=? WHERE id=?")
      .run(Date.now(), error.slice(0, 500), Date.now(), id);
  }

  hasRuleFired(watchId: string, ruleId: string): boolean {
    return !!this.raw.prepare("SELECT 1 FROM watch_event_rules WHERE watch_id=? AND rule_id=? LIMIT 1").get(watchId, ruleId);
  }

  enqueue(watch: WatchRecord, rules: WatchRule[], event: DomainEvent): boolean {
    if (!rules.length) return false;
    const id = randomUUID();
    const eventKey = `${watch.id}:${event.key}`;
    const insertEvent = this.raw.prepare(`INSERT OR IGNORE INTO watch_events
      (id,event_key,watch_id,rule_id,rule,matched_rules,event,status,attempts,created_at)
      VALUES (?,?,?,?,?,?,?,'pending',0,?)`);
    const insertRule = this.raw.prepare(`INSERT OR IGNORE INTO watch_event_rules(event_id,watch_id,rule_id) VALUES (?,?,?)`);
    return this.raw.transaction(() => {
      const info = insertEvent.run(id, eventKey, watch.id, rules[0].id, JSON.stringify(rules[0]), JSON.stringify(rules), JSON.stringify(event), Date.now());
      if (!info.changes) return false;
      for (const rule of rules) insertRule.run(id, watch.id, rule.id);
      return true;
    })();
  }

  pending(limit = 20): PendingWatchEvent[] {
    const rows = this.raw.prepare(`SELECT e.*, w.chat_id, w.instruction, w.resource_ref, w.authorized_tools
      FROM watch_events e JOIN watches w ON w.id=e.watch_id
      WHERE e.status='pending' ORDER BY e.created_at LIMIT ?`).all(limit) as EventRow[];
    return rows.map((row) => ({
      id: row.id, watchId: row.watch_id, chatId: row.chat_id, instruction: row.instruction,
      resourceRef: row.resource_ref,
      rules: row.matched_rules ? JSON.parse(row.matched_rules) as WatchRule[] : [JSON.parse(row.rule) as WatchRule],
      event: JSON.parse(row.event) as DomainEvent, attempts: row.attempts,
      ...(row.notification_text ? { notificationText: row.notification_text } : {}),
    }));
  }

  setNotificationText(id: string, text: string): void {
    this.raw.prepare("UPDATE watch_events SET notification_text=? WHERE id=?").run(text.slice(0, 1000), id);
  }

  delivered(id: string): void {
    this.raw.prepare("UPDATE watch_events SET status='delivered', delivered_at=?, last_error=NULL WHERE id=?").run(Date.now(), id);
  }

  deliveryFailed(id: string, error: string, retry = true): void {
    this.raw.prepare("UPDATE watch_events SET status=?, attempts=attempts+1, last_error=? WHERE id=?")
      .run(retry ? "pending" : "failed", error.slice(0, 500), id);
  }

  claimAction(eventId: string, ruleId: string, tool: string): boolean {
    const key = `${eventId}:${ruleId}:${tool}`;
    return this.raw.prepare(`INSERT OR IGNORE INTO watch_action_runs
      (action_key,event_id,rule_id,tool,status,started_at) VALUES (?,?,?,?,'claimed',?)`)
      .run(key, eventId, ruleId, tool, Date.now()).changes > 0;
  }

  hasActionClaim(eventId: string, tool: string): boolean {
    return !!this.raw.prepare("SELECT 1 FROM watch_action_runs WHERE event_id=? AND tool=? LIMIT 1").get(eventId, tool);
  }

  finishAction(eventId: string, ruleId: string, tool: string, error?: string): void {
    this.raw.prepare(`UPDATE watch_action_runs SET status=?, finished_at=?, last_error=? WHERE action_key=?`)
      .run(error ? "failed" : "completed", Date.now(), error?.slice(0, 500) ?? null, `${eventId}:${ruleId}:${tool}`);
  }

  close(): void { this.raw.close(); }
}

interface WatchRow {
  id: string; source: string; resource_ref: string; rules: string; instruction: string; chat_id: string;
  status: WatchRecord["status"]; snapshot: string; expires_at: number; created_at: number; updated_at: number;
  last_checked_at: number | null; last_error: string | null;
  authorized_tools: string;
}
interface EventRow {
  id: string; watch_id: string; rule: string; event: string; attempts: number; chat_id: string; instruction: string;
  notification_text: string | null; resource_ref: string; matched_rules: string | null;
}

function ensureColumn(db: Database.Database, table: string, column: string, declaration: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}
function watchFromRow(row: WatchRow): WatchRecord {
  const legacyTools = JSON.parse(row.authorized_tools ?? "[]") as string[];
  const rawRules = JSON.parse(row.rules) as WatchRule[];
  const rules = rawRules.map((rule) => rule.grants?.length || !legacyTools.length ? rule : {
    ...rule,
    grants: legacyTools.flatMap((tool): WatchToolGrant[] => tool === "mcp__voice__call_start" ? [{ tool }] : []),
  });
  return {
    id: row.id, source: row.source, resourceRef: row.resource_ref, rules,
    instruction: row.instruction, chatId: row.chat_id, status: row.status, snapshot: JSON.parse(row.snapshot),
    ...(legacyTools.length
      ? { authorizedTools: legacyTools }
      : {}),
    expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}
