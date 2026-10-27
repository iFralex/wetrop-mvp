import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WatchEngine, WatchStore, type DomainEvent, type WatchAdapter, type WatchEngineObserver } from "../src/index.ts";

interface Snapshot { step: number; terminal?: boolean; etaMs?: number }

class FakeAdapter implements WatchAdapter {
  readonly source = "fake";
  current: Snapshot = { step: 0 };
  validate?: WatchAdapter["validate"];
  pollIntervalMs?: WatchAdapter["pollIntervalMs"];
  snapshot(): Promise<Snapshot> { return Promise.resolve(this.current); }
  defaultExpiry(): number { return Date.now() + 60_000; }
  isTerminal(value: unknown): boolean { return (value as Snapshot).terminal === true; }
  events(previousValue: unknown, currentValue: unknown): DomainEvent[] {
    const previous = previousValue as Snapshot;
    const current = currentValue as Snapshot;
    if (previous.step === current.step) return [];
    return [{
      key: `step:${current.step}`,
      type: "fake.changed",
      timestamp: Date.now(),
      data: { step: current.step, position: current.step - 2 },
      previousState: previous,
      currentState: current,
      fallbackText: `Step ${current.step}`,
    }];
  }
}

function fixture(observer?: WatchEngineObserver): { engine: WatchEngine; store: WatchStore; adapter: FakeAdapter; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "steward-watch-"));
  const store = WatchStore.open(join(dir, "watches.db"));
  const adapter = new FakeAdapter();
  return {
    store,
    adapter,
    engine: new WatchEngine(store, observer).register(adapter),
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("poll translates a state change into a durable matching event", async () => {
  const fx = fixture();
  try {
    const watch = await fx.engine.create({
      source: "fake", resourceRef: "resource-1", chatId: "chat-1", instruction: "Avvisami",
      rules: [{ id: "before", event: "fake.changed", where: { position: -1 }, once: true,
        grants: [{ tool: "mcp__voice__call_start" }] }],
    });
    fx.adapter.current = { step: 1 };

    assert.equal(await fx.engine.poll(), 1);
    const [pending] = fx.store.pending();
    assert.equal(pending.watchId, watch.id);
    assert.equal(pending.event.type, "fake.changed");
    assert.deepEqual(pending.rules[0].where, { position: -1 });
    assert.equal(pending.resourceRef, "resource-1");
    assert.deepEqual(pending.rules[0].grants, [{ tool: "mcp__voice__call_start" }]);
    fx.store.setNotificationText(pending.id, "Already composed");
    assert.equal(fx.store.pending()[0].notificationText, "Already composed", "composed text must survive a push retry");

    assert.equal(await fx.engine.poll(), 0, "the same state must not enqueue twice");
    fx.adapter.current = { step: 2 };
    assert.equal(await fx.engine.poll(), 0, "a once rule must not fire a second time");
  } finally { fx.cleanup(); }
});

test("one domain event aggregates every matching rule into one durable turn", async () => {
  const fx = fixture();
  try {
    await fx.engine.create({
      source: "fake", resourceRef: "aggregate", chatId: "chat", instruction: "x",
      rules: [
        { id: "all", event: "fake.changed" },
        { id: "first", event: "fake.changed", where: { position: -1 }, once: true, grants: [{ tool: "mcp__voice__call_start" }] },
      ],
    });
    fx.adapter.current = { step: 1 };
    assert.equal(await fx.engine.poll(), 1);
    assert.deepEqual(fx.store.pending()[0].rules.map((rule) => rule.id), ["all", "first"]);
  } finally { fx.cleanup(); }
});

test("before_time rules fire once inside their moving arrival window", async () => {
  const fx = fixture();
  try {
    const target = Date.now() + 10 * 60_000;
    await fx.engine.create({
      source: "fake", resourceRef: "timed", chatId: "chat", instruction: "x",
      rules: [{ id: "thirty", trigger: { kind: "before_time", field: "etaMs", minutes: 30 }, once: true }],
    });
    fx.adapter.current = { step: 0, etaMs: target };
    assert.equal(await fx.engine.poll(), 1);
    const [pending] = fx.store.pending();
    assert.equal(pending.event.type, "watch.before_time");
    assert.equal(pending.event.data.targetTimeMs, target);
    assert.equal(await fx.engine.poll(), 0);
  } finally { fx.cleanup(); }
});

test("watch action claims are durable and at-most-once", () => {
  const fx = fixture();
  try {
    assert.equal(fx.store.claimAction("event", "rule", "mcp__mail__send_email"), true);
    assert.equal(fx.store.claimAction("event", "rule", "mcp__mail__send_email"), false);
    fx.store.finishAction("event", "rule", "mcp__mail__send_email");
    assert.equal(fx.store.claimAction("event", "rule", "mcp__mail__send_email"), false);
  } finally { fx.cleanup(); }
});

test("lifecycle observer receives durable transitions and remains best-effort", async () => {
  const seen: string[] = [];
  const fx = fixture({
    watchCreated: () => seen.push("created"),
    eventQueued: () => seen.push("queued"),
    pollCompleted: (_watch, result) => seen.push(`polled:${result.queued}`),
    watchCompleted: () => seen.push("completed"),
  });
  try {
    await fx.engine.create({
      source: "fake", resourceRef: "observed", chatId: "chat", instruction: "x",
      rules: [{ id: "change", event: "fake.changed" }],
    });
    fx.adapter.current = { step: 1, terminal: true };
    await fx.engine.poll();
    assert.deepEqual(seen, ["created", "queued", "polled:1", "completed"]);
  } finally { fx.cleanup(); }

  const throwing = fixture({ pollCompleted: () => { throw new Error("observer failed"); } });
  try {
    await throwing.engine.create({
      source: "fake", resourceRef: "safe", chatId: "chat", instruction: "x",
      rules: [{ id: "change", event: "fake.changed" }],
    });
    await assert.doesNotReject(() => throwing.engine.poll());
  } finally { throwing.cleanup(); }
});

test("expired watches are surfaced without being polled", async () => {
  const expired: string[] = [];
  const fx = fixture({ watchExpired: (watch) => expired.push(watch.id) });
  try {
    const watch = await fx.engine.create({
      source: "fake", resourceRef: "expired", chatId: "chat", instruction: "x", expiresAt: Date.now() - 1,
      rules: [{ id: "change", event: "fake.changed" }],
    });
    assert.equal(await fx.engine.poll(), 0);
    assert.deepEqual(expired, [watch.id]);
    assert.equal(fx.store.get(watch.id)?.status, "expired");
  } finally { fx.cleanup(); }
});

test("stopped and terminal watches are no longer polled", async () => {
  const fx = fixture();
  try {
    const stopped = await fx.engine.create({
      source: "fake", resourceRef: "stopped", chatId: "chat", instruction: "x",
      rules: [{ id: "change", event: "fake.changed" }],
    });
    assert.equal(fx.engine.stop(stopped.id).status, "stopped");
    fx.adapter.current = { step: 1 };
    assert.equal(await fx.engine.poll(), 0);

    const terminal = await fx.engine.create({
      source: "fake", resourceRef: "terminal", chatId: "chat", instruction: "x",
      rules: [{ id: "change", event: "fake.changed" }],
    });
    fx.adapter.current = { step: 2, terminal: true };
    assert.equal(await fx.engine.poll(), 1);
    assert.equal(fx.store.get(terminal.id)?.status, "completed");
  } finally { fx.cleanup(); }
});

test("adapter validation and adaptive polling remain domain-owned", async () => {
  const fx = fixture();
  try {
    fx.adapter.validate = (definition) => {
      if (definition.resourceRef === "bad") throw new Error("incompatible resource");
    };
    fx.adapter.pollIntervalMs = () => 7_000;
    await assert.rejects(() => fx.engine.create({
      source: "fake", resourceRef: "bad", chatId: "chat", instruction: "x",
      rules: [{ id: "change", event: "fake.changed" }],
    }), /incompatible/);
    await fx.engine.create({
      source: "fake", resourceRef: "good", chatId: "chat", instruction: "x",
      rules: [{ id: "change", event: "fake.changed" }],
    });
    assert.equal(fx.engine.nextPollDelayMs(45_000), 7_000);
  } finally { fx.cleanup(); }
});
