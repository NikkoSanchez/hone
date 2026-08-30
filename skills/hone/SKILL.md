---
name: hone
description: Run Hone's local review loop for agent-edited HTML artifacts. Use when Codex needs to discover recently reviewed artifacts, open or resume an HTML artifact in Hone, receive anchored browser feedback, revise the artifact, report completed changes, or continue reviewing until the user ends the session.
---

# Hone

Use the `hone` CLI as the durable bridge between an HTML artifact, its browser review UI, and the active Codex turn.

## Check the CLI

Run `command -v hone` before starting. If it is unavailable, report that Hone must be linked or installed; do not substitute an unrelated preview server.

## Choose an artifact

- Use the path supplied by the user when present.
- When the user asks for a recent or latest artifact, run `hone recent --limit 10`. Read the artifact path after the `YYYY-MM-DD  ` prefix on each line; lines are newest-first and only include known files that still exist.
- If several results plausibly match, use the clearest task context. Ask the user only when choosing incorrectly would materially change the review target.
- Hone reviews an existing HTML artifact; it does not author the artifact. Create or update the HTML with the appropriate workflow before opening it.

Prefer stable `data-anchor` values on meaningful review regions. Preserve existing anchors while revising content because browser feedback targets them.

## Start or resume review

Run:

```sh
hone /absolute/path/to/artifact.html
```

This ensures the local session, opens its review URL, and prints JSON. Use `--no-open` only when the user does not want another browser window or the page is already open. If the returned status is `ended`, run `hone reopen <artifact>` only when the user asked to resume that review.

Follow the exact `next_command` returned by `open` and `complete`; it carries the resolved artifact, root, state directory, and port safely.

## Process feedback

1. Run the returned `hone poll ...` command and keep it attached to the active turn. Polling may wait until the reviewer submits feedback.
2. If the JSON status is `feedback`, inspect every prompt, including its anchor, quote, and body.
3. Edit the artifact in scope. Preserve unrelated user changes and verify the result in proportion to the edit.
4. Run the returned `hone complete ...` command, replacing the summary placeholder. Add one `--changed ANCHOR` for each stable anchor changed. Use the delivered revision unless the artifact's protocol requires a higher revision.
5. Run the new `next_command` and repeat until polling returns `status: "ended"`.

Keep each completion summary concise and factual. Do not acknowledge a batch without making or explicitly explaining the requested change. A delivery remains durable, so retry the same batch rather than inventing a new identifier after an interruption.

## Lifecycle commands

Use these only for the matching intent:

```sh
hone recent --limit 10
hone status [artifact]
hone end <artifact>
hone stop <artifact>
hone reopen <artifact>
```

- `end` closes the review session while preserving its artifact and history.
- `stop` stops its local daemon; it does not delete review history.
- `reopen` explicitly resumes a previously ended session.
