# The Rose app UI bundle

The bundle is the Rose app UI for ONE user (the user you are working for).
`rose-ui pull` writes their published version into a folder; `rose-ui publish`
turns the folder into a new immutable version and, unless you pass
`--no-activate`, the user sees it immediately. Publish when the user should
see the change, the same way you would merge. Rollback = publish/activate an
earlier version.

## Layout

    <folder>/
      rose-ui.json     manifest (required) — see "Manifest" below
      root/
        theme.json     CSS tokens + background (data only, no code)
        shell/         optional full-viewport shell ("OS mode")
        slots/<slot>/  widgets mounted into named host slots
        assets/        images, gifs, video, fonts
      inline/<view>/   views rendered inline in the chat trajectory
      apps/<app>/      standalone apps opened from the Apps section
      tools/<tool>/    tools for this user's agent (tool.json + handler)
      screenshots/     local captures (never published)
        current/       the user's PUBLISHED UI (`rose-ui screenshot --current`)

Files and folders whose name starts with "." and any node_modules/ are never
published, and neither is screenshots/. Limits: 10 MB per file, 50 MB total,
2000 files.

## Manifest (rose-ui.json)

    {
      "version": 1,
      "theme": "root/theme.json",
      "shell": { "entry": "root/shell/index.html" },
      "slots": {
        "background":     { "entry": "root/slots/background/index.html" },
        "sidebar.header": { "entry": "..." },
        "menu":           { "entry": "..." },
        "home.dashboard": { "entry": "..." },
        "agent.panel":    { "entry": "..." }
      },
      "inline": {
        "<view-name>": { "entry": "inline/<view-name>/index.html",
                         "summary": "one line describing the view",
                         "poster": "inline/<view-name>/poster.png" }
      },
      "tools": { "<tool_name>": { "manifest": "tools/<tool_name>/tool.json" } },
      "apps": {
        "<app-name>": { "title": "Tip calculator",
                        "entry": "apps/<app-name>/index.html",
                        "icon": "apps/<app-name>/icon.svg" }
      },
      "capabilities": ["read", "subscribe", "navigate", "create_agent", "send_message"]
    }

Every key except "version" is optional. Paths are relative to the folder (no
"/" prefix, no ".."). Every referenced path must exist or publishing fails.
View and app names match [a-z0-9-]+; tool names match [a-z0-9_]+. An app's
entry and icon live inside apps/<app-name>/, and "rose" is reserved.

theme.json:

    {
      "tokens": { "--primary": "262 83% 58%", "--radius": "14px" },
      "background": { "image": "root/assets/wallpaper.jpg", "fadeAfterFirstMessage": 0.8 }
    }

Token names are CSS custom properties; values are plain CSS values (no url(),
no ";", "{", "}" or markup). Colour tokens the app reads as hsl(var(--name))
(--background, --foreground, --primary, --secondary, --accent, --muted, --card,
--border, --input, --ring, their -foreground pairs and the --sidebar-* tokens)
must be HSL triplets like "262 83% 58%", not hex; `rose-ui check` flags them.
fadeAfterFirstMessage is the chat pane opacity (0..1, default 0.8) once the
first message is sent.

## How your code runs

Every entry is an HTML page loaded in a sandboxed cross-origin iframe
(sandbox="allow-scripts", strict CSP). It cannot read the Rose session or call
the Rose API directly; it talks to the host with postMessage:

From your view to the host (window.parent.postMessage(msg, "*")):
  { type: "rose:ready" }                  you are initialised
  { type: "rose:resize", height: <px> }   your content height (inline views and
                                          the sidebar.header/menu/home.dashboard
                                          slots; clamped to 60..900)

From the host to your view (window.addEventListener("message", ...)):
  { type: "rose:props", props: {...} }    inline view props from the message

Those three messages are the whole bridge today. Slots receive props: null.

Inline views: an agent shows one in the chat with
send_message_to_user(message, inline_view={ view: "<view-name>", props: {...} })
(`rose message "<text>" --inline-view <view-name> --props '<json>'`).
The message pins the published version, so later publishes never change old
messages. Keep props small JSON. Put an example of the props next to the view
as props.example.json; `rose-ui dev`/`screenshot` feed it to the view.

The frame's origin is opaque ("null"), which means:
- no localStorage, sessionStorage, IndexedDB or cookies; keep state in memory;
- fetch() of your own files is a CORS request (allowed: usercontent sends
  Access-Control-Allow-Origin: *);
- `new Worker("file.js")` is refused; fetch the script and start it from a
  blob: URL (the CSP allows worker-src blob:), see examples/particles-worker;
- WebAssembly is allowed ('wasm-unsafe-eval'; .wasm is served as
  application/wasm), see examples/wasm-viz.

## Something for the user to see or play

Build a game, app, chart or other visual the user asked to see as an inline
view: write inline/<view-name>/index.html (scripts and data in the bundle; the
CSP blocks external scripts and fetches), add it under "inline" in rose-ui.json
with a one-line summary, run `rose-ui publish`, then show it with
`rose message "<text>" --inline-view <view-name>` and name the view in your
final response. If you cannot message the user yourself, the agent that
spawned you shows it.

## Apps

An app is a standalone page the user opens full screen from the Apps section
of the left bar ("make me an app", "+ new app"). Put it in apps/<app-name>/
with an index.html entry (scripts, styles and data in the bundle; the CSP
blocks external scripts and fetches), and add it under "apps" in rose-ui.json
with a short title and an optional icon. `rose-ui dev` previews it at
/file/apps/<app-name>/index.html; `rose-ui check` measures it like a view.
`rose-ui publish` gives it the user's app URL on usercontent and adds it to
the Apps section; every publish is a version the user can restore from
History. A built app (for example a vite project's `npm run build` output)
goes in the same folder: copy the build into apps/<app-name>/ with relative
asset paths.

## Tools for the user's agent

tools/<tool_name>/tool.json:

    {
      "name": "<tool_name>",
      "description": "one sentence the agent reads to decide when to call it",
      "input_schema": { "type": "object", "properties": { ... } },
      "output_schema": { ... },              optional; results are validated
      "render": { "view": "<view-name>" },   optional; result becomes that inline view's props
      "side_effects": false,                 true if a call changes anything outside the tool
      "idempotency_key_field": "request_id", optional, side_effects only (see below)
      "timeout_s": 60,                       default 60, max 300
      "runtime": "node",                     or "python"
      "entry": "tools/<tool_name>/handler.js",
      "files": ["lib.js"]                    optional extra files, relative to tools/<tool_name>/
    }

The handler reads one JSON object (the input) on stdin and writes one JSON
object on stdout. A non-zero exit is reported to the agent as a tool error.
It runs in this user's own code session (a fresh working directory each
call), with no secrets in its environment, the timeout_s limit and a 256 KB
output cap. After publishing, the user's next root-agent run can call it as
user__<tool_name>.

A side_effects tool runs at most once per agent tool call: a retried call
gets the recorded result back without running the handler again. Its
handler receives the call's idempotency key as ROSE_IDEMPOTENCY_KEY (and in
its input under idempotency_key_field, which must not be an input_schema
property); pass it to downstream APIs that accept one.

## The preview host

`rose-ui dev`, `screenshot`, `record`, `perf` and `check` load your files in a
preview host. It is NOT the Rose app: it approximates the chrome around your
slots (sidebar, home, chat column, composer) with the app's default tokens,
applies your theme exactly like the app, and loads your files the same way:
a second origin, the production CSP, sandbox="allow-scripts" and the same
bridge. It has no login, no real agents and no rose.* data API.

Routes: / (home), /agent (a conversation with your inline views and the
agent.panel slot), /inline/<view>, /slot/<name>, /shell, /file/<any.html>
(e.g. /file/apps/<app-name>/index.html); add ?safe=1 for the stock UI.
