# The Rose app UI bundle: inline views and apps

The bundle belongs to ONE user (the user you are working for). `rose-ui pull`
writes their published version into a folder; `rose-ui publish` turns the
folder into a new immutable version and, unless you pass `--no-activate`, the
user sees it immediately. Publish when the user should see the change, the
same way you would merge. Rollback = publish/activate an earlier version.

## Layout

    <folder>/
      rose-ui.json     manifest (required) — see "Manifest" below
      inline/<view>/   views rendered inline in the chat trajectory
      apps/<app>/      standalone apps opened from the Apps section
      tools/<tool>/    tools for this user's agent (reference/tools.md)
      screenshots/     local captures (never published)

A pulled bundle may hold other files the user published earlier; keep them
unless the user asks otherwise. Files and folders whose name starts with "."
and any node_modules/ are never published, and neither is screenshots/.
Limits: 10 MB per file, 50 MB total, 2000 files.

## Manifest (rose-ui.json)

    {
      "version": 1,
      "inline": {
        "<view-name>": { "entry": "inline/<view-name>/index.html",
                         "summary": "one line describing the view",
                         "poster": "inline/<view-name>/poster.png" }
      },
      "apps": {
        "<app-name>": { "title": "Tip calculator",
                        "entry": "apps/<app-name>/index.html",
                        "icon": "apps/<app-name>/icon.svg" }
      }
    }

Paths are relative to the folder (no "/" prefix, no ".."). Every referenced path must exist or
publishing fails. View and app names match [a-z0-9-]+. An app's entry and
icon live inside apps/<app-name>/, and "rose" is reserved.

## How your code runs

Every entry is an HTML page loaded in a sandboxed cross-origin iframe
(sandbox="allow-scripts", strict CSP). It cannot read the Rose session or call
the Rose API directly; it talks to the host with postMessage:

From your view to the host (window.parent.postMessage(msg, "*")):
  { type: "rose:ready" }                  you are initialised
  { type: "rose:resize", height: <px> }   your content height (inline views;
                                          clamped to 60..900)

From the host to your view (window.addEventListener("message", ...)):
  { type: "rose:props", props: {...} }    inline view props from the message

The frame's origin is opaque ("null"), which means:
- no localStorage, sessionStorage, IndexedDB or cookies; keep state in memory;
- fetch() of your own files is a CORS request (allowed: usercontent sends
  Access-Control-Allow-Origin: *);
- `new Worker("file.js")` is refused; fetch the script and start it from a
  blob: URL (the CSP allows worker-src blob:), see examples/particles-worker;
- WebAssembly is allowed ('wasm-unsafe-eval'; .wasm is served as
  application/wasm), see examples/wasm-viz;
- scripts, styles and data live in the bundle: the CSP blocks external
  scripts and fetches.

## Inline views

Build a game, chart or other visual the user should see in the conversation
as an inline view: write inline/<view-name>/index.html, add it under "inline"
in rose-ui.json with a one-line summary, run `rose-ui publish`, then show it
with `rose message "<text>" --inline-view <view-name> [--props '<json>']` and
name the view in your final response. If you cannot message the user
yourself, the agent that spawned you shows it.

The message pins the published version, so later publishes never change old
messages. Keep props small JSON. Put an example of the props next to the view
as props.example.json; `rose-ui dev`/`screenshot` feed it to the view.

## Apps

An app is a standalone page the user opens full screen from the Apps section
of the left bar ("make me an app", "+ new app"). Put it in apps/<app-name>/
with an index.html entry, and add it under "apps" in rose-ui.json with a
short title and an optional icon. `rose-ui dev` previews it at
/file/apps/<app-name>/index.html; `rose-ui check` measures it like a view.
`rose-ui publish` gives it the user's app URL on usercontent and adds it to
the Apps section; every publish is a version the user can restore from
History. A built app (for example a vite project's `npm run build` output)
goes in the same folder: copy the build into apps/<app-name>/ with relative
asset paths.

## The preview host

`rose-ui dev`, `screenshot`, `record`, `perf` and `check` load your files in a
preview host. It is NOT the Rose app: it approximates the chat around your
views with the app's default look and loads your files the same way: a
second origin, the production CSP, sandbox="allow-scripts" and the same
bridge. It has no login, no real agents and no rose.* data API.

Routes: / (home), /agent (a conversation with your inline views),
/inline/<view>, /file/<any.html> (e.g. /file/apps/<app-name>/index.html).
