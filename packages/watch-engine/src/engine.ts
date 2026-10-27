import { matchesRule, readPath } from "./match.ts";
import { WatchStore } from "./store.ts";
import type { WatchAdapter, WatchDefinition, WatchEngineObserver, WatchRecord } from "./types.ts";

export class WatchEngine {
  private readonly adapters = new Map<string, WatchAdapter>();
  constructor(readonly store: WatchStore, private readonly observer: WatchEngineObserver = {}) {}

  private notify<K extends keyof WatchEngineObserver>(name: K, ...args: Parameters<NonNullable<WatchEngineObserver[K]>>): void {
    try { (this.observer[name] as ((...values: typeof args) => void) | undefined)?.(...args); } catch { /* observers are best-effort */ }
  }

  register(adapter: WatchAdapter): this {
    this.adapters.set(adapter.source, adapter);
    return this;
  }

  sources(): string[] { return [...this.adapters.keys()]; }

  async create(definition: WatchDefinition): Promise<WatchRecord> {
    if (!definition.rules.length) throw new Error("At least one watch rule is required.");
    const ids = new Set<string>();
    for (const rule of definition.rules) {
      if (!rule.id || Number(!!rule.event) + Number(!!rule.trigger) !== 1) {
        throw new Error("Every watch rule requires id and exactly one of event or trigger.");
      }
      if (rule.trigger && (rule.trigger.kind !== "before_time" || !rule.trigger.field || !Number.isFinite(rule.trigger.minutes) || rule.trigger.minutes < 0)) {
        throw new Error(`Invalid temporal trigger on watch rule ${rule.id}.`);
      }
      if (rule.continuation) {
        const continuation = rule.continuation;
        if (!continuation.outcomes.length || !continuation.outcomes.every((outcome) => typeof outcome === "string" && outcome.trim())
          || !Number.isFinite(continuation.afterMinutes) || continuation.afterMinutes <= 0
          || !Number.isInteger(continuation.maxAttempts) || continuation.maxAttempts < 2 || continuation.maxAttempts > 60
          || !rule.grants?.length) {
          throw new Error(`Invalid continuation on watch rule ${rule.id}.`);
        }
        if (continuation.attempt !== undefined
          && (!Number.isInteger(continuation.attempt) || continuation.attempt < 1 || continuation.attempt > continuation.maxAttempts)) {
          throw new Error(`Invalid continuation attempt on watch rule ${rule.id}.`);
        }
      }
      if (ids.has(rule.id)) throw new Error(`Duplicate watch rule id: ${rule.id}`);
      ids.add(rule.id);
    }
    const adapter = this.adapters.get(definition.source);
    if (!adapter) throw new Error(`Unsupported watch source: ${definition.source}. Available: ${this.sources().join(", ")}`);
    const snapshot = await adapter.snapshot(definition.resourceRef);
    await adapter.validate?.(definition, snapshot);
    const watch = this.store.create(definition, snapshot, adapter.defaultExpiry(snapshot));
    this.notify("watchCreated", watch);
    return watch;
  }

  stop(id: string): WatchRecord {
    const before = this.store.get(id);
    const watch = this.store.stop(id);
    if (!watch) throw new Error(`Watch ${id} was not found.`);
    if (before?.status === "active" && watch.status === "stopped") this.notify("watchStopped", watch);
    return watch;
  }

  async poll(): Promise<number> {
    let queued = 0;
    for (const watch of this.store.expireDue()) this.notify("watchExpired", watch);
    for (const watch of this.store.active()) {
      const startedAt = Date.now();
      const adapter = this.adapters.get(watch.source);
      if (!adapter) {
        const message = `No adapter registered for ${watch.source}`;
        this.store.updateError(watch.id, message);
        this.notify("pollFailed", watch, message, Date.now() - startedAt);
        continue;
      }
      try {
        const current = await adapter.snapshot(watch.resourceRef);
        let watchQueued = 0;
        for (const event of adapter.events(watch.snapshot, current)) {
          const rules = watch.rules.filter((rule) => matchesRule(rule, event)
            && !(rule.once && this.store.hasRuleFired(watch.id, rule.id)));
          if (this.store.enqueue(watch, rules, event)) {
            queued++;
            watchQueued++;
            this.notify("eventQueued", watch, rules, event);
          }
        }
        for (const rule of watch.rules) {
          if (!rule.trigger || (rule.once && this.store.hasRuleFired(watch.id, rule.id))) continue;
          const event = temporalEvent(rule, current, Date.now());
          if (event && this.store.enqueue(watch, [rule], event)) {
            queued++;
            watchQueued++;
            this.notify("eventQueued", watch, [rule], event);
          }
        }
        const allOneShotRulesFired = watch.rules.length > 0 && watch.rules.every((rule) =>
          rule.once === true && this.store.hasRuleFired(watch.id, rule.id));
        const terminal = allOneShotRulesFired || adapter.isTerminal(current, watch);
        this.store.updateSnapshot(watch.id, current, terminal);
        const updated = this.store.get(watch.id) ?? { ...watch, snapshot: current };
        this.notify("pollCompleted", updated, { durationMs: Date.now() - startedAt, queued: watchQueued, terminal });
        if (terminal) this.notify("watchCompleted", updated);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.updateError(watch.id, message);
        this.notify("pollFailed", watch, message, Date.now() - startedAt);
      }
    }
    return queued;
  }

  /** Smallest adapter-requested interval. New domains opt in without changing
   * the scheduler or forcing their urgency model on other adapters. */
  nextPollDelayMs(defaultMs: number, now = Date.now()): number {
    const requested = this.store.active().flatMap((watch) => {
      const value = this.adapters.get(watch.source)?.pollIntervalMs?.(watch, now);
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? [value] : [];
    });
    return Math.max(5_000, Math.min(defaultMs, ...requested));
  }
}

function temporalEvent(rule: WatchRecord["rules"][number], current: unknown, now: number) {
  const trigger = rule.trigger;
  if (!trigger) return null;
  const value = readPath(current, trigger.field);
  const targetTimeMs = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(targetTimeMs)) return null;
  const dueAt = targetTimeMs - trigger.minutes * 60_000;
  if (now < dueAt || now >= targetTimeMs) return null;
  return {
    key: `before-time:${rule.id}:${Math.trunc(targetTimeMs / 60_000)}`,
    type: "watch.before_time",
    timestamp: now,
    data: { field: trigger.field, minutes: trigger.minutes, targetTimeMs, dueAt },
    currentState: current,
    fallbackText: `${trigger.minutes} minutes remain before ${trigger.field}.`,
  };
}

export * from "./types.ts";
export * from "./store.ts";
export * from "./match.ts";
