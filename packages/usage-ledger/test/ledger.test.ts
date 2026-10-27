import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { UsageLedger, type LlmCallRecord } from "../src/index.ts";

function openTemp(): UsageLedger {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  return new UsageLedger(new Database(join(dir, "usage.db")));
}

function call(over: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return {
    ts: Date.now(), service: "mail-promoter", action: "triage", sessionId: null,
    tier: "tier-5", model: "deepseek-v4-flash",
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0,
    costUsd: 0.001, durationMs: 500, ok: true, status: 200,
    ...over,
  };
}

test("records llm calls and aggregates totals, byService, byAction with avgCost", () => {
  const ledger = openTemp();
  ledger.recordLlmCall(call());
  ledger.recordLlmCall(call({ action: "triage", costUsd: 0.003 }));
  ledger.recordLlmCall(call({ service: "host", action: "agent-turn", costUsd: 0.01 }));

  const s = ledger.summary();
  assert.equal(s.totals.calls, 3);
  assert.ok(Math.abs(s.totals.cost - 0.014) < 1e-9);
  assert.equal(s.totals.input, 300);
  assert.equal(s.totals.cacheRead, 120);

  assert.equal(s.byService[0].service, "host"); // sorted by cost desc
  assert.equal(s.byService[1].service, "mail-promoter");
  assert.ok(Math.abs(s.byService[1].cost - 0.004) < 1e-9);

  const triage = s.byAction.find((a) => a.service === "mail-promoter" && a.action === "triage");
  assert.ok(triage);
  assert.equal(triage.calls, 2);
  assert.ok(Math.abs(triage.avgCost - 0.002) < 1e-9);
});

test("summary(days) filters by period; byDay splits by service", () => {
  const ledger = openTemp();
  const old = Date.now() - 10 * 86_400_000;
  ledger.recordLlmCall(call({ ts: old, costUsd: 5 }));
  ledger.recordLlmCall(call({ costUsd: 0.5 }));
  ledger.recordLlmCall(call({ service: "host", action: "agent-turn", costUsd: 0.25 }));

  const week = ledger.summary(7);
  assert.equal(week.totals.calls, 2);
  assert.ok(Math.abs(week.totals.cost - 0.75) < 1e-9);
  // today has two rows, one per service (byDay buckets by local time, so compare in local time)
  const d = new Date();
  const todayLocal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = week.byDay.filter((r) => r.day === todayLocal);
  assert.equal(today.length, 2);

  const all = ledger.summary();
  assert.equal(all.totals.calls, 3);
});

test("failed calls and recent rows are exposed; tool calls aggregate as before", () => {
  const ledger = openTemp();
  ledger.recordLlmCall(call({ ok: false, status: 400, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }));
  ledger.recordTool({ ts: Date.now(), sessionId: "c1", tool: "read_message", durationMs: 120, ok: true });
  ledger.recordTool({ ts: Date.now(), sessionId: "c1", tool: "read_message", durationMs: 80, ok: false });

  const s = ledger.summary();
  assert.equal(s.recent.length, 1);
  assert.equal(s.recent[0].ok, 0);
  assert.equal(s.byTool[0].tool, "read_message");
  assert.equal(s.byTool[0].calls, 2);
  assert.equal(s.byTool[0].errors, 1);
  assert.equal(s.toolTotals.calls, 2);
});

test("voice calls aggregate outcomes and expose recent SIP diagnostics", () => {
  const ledger = openTemp();
  const now = Date.now();
  ledger.recordVoiceCall({ ts: now, sessionId: "v1", transport: "ringback", outcome: "completed", durationMs: 20_000, ok: true });
  ledger.recordVoiceCall({ ts: now, sessionId: "v2", transport: "ringback", outcome: "unreachable", failureCode: "unreachable", sipStatus: 480, durationMs: 4_000, ok: false });
  const s = ledger.summary();
  assert.equal(s.voiceTotals.calls, 2);
  assert.equal(s.voiceTotals.completed, 1);
  assert.equal(s.voiceTotals.failed, 1);
  assert.equal(s.voiceTotals.totalMs, 24_000);
  assert.equal(s.byVoiceOutcome.find((row) => row.outcome === "unreachable")?.calls, 1);
  assert.equal(s.recentVoice[0].sipStatus, 480);
  assert.equal(s.recentVoice[0].failureCode, "unreachable");
});

test('provider attempts are visible without double-counting terminal request costs',()=>{
  const ledger=new UsageLedger(new Database(':memory:'));
  ledger.recordProviderAttempt({ts:Date.now(),requestId:'request-1',service:'test',action:'fallback',model:'model',status:500,durationMs:10,stream:false});
  const summary=ledger.summary();
  assert.equal(summary.providerAttempts?.length,1);
  assert.equal(summary.providerAttempts?.[0].requestId,'request-1');
  assert.equal(summary.totals.calls,0);
  ledger.raw.close();
});
