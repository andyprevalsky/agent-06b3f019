# rose_user_ui — your user's Rose app

Everything in this folder is the Rose app UI for ONE user (the user you are
working for). When you run `rose-ui publish`, the folder becomes a new immutable
version and — unless you pass `--no-activate` — the user sees it immediately.
Publish when the user should see the change, the same way you would merge.
Rollback = publish/activate an earlier version.

## Layout

    rose_user_ui/
      README.md        this file (regenerated every session)
      rose-ui.json     manifest (required) — see "Manifest" below
      root/
        theme.json     CSS tokens + background (data only, no code)
        shell/         optional full-viewport shell ("OS mode")
        slots/<slot>/  widgets mounted into named host slots
        assets/        images, gifs, video, fonts
      inline/<view>/   views rendered inline in the chat trajectory
      tools/<tool>/    tools for this user's agent (tool.json + handler)
      examples/        reference implementations (not published unless referenced)
      screenshots/     local captures (never published)
        current/       the user's PUBLISHED UI, captured at session start

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
      "capabilities": ["read", "subscribe", "navigate", "create_agent", "send_message"]
    }

Every key except "version" is optional. Paths are relative to this folder (no
"/" prefix, no ".."). Every referenced path must exist or publishing fails.
View names match [a-z0-9-]+; tool names match [a-z0-9_]+.

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
send_message_to_user(message, inline_view={ view: "<view-name>", props: {...} }).
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
with a one-line summary, run `rose-ui publish`, then name the view in your
final response. If you cannot call send_message_to_user yourself, the agent
that spawned you shows it.

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

## See your work

Look before you publish, and look again after. Claude Code's Read tool and
Codex's view_image open the PNGs.

- screenshots/current/ holds the user's PUBLISHED UI (home-desktop.png,
  home-mobile.png, agent-desktop.png, agent-mobile.png and index.json),
  captured at session start, or by the first rose-ui browser command if the
  start-up capture could not run. Desktop is a 1280x800 viewport at 2x
  (2560x1600 PNG); mobile is 390x844 at 3x. No published version → index.json
  says so (the user sees the stock UI).
- `rose-ui screenshot [--route /agent] [--viewport 1440x900] [--scale 2]`
  `[--out file.png] [--published]` renders your LOCAL, unpublished folder.
- `rose-ui record [--route /] [--seconds 5]` writes an MP4 plus a frame strip
  PNG, to judge motion. The capture rate is not the render rate; use perf.
- `rose-ui dev` serves a live preview (port 5170, reloads on file changes).
- Routes: / (home), /agent (a conversation with your inline views and the
  agent.panel slot), /inline/<view>, /slot/<name>, /shell, /file/<any.html>
  (e.g. /file/examples/rose-os/index.html); add ?safe=1 for the stock UI.

The preview host is NOT the Rose app. It approximates the chrome around your
slots (sidebar, home, chat column, composer) with the app's default tokens,
applies your theme exactly like the app, and loads your files the same way:
a second origin, the production CSP, sandbox="allow-scripts" and the same
bridge. It has no login, no real agents and no rose.* data API.

## Performance budgets (`rose-ui check`)

`rose-ui check` measures every manifest entry (add --examples, or name HTML
files) in headless Chromium at 1280x800 and exits 1 on any violation:

- frame rate: p50 >= 55 fps and p5 >= 30 fps on the main thread and in each
  worker that animates (target 60, 120 on ProMotion);
- no main-thread task over 50 ms while running (load-time ones are warnings);
- cumulative layout shift <= 0.1; no animation of layout properties (width,
  height, top, left, margin, padding, ...): animate transform/opacity/filter;
- stops when hidden: <= 2 callbacks/s (rAF + timers, page and workers) after
  a visibilitychange to hidden;
- prefers-reduced-motion: under reduce, no continuous motion (<= 0.1% of
  pixels changing per 400 ms, median of 3 intervals);
- size: <= 5 MB per entry folder, <= 1.5 MB of JS/WASM, <= 2 MB per media
  file, GIFs <= 512 KB (use MP4/WebM or animated WebP/AVIF instead);
- no uncaught errors; theme tokens valid.

`rose-ui perf [--entry path.html | --route /]` prints the numbers as JSON: fps
p50/p5 (main + workers), long tasks, layout shift, bytes loaded, a GPU memory
estimate. fps is judged on the better of two windows; on an overloaded host
(load above 1.25 per CPU) or a host that can't render a blank page at 55 fps,
missed fps budgets are reported as inconclusive warnings, not failures. The
sandbox has no GPU (software rendering), so GPU-heavy work measures slower
than on the user's device: budget for that, e.g. cap shader resolution.

## Rules of thumb

- Target 60 fps, 120 fps on ProMotion displays; no main-thread task > 50 ms.
- Render canvases at devicePixelRatio, with a pixel budget for heavy shaders.
- Animate only compositor properties (transform, opacity, filter); never
  animate layout (width, height, top, left, margin).
- Respect prefers-reduced-motion and prefers-reduced-transparency.
- Stop animation loops when hidden (document.visibilitychange) or offscreen
  (IntersectionObserver).
- Lazy-load and size media (width/height); prefer AVIF/WebP and MP4/WebM over
  large GIFs.

## Examples

Each one passes `rose-ui check` and documents how to wire it at the top of its
index.html. Copy the folder to root/ or inline/ and add it to rose-ui.json.

- examples/inline-hello — the smallest inline view (props, resize).
- examples/shader-background — WebGPU shader background with a WebGL2
  fallback; DPR-aware pixel budget, quality governor, pauses when hidden.
- examples/agent-dashboard — live agent dashboard from rose:props, with View
  Transitions and a FLIP fallback; props.example.json shows the shape.
- examples/particles-worker — OffscreenCanvas particles in a Web Worker,
  simulated at a fixed 120 Hz; blob: worker pattern for the sandbox.
- examples/media-menu — animated menu decorations: lazy MP4 loops, AVIF/WebP
  stills in <picture>, sized and paused offscreen (8 KB of video, no GIFs).
- examples/rose-os — "Rose OS" windowed shell: menu bar, dock, draggable
  windows, all transform-only.
- examples/wasm-viz — Rust → WebAssembly reaction-diffusion; src/lib.rs is
  the source of viz.wasm (rebuild with build.sh).

## Commands

    rose-ui publish                 publish this folder and show it to the user
    rose-ui publish --no-activate   publish a version without showing it yet
    rose-ui dev                     live preview of your local files
    rose-ui screenshot [...]        PNG of a route (see "See your work")
    rose-ui screenshot --current    re-capture screenshots/current/ (published UI)
    rose-ui record [--seconds N]    MP4 + frame strip
    rose-ui perf [...]              performance metrics as JSON
    rose-ui check [--examples]      budgets; exit 1 on violations
