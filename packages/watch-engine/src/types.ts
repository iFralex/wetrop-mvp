export type WatchFieldConstraint =
  | { kind: "exact"; value: unknown }
  | { kind: "template"; template: string }
  | { kind: "relative_time"; reference: string; offsetMinutes: number }
  | { kind: "one_of"; values: unknown[] }
  | { kind: "range"; min?: number; max?: number };

export interface WatchToolConstraints {
  fields: Record<string, WatchFieldConstraint>;
  /** Reject arguments not explicitly constrained. Safe capabilities normally require this. */
  denyExtraFields?: boolean;
}

/** Source-neutral future capability. The host capability registry decides
 * which tool names and argument fields may actually be pre-authorized. */
export interface WatchToolGrant {
  tool: string;
  maxInvocations?: number;
  constraints?: WatchToolConstraints;
}

export interface WatchTemporalTrigger {
  kind: "before_time";
  /** Dot path in the current resource snapshot, for example estimatedArrivalMs. */
  field: string;
  minutes: number;
}

/** A bounded follow-up scheduled from the outcome of an authorized action.
 * `attempt` is engine-owned durable state and is never accepted from users. */
export interface WatchContinuation {
  outcomes: string[];
  afterMinutes: number;
  maxAttempts: number;
  attempt?: number;
}

export interface WatchRule {
  id: string;
  event?: string;
  trigger?: WatchTemporalTrigger;
  where?: Record<string, unknown>;
  once?: boolean;
  /** Capabilities explicitly approved for turns caused by this rule only. */
  grants?: WatchToolGrant[];
  /** Re-run the exact same authorized action after selected outcomes. */
  continuation?: WatchContinuation;
  /** Voice-only rules never send a fallback push unless explicitly requested. */
  voiceFallback?: "push";
}

export interface WatchDefinition {
  source: string;
  resourceRef: string;
  rules: WatchRule[];
  instruction: string;
  chatId: string;
  /** @deprecated Compatibility with watches created before rule-scoped grants. */
  authorizedTools?: string[];
  expiresAt?: number;
}

export interface WatchRecord extends WatchDefinition {
  id: string;
  status: "active" | "stopped" | "completed" | "expired";
  snapshot: unknown;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt?: number;
  lastError?: string;
}

export interface DomainEvent {
  /** Stable within a resource; used to avoid duplicate delivery after restarts. */
  key: string;
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
  previousState?: unknown;
  currentState: unknown;
  fallbackText: string;
  /** Optional presentation hints owned by the source adapter. The generic
   * engine stores and forwards them without interpreting the domain. */
  notification?: {
    title?: Record<string, string>;
    guidance?: string | Record<string, string>;
  };
}

export interface PendingWatchEvent {
  id: string;
  watchId: string;
  chatId: string;
  instruction: string;
  resourceRef: string;
  rules: WatchRule[];
  event: DomainEvent;
  attempts: number;
  notificationText?: string;
}

export interface WatchAdapter {
  source: string;
  snapshot(resourceRef: string): Promise<unknown>;
  events(previous: unknown, current: unknown): DomainEvent[];
  defaultExpiry(snapshot: unknown): number;
  isTerminal(snapshot: unknown, watch?: WatchRecord): boolean;
  /** Reject definitions that are structurally valid but incompatible with the
   * selected resource. Domain intent remains in the adapter, never the engine. */
  validate?(definition: WatchDefinition, snapshot: unknown): void | Promise<void>;
  /** Domain hint used by the host's generic adaptive polling loop. */
  pollIntervalMs?(watch: WatchRecord, now: number): number;
}

/** Optional lifecycle hooks. The engine stays storage/domain-only; hosts can
 * attach audit, metrics or tracing without coupling those concerns here. */
export interface WatchEngineObserver {
  watchCreated?(watch: WatchRecord): void;
  watchStopped?(watch: WatchRecord): void;
  watchExpired?(watch: WatchRecord): void;
  eventQueued?(watch: WatchRecord, rules: WatchRule[], event: DomainEvent): void;
  pollCompleted?(watch: WatchRecord, result: { durationMs: number; queued: number; terminal: boolean }): void;
  pollFailed?(watch: WatchRecord, error: string, durationMs: number): void;
  watchCompleted?(watch: WatchRecord): void;
}
