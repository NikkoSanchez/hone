import type { AgentTerminalObservation } from "../protocol";

export interface ArtifactContext {
  filePath: string;
  rootPath: string;
}

export interface TerminalAgentAdapter {
  id: string;
  label: string;
  executable: string;
  command(context: ArtifactContext): string[];
  environment?(context: ArtifactContext): Record<string, string>;
  submit(terminal: Bun.Terminal, message: string): Promise<void>;
  observe(chunk: Uint8Array): AgentTerminalObservation;
  canAcceptInput(status: string): boolean;
}

const decoder = new TextDecoder();

function terminalText(chunk: Uint8Array): string {
  return decoder.decode(chunk, { stream: true }).replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
}

function promptObservation(chunk: Uint8Array): AgentTerminalObservation {
  const text = terminalText(chunk);
  if (/approve|permission|allow|continue\?|\[y\/n\]|yes\/no/i.test(text)) return "approval";
  if (/(^|\n)\s*(›|>|❯)\s*$/.test(text) || /what (would you like|can i help)/i.test(text)) return "ready";
  return text.trim() ? "output" : "busy";
}

async function submitLine(terminal: Bun.Terminal, message: string): Promise<void> {
  const frame = new TextEncoder().encode(`${message}\n`);
  let offset = 0;
  const deadline = Date.now() + 2_000;
  while (offset < frame.byteLength) {
    if (terminal.closed) throw new Error("The agent terminal closed while feedback was being submitted.");
    const written = terminal.write(frame.slice(offset));
    if (written > 0) {
      offset += written;
      continue;
    }
    if (Date.now() >= deadline) throw new Error("The agent terminal remained backpressured while feedback was being submitted.");
    await Bun.sleep(10);
  }
}

const adapters: TerminalAgentAdapter[] = [
  {
    id: "codex",
    label: "Codex CLI",
    executable: "codex",
    command: () => ["codex"],
    submit: submitLine,
    observe: promptObservation,
    canAcceptInput: (status) => status === "ready" || status === "working",
  },
  {
    id: "claude",
    label: "Claude Code",
    executable: "claude",
    command: () => ["claude"],
    submit: submitLine,
    observe: promptObservation,
    canAcceptInput: (status) => status === "ready" || status === "working",
  },
  {
    id: "opencode",
    label: "OpenCode",
    executable: "opencode",
    command: () => ["opencode"],
    submit: submitLine,
    observe: promptObservation,
    canAcceptInput: (status) => status === "ready" || status === "working",
  },
];

export function getTerminalAgentAdapter(id: string): TerminalAgentAdapter | undefined {
  return adapters.find((adapter) => adapter.id === id);
}

export function availableTerminalAgentAdapters(): TerminalAgentAdapter[] {
  return adapters.filter((adapter) => Boolean(Bun.which(adapter.executable)));
}

export function selectTerminalAgentAdapter(id?: string): TerminalAgentAdapter | undefined {
  if (id) return getTerminalAgentAdapter(id);
  const available = availableTerminalAgentAdapters();
  return available.length === 1 ? available[0] : undefined;
}

export function terminalAgentAdapterIds(): string[] {
  return adapters.map((adapter) => adapter.id);
}
