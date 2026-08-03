# Pair Plan

Pair Plan is a local-first review shell for agent-edited HTML artifacts. The application owns the stable navigation, annotation, queue, history, and transport UI. The agent owns only the reviewed artifact content.

## Run it

```sh
bun run dev -- pair-plan-review-artifact.html
```

Then open <http://127.0.0.1:8765>.

Useful options:

```sh
bun run dev -- \
  --artifact /absolute/path/to/plan.html \
  --root /absolute/path/to/project \
  --state-dir /absolute/path/to/local/state \
  --port 8765
```

The default state directory is an app-owned `~/.pair-plan/sessions` directory. The server binds to `127.0.0.1` and confines artifact assets to the configured root.

## Agent protocol

The session is path-keyed. Find the session and current revision:

```sh
curl http://127.0.0.1:8765/api/session
```

The agent long-polls for one complete feedback envelope:

```sh
curl 'http://127.0.0.1:8765/api/session/SESSION_ID/feedback/next?timeout=25000'
```

After processing the envelope, acknowledge it and return a compact revision result:

```sh
curl -X POST http://127.0.0.1:8765/api/session/SESSION_ID/feedback/ack \
  -H 'content-type: application/json' \
  -d '{"batchId":"BATCH_ID"}'

curl -X POST http://127.0.0.1:8765/api/session/SESSION_ID/reply \
  -H 'content-type: application/json' \
  -d '{"revision":9,"changedAnchors":["runtime"],"summary":"Clarified the server contract."}'
```

The browser receives artifact reload, presence, queue, and history events over SSE at `/api/session/SESSION_ID/events`.

`src/agent-client.ts` contains a small TypeScript client for wrapping this poll → process → acknowledge → reply loop.

## First pass boundaries

- Plain TypeScript and DOM modules are intentional; React is deferred.
- Agent handoff uses long polling. Browser reload and presence use SSE.
- Layout diagnostics, WebSockets, whiteboards, and artifact authoring are later slices.
