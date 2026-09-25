import { spawn, ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type GatewayEvent =
  | { type: "status"; state: "idle" | "streaming" | "starting" }
  | { type: "delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; preview: string }
  | { type: "tool_end"; toolCallId: string; isError: boolean; preview: string }
  | { type: "message_end"; message: unknown }
  | { type: "user_message"; text: string }
  | { type: "ui_request"; requestId: string; method: string; title: string; message?: string; options?: string[] }
  | { type: "error"; error: string }
  | { type: "notice"; level: "info" | "warning" | "error"; message: string }
  | { type: "exit"; code: number | null };

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One persistent `pi --mode rpc` worker bound to a session file.
 * Speaks LF-delimited JSONL on stdin/stdout (split on \n only — never readline).
 */
export class RpcWorker extends EventEmitter {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly seq: string; // gateway-local instance id (resets across reconnects)
  private proc: ChildProcess | null = null;
  private pending = new Map<string, Pending>();
  private reqCounter = 0;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  state: "starting" | "idle" | "streaming" = "starting";
  lastActivity = Date.now();
  lastError: string | null = null;

  constructor(
    private piBin: string,
    sessionId: string,
    sessionFile: string,
    cwd: string
  ) {
    super();
    this.seq = randomUUID();
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
    this.cwd = cwd;
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  start(): void {
    if (this.running) return;
    const proc = spawn(
      this.piBin,
      ["--mode", "rpc", "--session", this.sessionFile],
      { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] }
    );
    this.proc = proc;

    proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        let line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.trim()) this.handleLine(line);
      }
    });
    proc.stdout!.on("end", () => {
      const rest = this.decoder.end();
      if (rest.trim()) this.handleLine(rest.replace(/\r$/, ""));
    });
    proc.stderr!.on("data", (c: Buffer) => {
      const s = c.toString().trim();
      if (s) this.emit("gatewayEvent", { type: "notice", level: "info", message: s.slice(0, 500) } satisfies GatewayEvent);
    });
    proc.on("exit", (code) => {
      this.proc = null;
      this.state = "starting";
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("pi worker exited"));
      }
      this.pending.clear();
      this.emit("gatewayEvent", { type: "exit", code } as GatewayEvent);
      this.emit("exit");
    });
  }

  private handleLine(line: string): void {
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      return;
    }
    this.lastActivity = Date.now();

    if (evt.type === "response") {
      const p = evt.id ? this.pending.get(evt.id) : undefined;
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(evt.id!);
        if (evt.success) p.resolve(evt.data);
        else p.reject(new Error(evt.error ?? "command failed"));
      }
      return;
    }

    const ge = this.normalize(evt);
    if (ge) this.emit("gatewayEvent", ge);
  }

  private normalize(evt: any): GatewayEvent | null {
    switch (evt.type) {
      case "agent_start":
        this.state = "streaming";
        return { type: "status", state: "streaming" };
      case "agent_settled":
      case "agent_end": {
        if (evt.type === "agent_settled") {
          this.state = "idle";
          return { type: "status", state: "idle" };
        }
        return null;
      }
      case "message_update": {
        const d = evt.assistantMessageEvent;
        if (!d) return null;
        if (d.type === "text_delta") return { type: "delta", text: d.delta };
        if (d.type === "thinking_delta") return { type: "thinking_delta", text: d.delta };
        return null;
      }
      case "message_end":
        return { type: "message_end", message: evt.message };
      case "tool_execution_start":
        return {
          type: "tool_start",
          toolCallId: evt.toolCallId,
          toolName: evt.toolName,
          args: evt.args,
        };
      case "tool_execution_update": {
        const t = (evt.partialResult?.content ?? [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        return { type: "tool_update", toolCallId: evt.toolCallId, preview: t };
      }
      case "tool_execution_end": {
        const t = (evt.result?.content ?? [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        return {
          type: "tool_end",
          toolCallId: evt.toolCallId,
          isError: !!evt.isError,
          preview: t.slice(0, 2000),
        };
      }
      case "extension_ui_request": {
        // Dialog methods block the agent — surface as "needs your input".
        if (!["select", "confirm", "input", "editor"].includes(evt.method)) {
          if (evt.method === "notify") {
            return {
              type: "notice",
              level: evt.notifyType ?? "info",
              message: evt.message ?? "",
            } as GatewayEvent;
          }
          return null;
        }
        return {
          type: "ui_request",
          requestId: evt.id,
          method: evt.method,
          title: evt.title ?? "",
          message: evt.message,
          options: evt.options,
        };
      }
      case "auto_retry_end":
        if (evt.success === false) {
          return { type: "error", error: (this.lastError = evt.finalError ?? "retry failed") };
        }
        return null;
      case "extension_error":
        return { type: "error", error: evt.error ?? "extension error" };
      default:
        return null;
    }
  }

  sendCommand(cmd: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
    if (!this.running) throw new Error("worker not running");
    const id = `gw-${++this.reqCounter}`;
    const line = JSON.stringify({ id, ...cmd }) + "\n";
    this.proc!.stdin!.write(line);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("pi command timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async prompt(text: string, streaming: boolean): Promise<void> {
    if (streaming) {
      await this.sendCommand({ type: "prompt", message: text, streamingBehavior: "steer" });
    } else {
      await this.sendCommand({ type: "prompt", message: text });
    }
    this.emit("gatewayEvent", { type: "user_message", text } as GatewayEvent);
  }

  async interrupt(): Promise<void> {
    await this.sendCommand({ type: "abort" });
  }

  async respondToUi(requestId: string, body: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<void> {
    const cmd: Record<string, unknown> = { type: "extension_ui_response", id: requestId };
    if (body.cancelled) cmd.cancelled = true;
    else if (body.confirmed !== undefined) cmd.confirmed = body.confirmed;
    else cmd.value = body.value ?? "";
    this.proc!.stdin!.write(JSON.stringify(cmd) + "\n");
  }

  kill(): void {
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.stdin!.write(JSON.stringify({ type: "abort" }) + "\n");
        this.proc.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}