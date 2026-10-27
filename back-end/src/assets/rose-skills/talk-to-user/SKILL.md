---
name: talk-to-user
description: Use whenever the user should see something (updates, results, files, visuals). They never read your terminal.
---

# Talking to the user

The user never reads this terminal. Messages, results, scorecards and visuals
reach them only through the Rose tools: the `rose` CLI on PATH (`rose --help`)
or the same tools on the `rose` MCP server (`send_message_to_user`, `display`).

You cannot ask the user questions. Decide with your best judgment, and state
the assumptions you made in your message or final response.

## When to use

- Progress the user would want, results and scorecards: `rose message`.
- To show anything visual (a page, a site folder, a 3D model, an image, a
  video, a .js module), run `rose display <path>`. A .js/.mjs file runs as a
  module on a full-window page where `import * as THREE from 'three'` works;
  a default-exported function is called with a full-window element.

<!-- rose-desktop -->

- When asked to make something visual or playable, publish it to the **Agent Display** panel with `rose display <path>` before finishing. The MCP tool is named `display`, not `agent_display`. Check the display result and return its receipt to the parent; a file path or final message alone is not delivery to the panel.
- For live HTML, keep the page running and update its data or control channel without repeatedly publishing frames. Preserve the opaque iframe sandbox and keep service credentials on the server. Do not claim a GPU stream is connected until it returns real frames.
- Something you published with `rose-ui publish` that the user should see:
  `rose message --inline-view` (rose-ui skill). Naming it in your final
  response is not enough.

<!-- /rose-desktop -->

## When not to use

- Do not narrate every step; message on real progress, a result or a blocker.
- A message does not replace the output directory: requested files still go
  there, and your final response still names them.

## Commands

    rose message "<text>"
    rose display <path|url>... [--caption "<text>"]

<!-- rose-desktop -->

    rose message "<text>" --inline-view <view> [--props '<json>']

<!-- /rose-desktop -->

`rose display` takes local paths and public http(s) URLs, up to 20 per call.
