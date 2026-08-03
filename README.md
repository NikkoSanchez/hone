# Pair Plan

Pair Plan is a local-first review shell for agent-edited HTML artifacts. The application owns the stable navigation, annotation, queue, history, and transport UI. The agent owns only the reviewed artifact content.

## Run it

```sh
bun run dev -- pair-plan-review-artifact.html
```

Then open <http://127.0.0.1:8765>.

## CLI agent loop

The Bun CLI is the agent-facing adapter. It keeps the server/session details path-based so an agent does not need to discover IDs or construct HTTP requests by hand:

```sh
# Start or resume the local review session without opening another browser.
bun run cli -- pair-plan-review-artifact.html --no-open

# Keep this command attached to the active agent turn.
bun run cli -- poll pair-plan-review-artifact.html

# After editing the artifact, complete the exact batch atomically.
bun run cli -- complete pair-plan-review-artifact.html \
  --batch-id BATCH_ID \
  --summary "Clarified the server lifecycle." \
  --revision 2 \
  --changed runtime
```

For a linked local executable, run `bun link` from this package and use `pair-plan ...` instead. `poll` waits until a reviewer sends feedback; if the agent task ends, queued feedback remains durable but the CLI does not create a new Codex task by itself.

Useful lifecycle commands:

```sh
bun run cli -- status
bun run cli -- end pair-plan-review-artifact.html
bun run cli -- stop pair-plan-review-artifact.html
```

The CLI uses a single healthy daemon per artifact/state directory, cleans up on `stop` or process signals, and recovers stale runtime records. Idle shutdown defaults to 30 minutes and can be disabled with `--idle-timeout-ms 0`.

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

`src/agent-client.ts` contains the TypeScript client behind the CLI poll → process → complete loop. The server also keeps the older individual acknowledgement and reply endpoints for protocol compatibility.

## First pass boundaries

- Plain TypeScript and DOM modules are intentional; React is deferred.
- Agent handoff uses the CLI over long polling. Browser reload and presence use SSE.
- Layout diagnostics, WebSockets, whiteboards, and artifact authoring are later slices.
