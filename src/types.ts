export type AgentStatus = "listening" | "working" | "offline";

export type AgentLifecycleStatus = "disabled" | "starting" | "ready" | "working" | "stopping" | "offline" | "error";

export type FeedbackDeliveryStatus = "queued" | "submitted" | "working";

export interface AgentConfiguration {
  enabled: boolean;
  adapterId?: string;
}

export interface AgentExit {
  code: number;
  signal?: string;
  at: string;
}

export interface PersistedAgentState {
  configuration: AgentConfiguration;
  transcriptTail: string;
  lastExit?: AgentExit;
}

export interface AgentRuntimeSnapshot {
  adapterId?: string;
  adapterLabel?: string;
  command?: string[];
  cwd: string;
  status: AgentLifecycleStatus;
  pid?: number;
  sequence: number;
  transcriptTail: string;
  lastError?: string;
  lastExit?: AgentExit;
  canAcceptInput: boolean;
  requiresInput: boolean;
}

export type SessionEndBy = "agent" | "user";

export type SessionEventType = "snapshot" | "queue" | "artifact" | "presence" | "message" | "review";

export type ReviewSeverity = "info" | "warning" | "error";

export interface CodeReviewFinding {
  id: string;
  file: string;
  line?: number;
  side?: "deletions" | "additions";
  severity: ReviewSeverity;
  title: string;
  body: string;
}

export interface CodeReview {
  patch: string;
  findings: CodeReviewFinding[];
  summary?: string;
  source?: string;
  createdAt: string;
}

export interface CodeReviewInput {
  patch: string;
  findings?: Array<Partial<CodeReviewFinding> & Pick<CodeReviewFinding, "file" | "title" | "body">>;
  summary?: string;
  source?: string;
}

export interface TargetRef {
  anchor: string;
  label?: string;
  quote?: string;
  contextHash?: string;
  startOffset?: number;
  endOffset?: number;
}

export interface FeedbackInput {
  target: TargetRef;
  body: string;
  queueKey?: string;
  tag?: string;
}

export interface FeedbackItem extends FeedbackInput {
  id: string;
  createdAt: string;
}

export interface FeedbackEnvelope {
  sessionId: string;
  file: string;
  revision: number;
  batchId: string;
  prompts: FeedbackItem[];
}

export interface FeedbackEnded {
  sessionId: string;
  file: string;
  revision: number;
  status: "ended";
  endedAt: string;
  endedBy: SessionEndBy;
}

export type FeedbackPollResult = FeedbackEnvelope | FeedbackEnded;

export function isFeedbackEnded(value: FeedbackPollResult | null): value is FeedbackEnded {
  return Boolean(value && "status" in value && value.status === "ended");
}

export function isFeedbackEnvelope(value: FeedbackPollResult | null): value is FeedbackEnvelope {
  return Boolean(value && "batchId" in value);
}

export interface AgentReply {
  revision?: number;
  changedAnchors?: string[];
  summary: string;
  body?: string;
}

export interface HistoryMessage {
  id: string;
  role: "user" | "agent" | "system";
  body: string;
  createdAt: string;
}

export interface SessionSnapshot {
  id: string;
  filePath: string;
  artifactRevision: number;
  queue: FeedbackItem[];
  history: HistoryMessage[];
  agentStatus: AgentStatus;
  updatedAt: string;
  deliveryBatchId: string | null;
  deliveryStatus: FeedbackDeliveryStatus | null;
  agent?: AgentRuntimeSnapshot;
  review?: CodeReview;
  endedAt?: string;
  endedBy?: SessionEndBy;
}

export interface SessionEvent {
  type: SessionEventType;
  snapshot: SessionSnapshot;
  message?: HistoryMessage;
}

export interface DeliveryState {
  batchId: string;
  envelope: FeedbackEnvelope;
  deliveredAt: string;
  status?: FeedbackDeliveryStatus;
  submittedAt?: string;
  lastActivityAt?: string;
}

export interface StoredSessionState {
  id: string;
  filePath: string;
  rootPath: string;
  artifactRevision: number;
  artifactHash: string;
  queue: FeedbackItem[];
  delivery?: DeliveryState;
  history: HistoryMessage[];
  agentStatus: AgentStatus;
  updatedAt: string;
  endedAt?: string;
  endedBy?: SessionEndBy;
  review?: CodeReview;
  agent?: PersistedAgentState;
}
