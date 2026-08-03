export type AgentStatus = "listening" | "working" | "offline";

export type SessionEventType = "snapshot" | "queue" | "artifact" | "presence" | "message";

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
}
