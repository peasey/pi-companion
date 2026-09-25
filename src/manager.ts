import type { Config } from "./config.js";
import { RpcWorker, type GatewayEvent } from "./worker.js";
import {
  discoverSessions,
  findSessionById,
  summarize,
  transcript,
  type SessionSummary,
} from "./sessions.js";
import { PushService } from "./push.js";

export type RuntimeState =
  | "idle" | "streaming" | "starting"
  | "needs-input" | "finished" | "failed" | "stopped";

export interface PendingUi {
  requestId: string;
  method: string;
  title: string;
  message?: string;
  options?: string[];
}

export interface WithSession {
  sessionId: string;
  seq: string | null;
  event: GatewayEvent;
}

interface Tracked {
  worker: RpcWorker | null;
  state: RuntimeState;
  stateSince: number;
  pendingUi: Map<string, PendingUi>;
  lastMessagePreview: string | null;
  lastActivity: number;
  lastError: string | null;
}

/**
 * Tracks live pi workers and session states. Sessions are discovered from
 * disk; workers are spawned on demand and reaped after an idle timeout so
 * pi keeps running server-side regardless of the PWA's lifecycle.
 */
export class SessionManager {
  private tracked = new Map<string, Tracked>();
  private waiters = new Set<(e: WithSession) => void>();

  constructor(private cfg: Config, private push: PushService) {
    const reaper = setInterval(() => this.reapIdle(), 60_000);
    reaper.unref();
  }

  private trackingFor(id: string): Tracked {
    let t = this.tracked.get(id);
    if (!t) {
      t = {
        worker: null,
        state: "idle",
        stateSince: Date.now(),
        pendingUi: new Map(),
        lastMessagePreview: null,
        lastActivity: Date.now(),
        lastError: null,
      };
      this.tracked.set(id, t);
    }
    return t;
  }

  private setState(id: string, state: RuntimeState): void {
    const t = this.trackingFor(id);
    if (t.state !== state) {
      t.state = state;
      t.stateSince = Date.now();
    }
  }

  subscribe(id: string, fn: (e: WithSession) => void): () => void {
    const wrapped = (e: WithSession) => {
      if (e.sessionId === id) fn(e);
    };
    this.waiters.add(wrapped);
    return () => this.waiters.delete(wrapped);
  }

  publish(id: string, event: GatewayEvent): void {
    const seq = this.tracked.get(id)?.worker?.seq ?? null;
    const e: WithSession = { sessionId: id, seq, event };
    for (const w of this.waiters) w(e);
  }

  private async projectOf(id: string): Promise<string> {
    try {
      const sf = await findSessionById(this.cfg, id);
      return sf ? summarize(sf).project : "";
    } catch {
      return "";
    }
  }

  private async notify(
    id: string,
    kind: PushPayloadKind,
    suffix: string,
    body: string
  ): Promise<void> {
    const project = await this.projectOf(id);
    this.push.notify({
      sessionId: id,
      kind,
      title: project ? `${project} — ${suffix}` : suffix,
      body,
    });
  }

  async listSessions(): Promise<
    Array<{ summary: SessionSummary; state: RuntimeState; needsInput: boolean }>
  > {
    const discovered = await discoverSessions(this.cfg);
    return discovered.map(({ summary }) => {
      const t = this.tracked.get(summary.id);
      const needsInput = !!t && t.pendingUi.size > 0;
      const state: RuntimeState = needsInput ? "needs-input" : (t?.state ?? "idle");
      return { summary, state, needsInput };
    });
  }

  async getSession(id: string) {
    const sf = await findSessionById(this.cfg, id);
    if (!sf) return null;
    const t = this.tracked.get(sf.id);
    return {
      summary: summarize(sf),
      state: (t?.state ?? "idle") as RuntimeState,
      pendingUi: t ? Array.from(t.pendingUi.values()) : [] as PendingUi[],
      lastError: t?.lastError ?? null,
    };
  }

  async getTranscript(id: string) {
    const sf = await findSessionById(this.cfg, id);
    if (!sf) return null;
    return { summary: summarize(sf), messages: transcript(sf) };
  }

  /** Ensure a live worker exists for a session (spawn + attach). */
  async ensureWorker(id: string): Promise<RpcWorker> {
    const sf = await findSessionById(this.cfg, id);
    if (!sf) throw new Error("session not found");
    const t = this.trackingFor(sf.id);
    t.lastActivity = Date.now();
    if (t.worker?.running) return t.worker;
    const worker = new RpcWorker(this.cfg.piBin, sf.id, sf.file, sf.cwd || process.cwd());
    t.worker = worker;
    this.setState(sf.id, "starting");
    worker.on("gatewayEvent", (e: GatewayEvent) => this.onGatewayEvent(sf.id, e));
    worker.on("exit", () => {
      const t2 = this.tracked.get(sf.id);
      if (t2?.worker === worker) {
        t2.worker = null;
        if (t2.state === "streaming" || t2.state === "starting") {
          this.setState(sf.id, "stopped");
          this.publish(sf.id, { type: "status", state: "idle" });
        }
      }
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 300));
    if (!worker.running) throw new Error("failed to start pi worker");
    this.publish(sf.id, { type: "status", state: "starting" });
    return worker;
  }

  private onGatewayEvent(id: string, e: GatewayEvent): void {
    const t = this.trackingFor(id);
    switch (e.type) {
      case "status":
        if (e.state === "streaming") {
          this.setState(id, "streaming");
        } else if (e.state === "idle" && t.state === "streaming") {
          if (t.pendingUi.size > 0) {
            this.setState(id, "needs-input");
          } else {
            this.setState(id, "finished");
            t.lastActivity = Date.now();
            this.notify(id, "completed", "task complete", t.lastMessagePreview ?? "Agent finished.");
          }
        }
        break;
      case "message_end": {
        const m: any = e.message;
        const text =
          typeof m?.content === "string"
            ? m.content
            : (m?.content ?? [])
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join(" ");
        if (m?.role === "assistant" && text) t.lastMessagePreview = text.slice(0, 200);
        if (m?.role === "assistant" && (m.stopReason === "error" || m.errorMessage)) {
          t.lastError = m.errorMessage ?? "assistant error";
          this.setState(id, "failed");
          this.notify(id, "failed", "task failed", String(t.lastError).slice(0, 200));
        }
        break;
      }
      case "ui_request":
        t.pendingUi.set(e.requestId, e);
        this.setState(id, "needs-input");
        this.notify(id, "needs-input", "needs your input", e.title || "Agent is waiting for approval.");
        break;
      case "error":
        t.lastError = e.error;
        this.setState(id, "failed");
        this.notify(id, "failed", "error", String(e.error).slice(0, 200));
        break;
      default:
        break;
    }
    this.publish(id, e);
  }

  async sendMessage(id: string, text: string): Promise<void> {
    const worker = await this.ensureWorker(id);
    const streaming = this.trackingFor(id).state === "streaming";
    await worker.prompt(text, streaming);
  }

  async interrupt(id: string): Promise<void> {
    const worker = await this.ensureWorker(id);
    await worker.interrupt();
  }

  async respondToUi(
    id: string,
    requestId: string,
    body: { value?: string; confirmed?: boolean; cancelled?: boolean }
  ): Promise<void> {
    const t = this.trackingFor(id);
    if (!t.worker?.running) throw new Error("no live worker for session");
    await t.worker.respondToUi(requestId, body);
    t.pendingUi.delete(requestId);
    if (t.pendingUi.size === 0 && t.state === "needs-input") {
      this.setState(id, "streaming");
    }
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [id, t] of this.tracked) {
      if (!t.worker) {
        if (t.state !== "needs-input" && t.stateSince + this.cfg.idleWorkerTtlMs < now) {
          this.tracked.delete(id);
        }
        continue;
      }
      const lastAct = Math.max(t.worker.lastActivity, t.lastActivity);
      if (t.state !== "streaming" && t.pendingUi.size === 0 && lastAct + this.cfg.idleWorkerTtlMs < now) {
        t.worker.kill();
        this.tracked.delete(id);
      }
    }
  }
}

type PushPayloadKind = "needs-input" | "completed" | "failed";