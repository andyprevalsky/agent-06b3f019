---
name: rose-ui
description: Use to change how Rose looks or behaves for the user, or to build something they should see in the chat (an inline view).
---

# The user's Rose app UI

The Rose app UI of the user you work for is a bundle of files: manifest,
theme, slots, shell, inline views, apps and tools. The `rose-ui` CLI on PATH
pulls their published bundle, previews and measures your edits, and publishes
a new version that the user sees immediately.

## When to use

- The user asks to change how Rose looks or behaves for them: theme,
  background, slots, a shell.
- The user should look at or play something (a game, app, chart or other
  visual): build it as an inline view, publish it, then show it with
  `rose message "<text>" --inline-view <view>` (talk-to-user skill) and name
  the view in your final response. Still put any requested files in the
  output directory.
- An app the user opens from the Apps section: see the apps-preview skill.

## When not to use

- Plain files the user asked for: they go in the output directory.
- Showing a screenshot or recording of other work: `rose display`.

## Workflow

1. `rose-ui pull [<dir>]` writes the user's published bundle (a starting
   bundle when they have none) into `<dir>`, default ~/rose_user_ui. Later
   commands use the folder you pulled; `--dir <dir>` picks another.
2. `rose-ui screenshot --current` captures what the user sees now into
   `<dir>/screenshots/current/` (home and agent pages, desktop 1280x800 at 2x
   and mobile 390x844 at 3x, plus index.json). Open the PNGs before you
   change anything. With no published version, index.json says so: the user
   sees the stock UI.
3. Edit the folder. ~/.rose/skills/rose-ui/reference/bundle.md is the format:
   layout, manifest, theme, how your code runs, inline views, apps, tools and
   the preview host. ~/.rose/skills/rose-ui/reference/examples.md indexes the
   reference implementations in ~/.rose/skills/rose-ui/examples/.
4. Look before you publish: `rose-ui screenshot`, `rose-ui record` and
   `rose-ui dev` render your local, unpublished folder. Claude Code's Read tool
   and Codex's view_image open the PNGs.
5. `rose-ui check` must pass before `rose-ui publish`. The budgets are in
   ~/.rose/skills/rose-ui/reference/performance.md.
6. `rose-ui publish` makes the folder a new immutable version and shows it to
   the user (`--no-activate` holds it back). Rollback = publish or activate an
   earlier version. Look again after publishing.

## Commands

    rose-ui pull [<dir>] [--force]       the published bundle into <dir>; --force replaces local files
    rose-ui screenshot --current         the user's published UI → screenshots/current/
    rose-ui screenshot [--route /agent] [--viewport 1440x900] [--scale 2] [--out file.png] [--published]
    rose-ui record [--route /] [--seconds 5]   MP4 + frame strip, to judge motion
    rose-ui perf [--entry path.html | --route /] [--full]   metrics as JSON
    rose-ui dev [--port 5170]            live preview that reloads on file changes
    rose-ui check [entry.html ...] [--examples]   budgets; exits 1 on violations
    rose-ui publish [--no-activate]      publish the folder

Every command except `pull` takes `--dir <dir>`. The record capture rate is
not the render rate; use `rose-ui perf` for frame rates.
