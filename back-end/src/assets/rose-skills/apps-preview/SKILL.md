---
name: apps-preview
description: Use for a live, hot-reloading preview of a web front-end, for apps in the Apps section, or when the checkout is Rose itself.
---

# Apps and live preview

## When to use

- "Make me an app" or "+ new app": a standalone page the user opens full
  screen from the Apps section of the left bar.
- A web front-end (vite) the user should watch change while you work.
- The checkout is Rose itself (see "Rose itself" below).

## When not to use

- Something to show inside the chat: an inline view (rose-ui skill).
- Plain files the user asked for: the output directory.

## Apps

An app lives in the user's UI bundle, so `rose-ui pull` first (rose-ui
skill). It goes in apps/<slug>/ with an index.html entry, and a title (and an
optional icon) under "apps" in rose-ui.json; the format is in
~/.rose/skills/rose-ui/reference/bundle.md.

- `rose-ui dev` previews it at /file/apps/<slug>/index.html, and
  `rose-ui check` measures it like a view.
- `rose-ui publish` gives it the user's app URL and adds it to the Apps
  section. Every publish is a version the user can restore from History.
- A built app (for example a vite project's `npm run build` output) goes in
  the same folder: copy the build into apps/<slug>/ with relative asset paths.

## Live preview

    rose-preview start [--dir <app dir>] [--port N] [--json]
    rose-preview status [--json]
    rose-preview url
    rose-preview stop

`rose-preview start` serves a vite app from this session with hot reload; the
user sees each saved file about a second later. `rose-preview url` prints the
address the user opens. The app dir defaults to $ROSE_PREVIEW_DIR, then
~/workspace/front-end, then ~/workspace.

## Rose itself

When your instructions say the checkout in ~/workspace is Rose itself:

- Its front-end preview runs from front-end/ and talks to Rose as the user. A
  cloud session starts it for you; `rose-preview start` starts or restarts it.
- Publishing a Rose change to the agent network uses the existing `/deploy`
  workflow, coordinated with its release owner. Follow the deploy skill; an
  open pull request is not yet publication. Preserve its checks and approvals.
