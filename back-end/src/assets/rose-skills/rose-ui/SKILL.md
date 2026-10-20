---
name: rose-ui
description: Use to build something the user should see or play inside the chat (an inline view), or an app they open from the Apps section.
---

# The user's Rose app UI: inline views and apps

The user you work for has a Rose app UI bundle: inline views (shown in the
chat) and apps (opened full screen from the Apps section). The `rose-ui` CLI
on PATH pulls their published bundle, previews and measures your edits, and
publishes a new version that the user sees immediately.

## When to use

- The user should look at or play something (a game, chart, demo or other
  interactive visual) inside the conversation: build it as an inline view,
  publish it, then show it with `rose message "<text>" --inline-view <view>`
  (talk-to-user skill) and name the view in your final response. Still put
  any requested files in the output directory.
- "Make me an app" or "+ new app": a standalone page the user opens from the
  Apps section (the apps-preview skill covers building and previewing it).

## When not to use

- Showing a page, image, video or file once: `rose display <path>`
  (talk-to-user skill) needs no bundle.
- Plain files the user asked for: the output directory.

## Workflow

1. `rose-ui pull [<dir>]` writes the user's published bundle (a starting
   bundle when they have none) into `<dir>`, default ~/rose_user_ui. Later
   commands use the folder you pulled; `--dir <dir>` picks another.
2. Add or edit inline/<view>/ or apps/<app>/ and its rose-ui.json entry. The
   format is ~/.rose/skills/rose-ui/reference/bundle.md;
   ~/.rose/skills/rose-ui/reference/examples.md indexes reference
   implementations in ~/.rose/skills/rose-ui/examples/.
3. Look before you publish: `rose-ui screenshot --route /inline/<view>`,
   `rose-ui record` and `rose-ui dev` render your local, unpublished folder.
   Claude Code's Read tool and Codex's view_image open the PNGs.
   `rose-ui screenshot --current` captures what the user sees now.
4. `rose-ui check` must pass before `rose-ui publish`. The budgets are in
   ~/.rose/skills/rose-ui/reference/performance.md.
5. `rose-ui publish` makes the folder a new immutable version and shows it to
   the user (`--no-activate` holds it back). Rollback = publish or activate an
   earlier version.

## Commands

    rose-ui pull [<dir>] [--force]       the published bundle into <dir>; --force replaces local files
    rose-ui screenshot [--route /inline/<view>] [--viewport 1440x900] [--out file.png]
    rose-ui screenshot --current         the user's published UI → screenshots/current/
    rose-ui record [--route /] [--seconds 5]   MP4 + frame strip, to judge motion
    rose-ui perf [--entry path.html | --route /]   metrics as JSON
    rose-ui dev [--port 5170]            live preview that reloads on file changes
    rose-ui check [entry.html ...]       budgets; exits 1 on violations
    rose-ui publish [--no-activate]      publish the folder

Every command except `pull` takes `--dir <dir>`. The record capture rate is
not the render rate; use `rose-ui perf` for frame rates. Tools for the user's
agent in the same bundle are described in
~/.rose/skills/rose-ui/reference/tools.md.
