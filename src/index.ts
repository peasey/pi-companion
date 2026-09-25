import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { SessionManager, type RuntimeState } from "./manager.js";
import { PushService } from "./push.js";
import { findSessionById, summarize } from "./sessions.js";
import { readBody, json, sseHeaders, sseWrite, checkAuth, notFound, methodNotAllowed } from "./http-util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const push = new PushService(cfg);
const manager = new SessionManager(cfg, push);

const publicDir = path.resolve(__dirname, "../public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(urlPath: string, res: http.ServerResponse): boolean {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.join(publicDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(publicDir)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    "Cache-Control": file.endsWith(".html") ? "no-cache" : "public, max-age=86400",
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const p = url.pathname;

  // Everything except static assets requires app-level auth.
  const isStatic = !p.startsWith("/api/") && !p.startsWith("/sessions");
  if (!isStatic && !checkAuth(req, cfg.authToken)) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer" });
    json(res, { error: "unauthorized" });
    return;
  }

  try {
    if (p === "/api/health" && req.method === "GET") {
      json(res, { ok: true, push: push.enabled });
      return;
    }

    if (p === "/api/sessions" && req.method === "GET") {
      const rows = await manager.listSessions();
      json(res, { sessions: rows });
      return;
    }

    let m: RegExpMatchArray | null;

    if ((m = p.match(/^\/api\/sessions\/([^/]+)$/)) && req.method === "GET") {
      const meta = await manager.getSession(m[1]);
      if (!meta) return notFound(res);
      const sf = await findSessionById(cfg, m[1]);
      json(res, { ...meta, transcript: sf ? (await import("./sessions.js")).transcript(sf) : [] });
      return;
    }

    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/events$/)) && req.method === "GET") {
      const id = m[1];
      const sf = await findSessionById(cfg, id);
      if (!sf) return notFound(res);
      res.writeHead(200, sseHeaders());
      sseWrite(res, "retry", "2000");
      const meta = await manager.getSession(sf.id);
      sseWrite(res, "snapshot", JSON.stringify({ state: meta?.state, pendingUi: meta?.pendingUi, lastError: meta?.lastError }));
      const unsub = manager.subscribe(sf.id, (e) => {
        sseWrite(res, "event", JSON.stringify(e));
      });
      const ping = setInterval(() => sseWrite(res, "ping", String(Date.now())), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        unsub();
      });
      return;
    }

    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/messages$/)) && req.method === "POST") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, { error: "text required" }, 400);
      const sf = await findSessionById(cfg, m[1]);
      if (!sf) return notFound(res);
      if (!sf.cwd || !cfg.workspaceRoots.some((r) => sf.cwd.startsWith(r))) {
        return json(res, { error: "workspace root not approved" }, 403);
      }
      await manager.sendMessage(sf.id, text);
      json(res, { ok: true });
      return;
    }

    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/interrupt$/)) && req.method === "POST") {
      const sf = await findSessionById(cfg, m[1]);
      if (!sf) return notFound(res);
      await manager.interrupt(sf.id);
      json(res, { ok: true });
      return;
    }

    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/actions\/(respond)$/)) && req.method === "POST") {
      const body = await readBody(req);
      try {
        await manager.respondToUi(m[1], String(body.requestId ?? ""), body);
        json(res, { ok: true });
      } catch (e: any) {
        json(res, { error: String(e.message ?? e) }, 409);
      }
      return;
    }

    if (p === "/api/push-subscriptions" && req.method === "POST") {
      const body = await readBody(req);
      const sub = body.subscription;
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
        return json(res, { error: "invalid subscription" }, 400);
      }
      push.register(sub);
      json(res, { ok: true, push: push.enabled });
      return;
    }

    if (p === "/api/push-subscriptions" && req.method === "GET") {
      json(res, { enabled: push.enabled, publicKey: cfg.vapid?.publicKey ?? null });
      return;
    }

    if (serveStatic(p, res)) return;
    if (p.startsWith("/api/")) return notFound(res);
    // SPA-ish fallback for unknown non-API paths
    if (serveStatic("/", res)) return;
    notFound(res);
  } catch (e: any) {
    json(res, { error: String(e?.message ?? e) }, 500);
  }
});

server.listen(cfg.port, cfg.bindAddress, () => {
  const addr = server.address();
  const shown =
    cfg.bindAddress === "0.0.0.0"
      ? `<all interfaces> (Tailnet/LAN IPs — firewall-protect this host)`
      : cfg.bindAddress;
  console.log(`[gateway] listening on ${shown}:${(addr as any)?.port ?? cfg.port}`);
  console.log(`[gateway] local URL: http://localhost:${(addr as any)?.port ?? cfg.port}`);
  console.log(`[gateway] sessions dir: ${cfg.sessionsDir}`);
  console.log(`[gateway] workspace roots: ${cfg.workspaceRoots.join(", ")}`);
  console.log(`[gateway] web push: ${push.enabled ? "enabled" : "disabled (set VAPID_* to enable)"}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n[gateway] ${sig} received, shutting down`);
    process.exit(0);
  });
}