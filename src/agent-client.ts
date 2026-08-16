import { isFeedbackEnded, type AgentReply, type CodeReviewInput, type FeedbackEnvelope, type FeedbackPollResult, type SessionEndBy } from "./types";

export interface AgentLoopOptions {
  signal?: AbortSignal;
  pollTimeoutMs?: number;
}

export type FeedbackHandler = (envelope: FeedbackEnvelope) => Promise<AgentReply>;

export class HoneAgentClient {
  readonly baseUrl: string;
  readonly sessionId: string;

  constructor(baseUrl: string, sessionId: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.sessionId = sessionId;
  }

  async nextFeedback(options: AgentLoopOptions = {}): Promise<FeedbackPollResult | null> {
    const timeoutMs = options.pollTimeoutMs ?? 25_000;
    const response = await fetch(`${this.baseUrl}/api/session/${this.sessionId}/feedback/next?timeout=${timeoutMs}`, {
      signal: options.signal,
    });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`Feedback poll failed: ${response.status} ${await response.text()}`);
    return await response.json() as FeedbackPollResult;
  }

  async acknowledge(batchId: string): Promise<void> {
    await this.post("feedback/ack", { batchId });
  }

  async reply(reply: AgentReply): Promise<void> {
    await this.post("reply", reply);
  }

  async complete(batchId: string, reply: AgentReply): Promise<void> {
    await this.post("complete", { batchId, ...reply });
  }

  async review(review: CodeReviewInput): Promise<void> {
    await this.post("review", review);
  }

  async status(status: "listening" | "working" | "offline"): Promise<void> {
    await this.post("status", { status });
  }

  async end(by: SessionEndBy = "agent"): Promise<void> {
    await this.post("end", { by });
  }

  async run(handler: FeedbackHandler, options: AgentLoopOptions = {}): Promise<void> {
    while (!options.signal?.aborted) {
      const envelope = await this.nextFeedback(options);
      if (!envelope) continue;

      if (isFeedbackEnded(envelope)) return;
      const reply = await handler(envelope);
      await this.complete(envelope.batchId, reply);
    }
  }

  private async post(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/session/${this.sessionId}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Hone request failed: ${response.status} ${await response.text()}`);
  }
}
