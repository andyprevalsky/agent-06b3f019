---
name: talk-to-user
description: Use whenever the user should see something or decide something (updates, results, files, approvals). They never read your terminal.
---

# Talking to the user

The user never reads this terminal. Messages, results, scorecards, visuals and
approvals reach them only through the Rose tools: the `rose` CLI on PATH
(`rose --help`) or the same tools on the `rose` MCP server
(`send_message_to_user`, `display`, `request_user_approval`).

## When to use

- Progress the user would want, results and scorecards: `rose message`.
- To show anything visual (a page, a site folder, a 3D model, an image, a
  video), run `rose display <path>`.
- Before a risky or irreversible action (deleting data, spending money,
  pushing somewhere shared): `rose approve`.
<!-- rose-desktop -->
- A decision only the user can make, between a few clear options: a pinned
  question (`rose display --pinned`).
- Something you published with `rose-ui publish` that the user should see:
  `rose message --inline-view` (rose-ui skill). Naming it in your final
  response is not enough.
<!-- /rose-desktop -->

## When not to use

- Do not narrate every step; message on real progress, a result or a blocker.
- Do not ask approval for routine, reversible work you were asked to do.
- A message does not replace the output directory: requested files still go
  there, and your final response still names them.

## Commands

    rose message "<text>"
    rose display <path|url>... [--caption "<text>"]
    rose approve "<what you want to do and why>"
    rose wait <request-id>
<!-- rose-desktop -->
    rose display [<path|url>...] --pinned --caption "<question>" --option "Label | one-line description"... [--recommended N] [--no-other]
    rose message "<text>" --inline-view <view> [--props '<json>']
<!-- /rose-desktop -->

`rose display` takes local paths and public http(s) URLs, up to 20 per call.
<!-- rose-desktop -->

A pinned question appears above the user's query box when the root agent
started you, and the command returns their answer. Otherwise it goes to the
agent that started you, and its answer arrives as your next message.
`--recommended N` marks option N; `--no-other` removes the free-text answer.
<!-- /rose-desktop -->

## Waiting for an answer

Approvals and questions block until they are answered, with no deadline.
While waiting, the command prints `rose: waiting for ... (request <id>)` and
polls Rose; each poll is the heartbeat that shows you are still waiting.

- If your shell tool stops the command (a Bash timeout), run
  `rose wait <request-id>` with the printed id, and run it again each time it
  is stopped, until it prints the answer. Re-running the same `rose approve`
  command also resumes the same request; it never asks twice.
- Never treat a timeout as an answer, never assume one, and do not ask again
  in a new request.
- The MCP tools have no shell time limit: prefer `request_user_approval`
  when your harness offers the `rose` MCP server.
- Exit code 2 means the user rejected; read their reply in the output.
