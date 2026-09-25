import { homedir } from "node:os";
import path from "node:path";

export interface Config {
  bindAddress: string;
  port: number;
  authToken: string;
  sessionsDir: string;
  piBin: string;
  workspaceRoots: string[];
  idleWorkerTtlMs: number;
  vapid: { subject: string; publicKey: string; privateKey: string } | null;
}

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function expand(p: string): string {
  if (p.startsWith("~")) return path.join(homedir(), p.slice(1));
  return path.resolve(p);
}

export function loadConfig(): Config {
  const authToken = env("AUTH_TOKEN") ?? env("PI_COMPANION_TOKEN");
  if (!authToken) {
    console.error(
      "[config] AUTH_TOKEN is required. Generate one with: openssl rand -hex 32"
    );
    process.exit(1);
  }

  const sessionsDir = expand(
    env("SESSIONS_DIR", "~/.pi/agent/sessions")!
  );

  // Default workspace roots: nothing destructive — new sessions may only be
  // created inside these dirs. Defaults to the home dir; tighten in prod.
  const roots = (env("WORKSPACE_ROOTS", "~") ?? "~")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(expand);

  const vapid = {
    subject: env("VAPID_SUBJECT")!,
    publicKey: env("VAPID_PUBLIC_KEY")!,
    privateKey: env("VAPID_PRIVATE_KEY")!,
  };
  const hasVapid = !!(vapid.subject && vapid.publicKey && vapid.privateKey);

  return {
    bindAddress: env("BIND_ADDRESS", "0.0.0.0")!,
    port: Number(env("PORT", "8787")),
    authToken: authToken!,
    sessionsDir,
    piBin: env("PI_BIN", "pi")!,
    workspaceRoots: roots,
    idleWorkerTtlMs: Number(env("IDLE_WORKER_TTL_MS", String(10 * 60_000))),
    vapid: hasVapid ? vapid : null,
  };
}