# Pi Companion

A private, mobile-first PWA for supervising and steering [Pi Coding Agent](https://github.com/earendil-works/pi-mono) sessions from an iPhone. Install it to the Home Screen, check in on your coding agents, approve or interrupt work, and send follow-ups — while pi keeps running on your server.

```
iOS Home-Screen PWA
  ↕ HTTPS + SSE over Tailscale
Pi gateway (this project, Node/TypeScript)
  ↕ LF-delimited JSONL
pi --mode rpc workers  →  ~/.pi/agent/sessions/*.jsonl
```

## What it does

- **Session inbox** — sessions grouped into *Needs your input*, *Running*, and *Recent*, with project, task title, state, latest update, and elapsed time.
- **Session chat** — full conversation history, live streaming output, collapsed tool-activity cards, composer for follow-ups, and a stop/interrupt control.
- **Approvals** — when an extension requests input (`select`/`confirm`/`input`/`editor` over the RPC UI protocol), a sticky approval bar appears with explicit actions, and the session moves to *Needs your input*.
- **Notifications** — Web Push (VAPID) only for: needs-your-input, task completed, task failed. Tapping opens that session.
- **Server-side workers** — the gateway spawns persistent `pi --mode rpc --session <file>` workers on demand and reaps them after an idle timeout. Pi keeps running when the PWA is closed or backgrounded.

## Non-goals

No terminal emulation, no filesystem browsing, no project/plugin administration, no multi-user tenancy. PI WEB remains the desktop admin surface.

## Quick start

```bash
npm install
TOKEN=$(openssl rand -hex 32)
AUTH_TOKEN=$TOKEN npm start
# → [gateway] local URL: http://localhost:8787
```

Open the URL on your iPhone (via Tailscale), enter the token, then use **Share → Add to Home Screen**. The app must be served over HTTPS for iOS to treat it as installable + push-capable — put it behind a reverse proxy (Caddy/nginx) with a TLS cert on the Tailnet IP, or use Tailscale Serve:

```bash
tailscale serve --bg https+insecure://127.0.0.1:8787   # https://<host>.tailnet.ts.net
```

### Configuration (env vars)

| Variable | Default | Notes |
|---|---|---|
| `AUTH_TOKEN` | *(required)* | App-level bearer token. **Required** — Tailscale access alone is not authorisation. |
| `BIND_ADDRESS` | `0.0.0.0` | Override, e.g. `127.0.0.1` or your Tailscale IP. The effective listen URL is printed at startup. |
| `PORT` | `8787` | |
| `SESSIONS_DIR` | `~/.pi/agent/sessions` | |
| `PI_BIN` | `pi` | Path to the pi binary. |
| `WORKSPACE_ROOTS` | `~` | Colon-separated roots; prompts are only accepted for sessions whose cwd is under an approved root. |
| `IDLE_WORKER_TTL_MS` | `600000` | Idle workers are killed after this. |
| `VAPID_SUBJECT` / `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | unset | Enable Web Push. Generate with `npm run gen:vapid`. |

The default bind `0.0.0.0` listens on **every** interface (Tailnet *and* LAN). The gateway always requires the bearer token, but you should also protect the host with firewall rules, or bind explicitly to the Tailscale interface.

## API surface

```
GET  /api/sessions                       — session list + state summaries
GET  /api/sessions/{id}                  — metadata + transcript
GET  /api/sessions/{id}/events           — SSE live event stream (token via ?token=)
POST /api/sessions/{id}/messages         — send a follow-up { text }
POST /api/sessions/{id}/interrupt        — stop current work
POST /api/sessions/{id}/actions/respond  — answer approval/confirmation { requestId, value|confirmed|cancelled }
GET/POST /api/push-subscriptions         — push capability / register subscription
```

All API routes require `Authorization: Bearer <AUTH_TOKEN>` (SSE also accepts `?token=`). Static assets are served from `public/` without auth. The client never sees server filesystem paths (only project basenames), credentials, env vars, or model tokens.

## iOS keyboard behaviour

The app shell is a fixed-height layout driven by `window.visualViewport` (never `100vh`):

- `--app-height` is set from `visualViewport.height` on `resize`/`scroll`, so the transcript scrolls above and the composer sits below, always above the keyboard.
- On focus, the active input is scrolled fully into view; the Send button is never covered.
- The composer font is ≥16px to prevent iOS zoom-on-focus; drafts persist in `sessionStorage` so nothing is lost.

⚠️ Test in the **installed Home-Screen PWA on a real iPhone** — not just desktop emulation. Keyboard overlap, jumpy layout, or lost drafts are release blockers.

## Notifications setup

```bash
npm run gen:vapid    # prints VAPID_* values
```

Set the three `VAPID_*` vars, restart, then tap the 🔔 button in the inbox to grant permission and register. The service worker (`public/sw.js`) only shows notifications for `needs-input`, `completed`, and `failed` events, and deep-links to the session on tap.

## Development

```bash
npm run dev          # tsx watch
npm run typecheck
npm run gen:icons    # regenerate PWA icons (no image deps)
```

### Project layout

```
src/config.ts      env parsing, bind address, workspace roots
src/sessions.ts    session discovery + JSONL parsing (split on \n only), tree-aware transcript
src/worker.ts      one pi --mode rpc child process; LF-JSONL framing, request correlation
src/manager.ts     live state, SSE fan-out, notifications, worker lifecycle
src/push.ts        Web Push (VAPID), 404/410 subscription pruning
src/index.ts       HTTP server: static PWA + REST + SSE
public/            PWA: index.html, style.css, app.js (no build step), sw.js, manifest
```