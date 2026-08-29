import type { AgentRuntimeSnapshot, FeedbackEnvelope } from "../../types";

export const TERMINAL_TRANSCRIPT_LIMIT = 256 * 1024;
export const TERMINAL_DEFAULT_COLS = 100;
export const TERMINAL_DEFAULT_ROWS = 28;
const TERMINAL_OUTPUT_FRAME = 1;
const TERMINAL_OUTPUT_HEADER_BYTES = 9;

export type AgentTerminalObservation = "ready" | "busy" | "approval" | "output";

export type TerminalServerMessage =
  | { type: "snapshot"; agent: AgentRuntimeSnapshot }
  | { type: "status"; agent: AgentRuntimeSnapshot }
  | { type: "error"; message: string };

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export function parseTerminalClientMessage(value: string): TerminalClientMessage | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.type === "input" && typeof parsed.data === "string" && parsed.data.length <= 64_000) {
      return { type: "input", data: parsed.data };
    }
    if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
      return {
        type: "resize",
        cols: Math.max(20, Math.min(500, Math.floor(parsed.cols))),
        rows: Math.max(5, Math.min(200, Math.floor(parsed.rows))),
      };
    }
  } catch {
    // Malformed terminal messages are ignored at the transport boundary.
  }
  return null;
}

export function formatFeedbackEnvelope(envelope: FeedbackEnvelope): string {
  const lines = [
    "[HONE FEEDBACK]",
    `batch: ${envelope.batchId}`,
    `artifact: ${envelope.file}`,
    `revision: ${envelope.revision}`,
    "",
    "Apply every item below to the current artifact.",
    "",
  ];
  envelope.prompts.forEach((prompt, index) => {
    lines.push(`${index + 1}. anchor: ${prompt.target.anchor}`);
    if (prompt.target.label) lines.push(`   label: ${prompt.target.label}`);
    if (prompt.target.quote) lines.push(`   quote: ${JSON.stringify(prompt.target.quote)}`);
    lines.push(`   request: ${prompt.body}`, "");
  });
  lines.push(
    "After editing, verify the artifact, briefly summarize what changed,",
    "then remain ready for the next Hone feedback batch.",
    "[/HONE FEEDBACK]",
  );
  return lines.join("\n");
}

export function appendBoundedTranscript(current: Uint8Array<ArrayBufferLike>, chunk: Uint8Array<ArrayBufferLike>, limit = TERMINAL_TRANSCRIPT_LIMIT): Uint8Array<ArrayBufferLike> {
  if (chunk.byteLength >= limit) return chunk.slice(chunk.byteLength - limit);
  const overflow = current.byteLength + chunk.byteLength - limit;
  const retained = overflow > 0 ? current.slice(overflow) : current;
  const next = new Uint8Array(retained.byteLength + chunk.byteLength);
  next.set(retained);
  next.set(chunk, retained.byteLength);
  return next;
}

export function encodeTerminalOutputFrame(sequence: number, data: Uint8Array<ArrayBufferLike>): Uint8Array {
  const frame = new Uint8Array(TERMINAL_OUTPUT_HEADER_BYTES + data.byteLength);
  frame[0] = TERMINAL_OUTPUT_FRAME;
  new DataView(frame.buffer).setBigUint64(1, BigInt(Math.max(0, Math.floor(sequence))));
  frame.set(data, TERMINAL_OUTPUT_HEADER_BYTES);
  return frame;
}

export function decodeTerminalOutputFrame(frame: Uint8Array): { sequence: number; data: Uint8Array } | null {
  if (frame.byteLength < TERMINAL_OUTPUT_HEADER_BYTES || frame[0] !== TERMINAL_OUTPUT_FRAME) return null;
  return {
    sequence: Number(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(1)),
    data: frame.slice(TERMINAL_OUTPUT_HEADER_BYTES),
  };
}
