import webpush from "web-push";
import type { Config } from "./config.js";
import { findSessionById, summarize } from "./sessions.js";

export interface PushPayload {
  sessionId: string;
  kind: "needs-input" | "completed" | "failed";
  title: string;
  body: string;
}

interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Web Push (VAPID). If VAPID keys aren't configured, notifications are
 * silently dropped (the SSE feed still works while the app is open).
 */
export class PushService {
  private subs = new Map<string, Subscription>();
  constructor(private cfg: Config) {
    if (cfg.vapid) {
      webpush.setVapidDetails(cfg.vapid.subject, cfg.vapid.publicKey, cfg.vapid.privateKey);
    }
  }
  get enabled(): boolean {
    return !!this.cfg.vapid;
  }

  register(sub: Subscription): void {
    this.subs.set(sub.endpoint, sub);
  }

  list(): Subscription[] {
    return Array.from(this.subs.values());
  }

  async notify(payload: PushPayload): Promise<void> {
    if (!this.cfg.vapid || this.subs.size === 0) return;
    // Enrich the title with the session's project name.
    let project = "";
    try {
      const sf = await findSessionById(this.cfg, payload.sessionId);
      if (sf) project = summarize(sf).project;
    } catch {
      /* ignore */
    }
    const title = project ? `${project}: ${payload.title}` : payload.title;
    const body = JSON.stringify({
      sessionId: payload.sessionId,
      kind: payload.kind,
      title,
      body: payload.body,
    });
    await Promise.allSettled(
      this.list().map((s) =>
        webpush
          .sendNotification(s, body, { urgency: payload.kind === "needs-input" ? "high" : "normal" })
          .catch((err: any) => {
            if (err?.statusCode === 404 || err?.statusCode === 410) {
              this.subs.delete(s.endpoint);
            }
          })
      )
    );
  }
}