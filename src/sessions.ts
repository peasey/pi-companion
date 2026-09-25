import { readdir, stat, readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";

export interface SessionMessage {
  role: string;
  text?: string;
  thinking?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  outputPreview?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
}

export interface SessionEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  message?: SessionMessage;
  customType?: string;
}

export interface SessionFile {
  id: string;
  file: string;
  dirKey: string;
  cwd: string;
  project: string;
  name: string | null;
  mtimeMs: number;
  startedAt: string | null;
  entries: SessionEntry[];
}

/** Basename of a cwd — this is all the client ever sees of a path. */
export function projectLabel(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

function toSessionMessage(m: any): SessionMessage | undefined {
  if (!m || typeof m !== "object") return undefined;
  const base: SessionMessage = { role: m.role, timestamp: m.timestamp };
  if (m.role === "user") {
    base.text = textOf(m.content);
  } else if (m.role === "assistant") {
    base.text = textOf(m.content);
    base.thinking = Array.isArray(m.content)
      ? m.content
          .filter((b: any) => b?.type === "thinking")
          .map((b: any) => b.thinking)
          .join("\n")
      : undefined;
    base.toolCalls = Array.isArray(m.content)
      ? m.content
          .filter((b: any) => b?.type === "toolCall")
          .map((b: any) => ({ id: b.id, name: b.name, args: b.arguments }))
      : undefined;
    base.model = m.model;
    base.stopReason = m.stopReason;
    base.errorMessage = m.errorMessage;
  } else if (m.role === "toolResult") {
    base.toolName = m.toolName;
    base.toolCallId = m.toolCallId;
    base.isError = m.isError;
    const t = textOf(m.content);
    base.outputPreview = t.length > 2000 ? t.slice(0, 2000) : t;
  } else if (m.role === "bashExecution") {
    base.text = m.command;
    base.outputPreview =
      typeof m.output === "string" && m.output.length > 2000
        ? m.output.slice(0, 2000)
        : m.output;
    base.isError = (m.exitCode ?? 0) !== 0;
  } else if (m.role === "custom" || m.role === "branchSummary" || m.role === "compactionSummary") {
    base.text = textOf(m.content) ?? m.summary;
  }
  return base;
}

/** Walk the active branch of the entry tree (leaf → root → reversed). */
function activeBranch(entries: SessionEntry[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  const childrenOf = new Map<string, string[]>();
  for (const e of entries) {
    byId.set(e.id, e);
    if (e.parentId) {
      const arr = childrenOf.get(e.parentId) ?? [];
      arr.push(e.id);
      childrenOf.set(e.parentId, arr);
    }
  }
  // Leaf: an entry with no children.
  let leaf: SessionEntry | null = null;
  for (const e of entries) {
    if (!childrenOf.has(e.id)) leaf = e;
  }
  const chain: SessionEntry[] = [];
  let cur: SessionEntry | null = leaf;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? (byId.get(cur.parentId) ?? null) : null;
  }
  return chain.reverse();
}

/** Parse a session JSONL file (split on \n only, per pi spec). */
export async function parseSessionFile(
  file: string,
  sessionsDir: string
): Promise<SessionFile | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  let header: any = null;
  const entries: SessionEntry[] = [];
  for (const line of raw.split("\n")) {
    const l = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!l.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(l);
    } catch {
      continue;
    }
    if (obj.type === "session" && !header) {
      header = obj;
    } else if (obj.id) {
      entries.push({
        id: obj.id,
        parentId: obj.parentId ?? null,
        type: obj.type,
        timestamp: obj.timestamp,
        message: obj.type === "message" ? toSessionMessage(obj.message) : undefined,
        customType: obj.customType,
      });
    }
  }
  if (!header) return null;
  const st = await stat(file);
  const dirKey = path.basename(path.dirname(file));
  const name = ((entries.find((e: any) => e.type === "session_name") as any)?.name as
    | string
    | undefined) ?? null;
  return {
    id: header.id ?? path.basename(file, ".jsonl"),
    file,
    dirKey,
    cwd: header.cwd ?? "",
    project: projectLabel(header.cwd ?? ""),
    name: (typeof name === "string" ? name : null) ?? null,
    mtimeMs: st.mtimeMs,
    startedAt: header.timestamp ?? null,
    entries,
  };
}

export interface SessionSummary {
  id: string;
  project: string;
  name: string;
  title: string;
  lastUpdate: number;
  startedAt: string | null;
  lastActivity: string | null;
  messageCount: number;
}

export function summarize(sf: SessionFile): SessionSummary {
  const branch = activeBranch(sf.entries);
  const msgs = branch.filter((e) => e.type === "message" && e.message);
  const firstUser = msgs.find((m) => m.message!.role === "user");
  const title =
    sf.name ||
    (firstUser?.message?.text ? firstUser.message.text.slice(0, 80) : "Untitled session");
  const last = msgs[msgs.length - 1];
  return {
    id: sf.id,
    project: sf.project,
    name: sf.name ?? "",
    title,
    lastUpdate: sf.mtimeMs,
    startedAt: sf.startedAt,
    lastActivity: last?.timestamp ?? sf.startedAt,
    messageCount: msgs.length,
  };
}

export function transcript(sf: SessionFile): SessionMessage[] {
  return activeBranch(sf.entries)
    .filter((e) => e.type === "message" && e.message)
    .map((e) => e.message!);
}

export interface Discovered {
  sf: SessionFile;
  summary: SessionSummary;
}

/** Scan sessions dir: ~/.pi/agent/sessions/--path--/*.jsonl */
export async function discoverSessions(
  cfg: Config,
  limit = 100
): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let dirKeys: string[] = [];
  try {
    dirKeys = await readdir(cfg.sessionsDir);
  } catch {
    return out;
  }
  for (const dirKey of dirKeys) {
    const dir = path.join(cfg.sessionsDir, dirKey);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const sf = await parseSessionFile(path.join(dir, f), cfg.sessionsDir);
      if (!sf) continue;
      out.push({ sf, summary: summarize(sf) });
    }
  }
  out.sort((a, b) => b.sf.mtimeMs - a.sf.mtimeMs);
  return out.slice(0, limit);
}

export async function findSessionById(
  cfg: Config,
  id: string
): Promise<SessionFile | null> {
  const all = await discoverSessions(cfg, 500);
  const hit = all.find((d) => d.sf.id === id || d.sf.id.startsWith(id));
  return hit?.sf ?? null;
}