import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { AgentRuntimeSnapshot } from "../../types";
import { decodeTerminalOutputFrame } from "../protocol";

interface AgentTerminalClientOptions {
  container: HTMLElement;
  url: string;
  onAgentChange(agent: AgentRuntimeSnapshot): void;
  onConnectionChange?(connected: boolean): void;
}

export class AgentTerminalClient {
  private readonly terminal = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    fontSize: 11,
    lineHeight: 1.25,
    scrollback: 3_000,
    theme: {
      background: "#0e1b25",
      foreground: "#d8e7e5",
      cursor: "#1eb9b0",
      selectionBackground: "#2b525b",
      black: "#0e1b25",
      brightBlack: "#6d7d82",
      red: "#f1755e",
      green: "#1eb9b0",
      yellow: "#f4c95d",
      blue: "#69a9ca",
      magenta: "#c594c5",
      cyan: "#72cbc4",
      white: "#d8e7e5",
    },
  });
  private readonly fitAddon = new FitAddon();
  private readonly options: AgentTerminalClientOptions;
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private disposed = false;
  private lastSequence = 0;
  private resizeObserver?: ResizeObserver;

  constructor(options: AgentTerminalClientOptions) {
    this.options = options;
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(options.container);
    this.terminal.onData((data) => this.send({ type: "input", data }));
    this.terminal.onResize(({ cols, rows }) => this.send({ type: "resize", cols, rows }));
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(options.container);
    this.fit();
    this.connect();
  }

  fit(): void {
    try { this.fitAddon.fit(); } catch { /* Hidden panels have no measurable geometry yet. */ }
  }

  focus(): void {
    this.terminal.focus();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.resizeObserver?.disconnect();
    this.socket?.close();
    this.terminal.dispose();
  }

  private connect(): void {
    if (this.disposed) return;
    const url = new URL(this.options.url, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      this.options.onConnectionChange?.(true);
      this.fit();
      this.send({ type: "resize", cols: this.terminal.cols, rows: this.terminal.rows });
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data) as { type: string; agent?: AgentRuntimeSnapshot };
          if (message.type === "snapshot") {
            this.lastSequence = 0;
            this.terminal.reset();
          }
          if (message.agent) this.options.onAgentChange(message.agent);
        } catch {
          // Ignore malformed control frames while keeping the PTY stream alive.
        }
        return;
      }
      const bytes = event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : event.data as Blob;
      if (bytes instanceof Blob) void bytes.arrayBuffer().then((value) => this.writeFrame(new Uint8Array(value)));
      else this.writeFrame(bytes);
    };
    socket.onclose = () => {
      this.options.onConnectionChange?.(false);
      if (!this.disposed) this.reconnectTimer = window.setTimeout(() => this.connect(), 1_000);
    };
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private writeFrame(bytes: Uint8Array): void {
    const frame = decodeTerminalOutputFrame(bytes);
    if (!frame || frame.sequence < this.lastSequence) return;
    this.lastSequence = frame.sequence;
    this.terminal.write(frame.data);
  }
}
