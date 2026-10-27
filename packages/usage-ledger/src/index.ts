import { CompanyScope } from "../../../apps/wetrop/src/scope.ts";
/**
 * Shared persistent LLM usage ledger (SQLite). The gateway writes one row per
 * LLM call (llm_calls); the host writes tool invocations (tool_calls) and
 * reads the aggregations the Usage page shows. Two processes share the file:
 * WAL + busy_timeout. The legacy `turns` table (pre-metering per-turn ledger)
 * is intentionally neither created, written, nor read — history was reset.
 */
import Database from "@steward/sqlite";
import { join } from "node:path";

export interface LlmCallRecord {
  ts: number;
  service: string;
  action: string;
  sessionId?: string | null;
  tier: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  ok: boolean;
  status: number;
}

export interface ToolCallRecord {
  ts: number;
  sessionId: string;
  tool: string;
  durationMs: number;
  ok: boolean;
}

export interface VoiceCallRecord {
  ts: number;
  sessionId: string;
  transport: string;
  outcome: string;
  failureCode?: string | null;
  sipStatus?: number | null;
  durationMs: number;
  ok: boolean;
}

export interface ProviderAttempt {
  ts: number; requestId: string; service: string; action: string; model: string;
  status: number; durationMs: number; stream: boolean;
}

export interface LedgerSummary {
  providerAttempts?: ProviderAttempt[];
  totals: { calls: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number };
  byService: { service: string; cost: number; calls: number; tokens: number }[];
  byAction: { service: string; action: string; calls: number; cost: number; tokens: number; avgCost: number }[];
  byDay: { day: string; service: string; cost: number; calls: number; tokens: number }[];
  byModel: { model: string; cost: number; tokens: number; calls: number }[];
  byTier: { tier: string; input: number; output: number; cacheRead: number; cacheWrite: number }[];
  recent: {
    ts: number; service: string; action: string; model: string;
    input: number; output: number; cacheRead: number; cacheWrite: number;
    cost: number; durationMs: number; ok: number;
  }[];
  byTool: { tool: string; calls: number; errors: number; totalMs: number; avgMs: number; maxMs: number }[];
  toolTotals: { calls: number; errors: number; totalMs: number };
  voiceTotals: { calls: number; completed: number; failed: number; totalMs: number; avgMs: number };
  byVoiceOutcome: { outcome: string; calls: number }[];
  recentVoice: {
    ts: number; sessionId: string; transport: string; outcome: string;
    failureCode: string | null; sipStatus: number | null; durationMs: number; ok: number;
  }[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_attempts(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, request_id TEXT NOT NULL,
  service TEXT NOT NULL, action TEXT NOT NULL, model TEXT NOT NULL,
  status INTEGER NOT NULL, duration_ms INTEGER NOT NULL, stream INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_ts ON provider_attempts(ts);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  service TEXT NOT NULL DEFAULT 'unknown',
  action TEXT NOT NULL DEFAULT 'unknown',
  session_id TEXT,
  tier TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  status INTEGER NOT NULL DEFAULT 200
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_ts ON llm_calls(ts);
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT,
  tool TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_ts ON tool_calls(ts);
CREATE TABLE IF NOT EXISTS voice_calls (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  transport TEXT NOT NULL,
  outcome TEXT NOT NULL,
  failure_code TEXT,
  sip_status INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_voice_calls_ts ON voice_calls(ts);
`;

const TOKENS = "input_tokens + output_tokens + cache_read_tokens + cache_write_tokens";


export class UsageLedger {
  readonly raw: Database.Database;

  constructor(db: Database.Database) {
    this.raw = db;
    this.raw.pragma("busy_timeout = 2000");
    this.raw.pragma("journal_mode = WAL");
    this.raw.exec(SCHEMA);
  }

  static open(): UsageLedger {
    const dir = new CompanyScope().mkdir(".wetrop/database/usage", true);
    return new UsageLedger(new Database(join(dir, "usage.db")));
  }

  recordProviderAttempt(r: ProviderAttempt): void {
    this.raw.prepare(`INSERT INTO provider_attempts(ts,request_id,service,action,model,status,duration_ms,stream)
      VALUES (?,?,?,?,?,?,?,?)`).run(r.ts, r.requestId, r.service, r.action, r.model, r.status, r.durationMs, r.stream ? 1 : 0);
  }

  recordLlmCall(r: LlmCallRecord): void {
    this.raw.prepare(
      `INSERT INTO llm_calls (ts, service, action, session_id, tier, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_usd, duration_ms, ok, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.ts, r.service, r.action, r.sessionId ?? null, r.tier, r.model,
      r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens,
      r.costUsd, r.durationMs, r.ok ? 1 : 0, r.status,
    );
  }

  recordTool(t: ToolCallRecord): void {
    this.raw.prepare(
      `INSERT INTO tool_calls (ts, session_id, tool, duration_ms, ok) VALUES (?, ?, ?, ?, ?)`,
    ).run(t.ts, t.sessionId, t.tool, t.durationMs, t.ok ? 1 : 0);
  }

  recordVoiceCall(v: VoiceCallRecord): void {
    this.raw.prepare(
      `INSERT INTO voice_calls (ts, session_id, transport, outcome, failure_code, sip_status, duration_ms, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(v.ts, v.sessionId, v.transport, v.outcome, v.failureCode ?? null, v.sipStatus ?? null, v.durationMs, v.ok ? 1 : 0);
  }

  /** Aggregations for the Usage page. `days` = lookback window; undefined = all time. */
  summary(days?: number): LedgerSummary {
    const cutoff = days ? Date.now() - days * 86_400_000 : 0;
    // byDay is a chart: cap "all time" at the last 90 days so it stays renderable.
    const dayCutoff = Math.max(cutoff, Date.now() - 90 * 86_400_000);

    const totals = this.raw.prepare(
      `SELECT COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost,
              COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output,
              COALESCE(SUM(cache_read_tokens),0) cacheRead, COALESCE(SUM(cache_write_tokens),0) cacheWrite
       FROM llm_calls WHERE ts >= ?`,
    ).get(cutoff) as LedgerSummary["totals"];
    const byService = this.raw.prepare(
      `SELECT service, SUM(cost_usd) cost, COUNT(*) calls, SUM(${TOKENS}) tokens
       FROM llm_calls WHERE ts >= ? GROUP BY service ORDER BY cost DESC`,
    ).all(cutoff) as LedgerSummary["byService"];
    const byAction = this.raw.prepare(
      `SELECT service, action, COUNT(*) calls, SUM(cost_usd) cost, SUM(${TOKENS}) tokens,
              AVG(cost_usd) avgCost
       FROM llm_calls WHERE ts >= ? GROUP BY service, action ORDER BY cost DESC`,
    ).all(cutoff) as LedgerSummary["byAction"];
    const byDay = this.raw.prepare(
      // ts is milliseconds (JS Date.now); strftime wants seconds.
      `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') day, service,
              SUM(cost_usd) cost, COUNT(*) calls, SUM(${TOKENS}) tokens
       FROM llm_calls WHERE ts >= ? GROUP BY day, service ORDER BY day DESC`,
    ).all(dayCutoff) as LedgerSummary["byDay"];
    const byModel = this.raw.prepare(
      `SELECT model, SUM(cost_usd) cost, SUM(${TOKENS}) tokens, COUNT(*) calls
       FROM llm_calls WHERE ts >= ? GROUP BY model ORDER BY cost DESC`,
    ).all(cutoff) as LedgerSummary["byModel"];
    const byTier = this.raw.prepare(
      `SELECT tier, SUM(input_tokens) input, SUM(output_tokens) output,
              SUM(cache_read_tokens) cacheRead, SUM(cache_write_tokens) cacheWrite
       FROM llm_calls WHERE ts >= ? GROUP BY tier`,
    ).all(cutoff) as LedgerSummary["byTier"];
    const recent = this.raw.prepare(
      `SELECT ts, service, action, model, input_tokens input, output_tokens output,
              cache_read_tokens cacheRead, cache_write_tokens cacheWrite,
              cost_usd cost, duration_ms durationMs, ok
       FROM llm_calls WHERE ts >= ? ORDER BY ts DESC LIMIT 100`,
    ).all(cutoff) as LedgerSummary["recent"];
    const byTool = this.raw.prepare(
      `SELECT tool, COUNT(*) calls,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) errors,
              SUM(duration_ms) totalMs, AVG(duration_ms) avgMs, MAX(duration_ms) maxMs
       FROM tool_calls WHERE ts >= ? GROUP BY tool ORDER BY calls DESC`,
    ).all(cutoff) as LedgerSummary["byTool"];
    const toolTotals = this.raw.prepare(
      `SELECT COUNT(*) calls, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) errors, COALESCE(SUM(duration_ms),0) totalMs
       FROM tool_calls WHERE ts >= ?`,
    ).get(cutoff) as LedgerSummary["toolTotals"];

    const voiceTotals = this.raw.prepare(
      `SELECT COUNT(*) calls,
              COALESCE(SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END),0) completed,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) failed,
              COALESCE(SUM(duration_ms),0) totalMs,
              COALESCE(AVG(duration_ms),0) avgMs
       FROM voice_calls WHERE ts >= ?`,
    ).get(cutoff) as LedgerSummary["voiceTotals"];
    const byVoiceOutcome = this.raw.prepare(
      `SELECT outcome, COUNT(*) calls FROM voice_calls WHERE ts >= ? GROUP BY outcome ORDER BY calls DESC`,
    ).all(cutoff) as LedgerSummary["byVoiceOutcome"];
    const recentVoice = this.raw.prepare(
      `SELECT ts, session_id sessionId, transport, outcome, failure_code failureCode,
              sip_status sipStatus, duration_ms durationMs, ok
       FROM voice_calls WHERE ts >= ? ORDER BY ts DESC LIMIT 50`,
    ).all(cutoff) as LedgerSummary["recentVoice"];

    const providerAttempts = this.raw.prepare(`SELECT ts,request_id requestId,service,action,model,status,duration_ms durationMs,stream
      FROM provider_attempts WHERE ts>=? ORDER BY ts DESC LIMIT 100`).all(cutoff) as ProviderAttempt[];
    providerAttempts.forEach(attempt => { attempt.stream = Boolean(attempt.stream); });
    return { providerAttempts, totals, byService, byAction, byDay, byModel, byTier, recent, byTool, toolTotals, voiceTotals, byVoiceOutcome, recentVoice };
  }
}

let singleton: UsageLedger | undefined;
export function usageLedger(): UsageLedger {
  return (singleton ??= UsageLedger.open());
}
