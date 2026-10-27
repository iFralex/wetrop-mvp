/**
 * Event protocol between the agent host core and any channel client
 * (the web UI first; Telegram / Discord later — all clients of the same
 * contract). Architecture "B": the core owns the loop, gating and
 * sessions; channels only speak these events.
 *
 * Keep this package dependency-free: it is the shared contract imported
 * by both the host (Node) and the web client (browser).
 */

/**
 * A file produced/referenced by a tool, served by the host over HTTP at
 * `/file/<token>`. The channel renders it as an openable, draggable chip.
 */
export interface ChannelFile {
  name: string;
  /** Opaque handle; fetch the bytes at `<httpBase>/file/<token>`. */
  token: string;
  mime: string;
  size: number;
  /** Absolute local path (the UI is local/trusted) — lets inline file cards match by path. */
  path?: string;
}

/**
 * A persisted transcript message (chat history). Mirrors the renderable shape
 * of a chat message so the channel can restore a conversation verbatim.
 */
export interface PersistedMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  /** Effective input sent to the tool after approval edits and preflight normalization. */
  toolInput?: unknown;
  /** Original model-requested input, retained for auditability. */
  toolRequestedInput?: unknown;
  toolCallId?: string;
  toolStatus?: "running" | "ok" | "error";
  toolOutput?: unknown;
  toolDurationMs?: number;
  toolError?: string;
  toolFiles?: ChannelFile[];
  /** For role "user": files the user attached (available to the agent by path). */
  attachments?: ChannelFile[];
  /** When the message was created (epoch ms). */
  createdAt?: number;
}

/** Summary of a persisted chat, for the chat list. */
export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** A scratch chat opened for an action; removed on reconnect unless saved. */
  temporary?: boolean;
}

/** Messages a channel sends INTO the core. */
export type ClientEvent =
  | { type: "user_message"; sessionId: string; text: string; chatId?: string; attachments?: ChannelFile[] }
  | { type: "stop"; chatId?: string }
  | { type: "chat_list" }
  | { type: "chat_create"; title?: string; temporary?: boolean }
  | { type: "chat_select"; chatId: string }
  | { type: "chat_rename"; chatId: string; title: string }
  | { type: "chat_delete"; chatId: string }
  | { type: "chat_save"; chatId: string }
  | { type: "open_file"; token: string }
  | { type: "reveal_file"; token: string }
  | { type: "action_center_refresh"; sessionId: string; includeDone?: boolean; hideExpired?: boolean; limit?: number }
  | { type: "action_center_mark"; sessionId: string; id: number; status: ActionStatus }
  | { type: "action_open_in_chat"; id: number }
  | { type: "action_center_execute"; sessionId: string; id: number; proposalId: string }
  | { type: "action_center_revise"; sessionId: string; id: number; proposalId: string; instruction: string }
  | {
      /** Renew the inactivity timeout while the user edits a pending action. */
      type: "approval_activity";
      sessionId: string;
      requestId: string;
    }
  | {
      type: "approval_decision";
      sessionId: string;
      requestId: string;
      decision: ApprovalDecision;
      /** Optional note shown to the agent when denying (why / what to do instead). */
      note?: string;
      /**
       * Optional corrected tool arguments (approve-with-edit): when the user
       * approves but tweaks the payload, the tool runs with this instead of the
       * originally-requested input. Ignored on deny.
       */
      editedInput?: Record<string, unknown>;
    }
  | {
      /**
       * The user's answer to a `question_request`: the labels they selected.
       * Single-select → exactly one; multi-select → zero or more. An empty
       * array (or no reply → timeout) means "no choice".
       */
      type: "question_response";
      sessionId: string;
      requestId: string;
      selected: string[];
    };

/** Messages the core sends OUT to a channel. */
export type ServerEvent =
  | { type: "assistant_token"; sessionId: string; chatId?: string; text: string }
  | { type: "assistant_done"; sessionId: string; chatId?: string }
  | {
      /**
       * The agent invoked a tool (shown in the transcript so nothing is lost).
       * `toolCallId` correlates with the matching `tool_result`.
       */
      type: "tool_call";
      sessionId: string;
      chatId?: string;
      toolCallId: string;
      tool: string;
      input: unknown;
    }
  | {
      /**
       * The core is asking the user to approve a sensitive tool call.
       * The channel renders `input` (typed payload, e.g. an email draft)
       * and replies with an `approval_decision` carrying this `requestId`.
       */
      type: "approval_request";
      sessionId: string;
      chatId?: string;
      requestId: string;
      tool: string;
      input: unknown;
      /** Optional read-only context used only to render a richer approval card. */
      preview?: unknown;
    }
  | {
      /**
       * The agent is asking the user to pick among predefined options (the
       * `ask_user` tool). The channel renders `options` as a single- or
       * multi-select and replies with a `question_response` carrying this
       * `requestId`. This is a plain question, not a tool approval.
       */
      type: "question_request";
      sessionId: string;
      chatId?: string;
      requestId: string;
      question: string;
      options: string[];
      multiSelect: boolean;
    }
  | {
      /** Cumulative session token usage + cost, emitted after each turn. */
      type: "usage";
      sessionId: string;
      chatId?: string;
      /** Cost (USD) of the turn that just finished. */
      turnCostUsd: number;
      /** Cumulative session cost (USD). */
      costUsd: number;
      tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    }
  | {
      /**
       * A tool finished. `toolCallId` matches the `tool_call`. `output` is the
       * tool's result (parsed JSON when the tool returned JSON, else a string),
       * `durationMs` is wall-clock time, `error` is set when `ok` is false.
       */
      type: "tool_result";
      sessionId: string;
      chatId?: string;
      toolCallId: string;
      tool: string;
      ok: boolean;
      output: unknown;
      durationMs: number;
      requestedInput?: unknown;
      effectiveInput?: unknown;
      error?: string;
      /** On-disk files the tool produced/referenced (e.g. a saved attachment). */
      files?: ChannelFile[];
    }
  | { type: "action_center_state"; sessionId: string; state: ActionCenterState }
  | { type: "chat_list"; chats: ChatSummary[]; activeChatId: string | null }
  | { type: "chat_history"; chatId: string; messages: PersistedMessage[] }
  | { type: "status"; sessionId: string; chatId?: string; state: SessionState }
  | { type: "error"; sessionId?: string; chatId?: string; message: string };

export type ApprovalDecision = "allow" | "deny" | "revise";
export type SessionState = "idle" | "running";
export type ActionStatus = "new" | "read" | "done" | "dismissed";

export interface ActionCenterItem {
  id: number;
  sourceKey: string;
  sourceKind: "mail" | "calendar";
  kind: string;
  status: ActionStatus;
  priority: "low" | "normal" | "high";
  title: string;
  summary: string;
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
  payload: Record<string, unknown>;
}

export interface ActionCenterDiagnostics {
  /** Backward-compatible alias for countsTotal. */
  counts: Record<ActionStatus, number>;
  countsTotal: Record<ActionStatus, number>;
  countsVisible: Record<ActionStatus, number>;
  byKind: Record<string, number>;
  staleNew: number;
  nextDueAt: number | null;
  lastUpdatedAt: number | null;
  deferredReasons?: Record<string, number>;
}

export interface ActionCenterState {
  items: ActionCenterItem[];
  diagnostics: ActionCenterDiagnostics;
}

// ── LLM usage metering (gateway ledger attribution) ─────────────────────────
// Callers of the LLM gateway attribute themselves with these headers; the
// gateway records them in the shared usage ledger. Missing headers are
// recorded as USAGE_UNKNOWN so unlabeled spend stays visible.
export const USAGE_SERVICE_HEADER = "x-usage-service";
export const USAGE_ACTION_HEADER = "x-usage-action";
export const USAGE_SESSION_HEADER = "x-usage-session";
export const USAGE_UNKNOWN = "unknown";

export function usageHeaders(service: string, action: string, sessionId?: string): Record<string, string> {
  return {
    [USAGE_SERVICE_HEADER]: service,
    [USAGE_ACTION_HEADER]: action,
    ...(sessionId ? { [USAGE_SESSION_HEADER]: sessionId } : {}),
  };
}

/** Supply a shared configured gateway key only to its exact loopback endpoint. */
export function gatewayCredential(endpoint: string, explicit?: string, shared?: string, port = 4000): string | undefined {
  if (explicit !== undefined) return explicit;
  if (!shared) return undefined;
  try {
    const url = new URL(endpoint);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === port
      && url.pathname.startsWith('/v1/') ? shared : undefined;
  } catch { return undefined; }
}
