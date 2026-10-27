export type ActionSourceKind = "company" | "mail" | "calendar";
export type ActionKind =
  | "reply-needed"
  | "scheduling-request"
  | "calendar-invite"
  | "event-reminder"
  | "deadline"
  | "document-action"
  | "follow-up"
  | "admin-task";
export type ActionStatus = "new" | "read" | "done" | "dismissed";
export type ActionPriority = "low" | "normal" | "high";
export type ActionTextLanguage = "default" | "en" | "it";

export interface ProposedToolStep {
  id: string;
  label: string;
  kind?: "tool";
  tool: string;
  input: Record<string, unknown>;
  writes: boolean;
}

export interface ProposedManualStep {
  id: string;
  label: string;
  kind: "manual";
  links?: { url: string; label?: string }[];
}

export type ProposedStep = ProposedToolStep | ProposedManualStep;

export interface ProposedAction {
  id: string;
  label: string;
  summary: string;
  confidence: "low" | "medium" | "high";
  steps: ProposedStep[];
}

export interface ContextSnapshot {
  mail?: Record<string, unknown>;
  calendar?: Record<string, unknown>;
  contacts?: Record<string, unknown>;
  wiki?: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
  flows?: FlowMatch[];
  reasoning?: string;
}

export interface Flow {
  id: number;
  name: string;
  when: string;
  guidance: string;
  exclusions: string;
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface FlowMatch extends Flow {
  score: number;
}

export interface UpsertFlow {
  name: string;
  when: string;
  guidance: string;
  exclusions?: string;
  enabled?: boolean;
}

export interface ActionItem {
  id: number;
  sourceKey: string;
  sourceKind: ActionSourceKind;
  kind: ActionKind;
  status: ActionStatus;
  priority: ActionPriority;
  title: string;
  summary: string;
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
  payload: Record<string, unknown>;
}

export interface UpsertAction {
  sourceKey: string;
  sourceKind: ActionSourceKind;
  kind: ActionKind;
  priority?: ActionPriority;
  title: string;
  summary: string;
  dueAt?: number | null;
  payload?: Record<string, unknown>;
}

export interface RelatedActionCandidate {
  id: number;
  title: string;
  summary: string;
  updatedAt: number;
}
