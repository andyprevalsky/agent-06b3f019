# rose_user_ui — code agents rewrite the Rose app, per user (experimental)

## Goal

A user's code agent can change **the Rose app itself** for that user — themes,
menus, GIFs, persistent dashboards, up to a full replacement shell ("a whole OS").
Changes are always scoped to one user. Any web-targeting language is allowed
(TS/JS default; WASM from Rust/Zig/C; WGSL/GLSL shaders).

Depends on `code-agent-persistent-sessions.md` (workspace persistence + grep).

## Design

```
 code agent sandbox (E2B)
   /home/user/rose_user_ui/          ← per-user git repo, restored every session
     README.md        how to use (generated, versioned with the CLI)
     rose-ui.json     manifest: slots, entrypoints, capabilities
     root/            app-wide layer (affects the entire app)
       theme.json       CSS tokens (colors, radii, fonts, motion)  — no code
       shell/           optional full-viewport shell ("OS mode")
       slots/<slot>/    widgets mounted into named host slots
       assets/          gifs, video, fonts, images
     inline/<view>/   views rendered inline in the main chat trajectory
     tools/<tool>/    tools added to this user's root agent
       tool.json        name, description, input/output schema, render view,
                        side_effects + idempotency key field
       handler.*        any language; runs in the user's persistent code session
     examples/        hyper-expressive reference implementations
     screenshots/     current published UI, refreshed at session start
   rose-ui CLI: dev | screenshot | record | perf | check | publish
        │ publish (agent decides, like a merge — shares state with the user)
        ▼
 backend  /api/user-ui   validate manifest → build → store
   storage user-ui/<userId>/<version>/…   UserUiVersion row, User.activeUiVersionId
        │
        ▼
 Rose front-end (app origin)                   usercontent origin
   load active manifest for session user        <userhash>.usercontent.roselabs.ai
   theme.json → CSS variables (validated)       sandboxed iframes run user code
   slots/shell → <iframe sandbox="allow-scripts"> (no allow-same-origin)
   postMessage bridge ⇄ rose.* capability API (host executes as the user)
   safe mode: ?rose_safe=1, Cmd/Ctrl+Shift+. , fixed corner control → stock UI
```

### Per-user scoping (hard invariant)

- Repo, storage paths, versions and active pointer are keyed by `userId`; RLS on
  `UserUiVersion`; backend serves only the session user's manifest.
- Each user's code runs on its own usercontent origin, so storage, cookies and
  service workers never cross users and never touch the app origin.
- No sharing between users in v1.

### Security model

- User code **never** executes on the app origin: theme is data (validated
  tokens, CSS values only); everything else is a cross-origin iframe with
  `sandbox="allow-scripts"` and a strict CSP. It cannot read the Supabase
  session or call the backend directly.
- Bridge `rose.*` API: read (agents, messages, theme, route), subscribe to a
  single agent's stream (reuses per-agent channels), navigate, and write
  (create agent, send message). Write capabilities must be declared in
  `rose-ui.json` and get a one-time user confirmation per version.
- Safe mode is host code that user UI cannot override; rollback = activate any
  previous version.
- Electron: same iframe rules; usercontent origin gets no preload/node.

### Slots

v1: `background`, `sidebar.header`, `menu`, `home.dashboard`,
`agent.panel`, and `shell` (full-viewport, replaces app chrome except the
safe-mode control). `root/theme.json` applies everywhere.

### Default shell: Rose Desktop

Every user's `rose_user_ui` is seeded with `root/shell/rose-desktop/` as the
active shell. It is the default look and the reference the code agent edits.
Safe mode returns the current stock UI.

```
 ┌──────────────────────────────────────────────────────────────┐
 │  menu bar (Liquid Glass)                         clock  ⌘    │
 │                                                              │
 │   wallpaper (high-res photo, per-user choosable)             │
 │                                                              │
 │   ┌───────────── agent pane ─────────────┐  ┌── Finder ───┐  │
 │   │ agents list │ conversation           │  │ ▸ Agents    │  │
 │   │             │                        │  │ ▸ Files     │  │
 │   │             │  [ message input ]     │  │ ▸ rose_ui   │  │
 │   └──────────────────────────────────────┘  └─────────────┘  │
 │                         dock                                 │
 └──────────────────────────────────────────────────────────────┘
```

- **Look:** current macOS style (Liquid Glass materials, SF-style type,
  rounded windows, vibrancy). Folder icons are Apple midnight blue with a
  reflective gradient into space gray.
- **Agent pane:** list of agents plus the chat with the selected agent.
  Uses the bridge's existing read, subscribe and send capabilities.
- **Before the first message:** the agent pane is fully opaque, with the
  Finder panel hidden.
- **After the first message:** the pane background animates to 20% opacity so
  the wallpaper shows through. Text, input and controls stay fully opaque and
  legible. The Finder panel slides in on the right.
- **Finder panel:** the user's file system. Agent output files, shared and
  uploaded files, `rose_user_ui`, and code-session repos. List and icon views,
  Quick Look preview, and search backed by `grep`.
- **Motion:** compositor-only transitions (opacity, transform, backdrop blur),
  60/120 fps. Honors `prefers-reduced-motion` and
  `prefers-reduced-transparency`; with reduced transparency the pane stays
  opaque.

### Apps bar and root browser

A right-side app bar mirrors the left bar. v1 apps: **Browser** and **Voice**,
which shows the onboarding orbs small with a rose tint and a persona.

The Browser app has a permanent **Root** tab plus one tab per active agent.
Selecting an agent switches to that agent's tab.

World state is split by website, using a fork-and-merge model:

```
 Root world state (per user)        cookies / storage / logins per website
   │ fork on agent browser start (copy, snapshot version recorded)
   ├─► Agent A context   (own tabs, own copy)
   └─► Agent B context
   ◄── merge on change: login/session cookies for a website flow back to Root
       (newest snapshot version per website wins; logouts never merge)
```

- **Isolation:** agents never drive the Root tab. Two agents on the same
  website each have their own context, so they can't overwrite each other's
  carts or forms.
- **Logins reach every agent:** a login made in Root or in any agent is merged
  back. New agents fork with it; running agents pick it up on the next
  navigation to that website.
- **User control:** the user can take over any agent tab. That agent pauses
  until the user hands it back.
- **Context source:** "authenticated sessions" agent context reads Root's
  world state.
- **Replaces fullscreen:** opening an agent's browser (browser chip / expand)
  no longer opens `BrowserStatusBarFullscreen`. It slides the Browser drawer
  in from the right bar, already on that agent's tab. Animation: transform +
  opacity only, about 520 ms with ease-out `cubic-bezier(.22,1,.36,1)`; the chat
  column re-centers in the same frame budget.
- **Carried over from fullscreen:**
  - task-progress panel (inside the drawer);
  - take control / hand back;
  - disconnected and waiting overlays;
  - the fixed 1280×800 remote viewport, letterboxed into the drawer. The
    remote viewport is never resized, which would break the anti-bot
    fingerprint.
- **Drawer sizing:** default width is 50% of the viewport, resizable. Mobile
  uses a full-height sheet.
- **Tests:**
  - clicking expand on an agent's browser chip opens the drawer on that tab;
  - `BrowserStatusBarFullscreen` no longer mounts;
  - user-control hand-back works from the drawer;
  - `rose-ui perf` holds at least 55 fps during the open animation.

### User tools (`tools/`)

The two extension points are `tools/` + `inline/` (add a capability and render
its result in any way) and `root/` (alter the normal view).

```
 code agent writes tools/<t>/ + inline/<v>/ → publish (per user, versioned)
        │
 root agent (Temporal) for that user declares <t> alongside built-in tools
        │ tool call
 activity: run handler in user's code session (resume/pause per persistence plan)
        │ JSON result (validated against output schema)
 tool message metadata.inlineView = {view: <v>@version, props: result}
        └► rendered inline in the trajectory (poster when offscreen)
```

- **Scope:** tools are per user. The set is pinned to the published version at
  workflow start, so Temporal replay is deterministic and the tool schemas in
  the cached prompt prefix stay stable for that run.
- **Idempotency** (CLAUDE.md rule 20): a tool that declares side effects must
  name an idempotency key. The activity records `(tool, key) → result` and
  returns the recorded result on retry.
- **Limits:** a timeout per call (at least 60 s if the handler calls an LLM),
  an output-size cap with a file pointer for overflow, and failure returned as
  a tool error. Nothing is injected into the trajectory beyond the real tool
  result (rule 25a).
- **Approval points:** the `tool.json` Zod schema, and adding user tools to the
  root agent's declared toolset (a harness change).
- **Tests:**
  - a published tool is callable by that user's root agent and invisible to
    another user's;
  - a retry of a side-effecting tool doesn't run the handler twice;
  - a result that fails schema validation becomes a tool error;
  - the result renders through its inline view;
  - the toolset stays pinned while a later version is published mid-run.

### Inline trajectory views (`inline/`)

Interactive views shown inside the main chat trajectory, between messages —
charts, explorers, live dashboards, simulations, generated reports.

```
 any agent in the tree                         MessageListItems.tsx
   send_message_to_user(text,                    message.metadata.inlineView
     inline_view={view, version, props})   →     = {userId, view, version, props|propsPointer}
        │                                          │ in viewport?
   code agent authors inline/<view>/ and          ├─ yes → <iframe sandbox="allow-scripts">
   publishes it (immutable version)               │        usercontent origin, auto-height
                                                  └─ no  → poster.png (static snapshot)
```

- A message pins `view@version`, so old messages always render as they did when
  sent; republishing never mutates history.
- `props` is small JSON in message metadata; larger data is a file pointer the
  bridge resolves (per-user storage).
- Each published inline version also stores `poster.png` (rendered by
  `rose-ui screenshot`) and a text summary. The poster is used offscreen, on
  mobile low-power, in SMS/email surfaces and archives; the summary is indexed
  so `grep` finds inline views.
- Height: the view reports its content size over the bridge; the host clamps it
  to a maximum and offers expand-to-fullscreen.
- Performance in long trajectories: only iframes in or near the viewport are
  live (cap configurable, default 4); the rest show posters. Hidden views get a
  `visibility` event and must stop animation loops (`rose-ui check` enforces).
- The bridge gives inline views the same `rose.*` read capabilities plus the
  context of the message they belong to (agentId, messageId).

### Viewing the UI (screenshots)

- Session start: `screenshots/current/*.png` captured from the user's
  **published** UI (desktop 2560×1600 @2x, mobile 390×844 @3x) for the main
  routes.
- `rose-ui dev` runs a preview host (prebuilt Rose front-end bundle shipped in
  the E2B template) loading the **local, unpublished** `rose_user_ui`, backed by
  a short-lived, read-only, per-user preview token.
- `rose-ui screenshot [--route --viewport --scale]` → PNG (Claude Code `Read`
  and Codex `view_image` both open images); `rose-ui record` → short MP4 +
  frame strip to judge smoothness.
- `rose-ui perf` → fps p50/p5, long tasks > 50 ms, layout shift, bundle size,
  GPU memory estimate; `rose-ui check` fails on budget violations.

### Hyper-expressive examples (shipped in `examples/`)

1. WebGPU (WebGL2 fallback) shader background, DPR-aware, paused when hidden.
2. Persistent dashboard of live agents (React + bridge subscriptions), FLIP and
   View Transitions animation.
3. Canvas/OffscreenCanvas particle system in a worker at 120 Hz.
4. Animated GIF/APNG/video menu decorations, lazy-loaded, sized assets.
5. "Rose OS" shell: windowed desktop, dock, draggable agent windows.
6. Rust→WASM compute module driving a visualization.

README rules: target 60 fps (120 on ProMotion); no main-thread task > 50 ms;
render at `devicePixelRatio`; respect `prefers-reduced-motion`; compositor-only
animations (transform/opacity); budgets enforced by `rose-ui check`.

### Workspace integration

Every code session restores `/home/user/rose_user_ui` from the user's latest
repo bundle (separate git repo from the task repo, persisted by the
checkpoint mechanism). Publishing follows the same rule as merging: the agent
publishes when the user should see the change.

### Approval points

- `rose-ui.json` manifest Zod schema (CLAUDE.md rule 5) — included in this
  approved plan; any later change needs fresh approval.
- Template prompt / README text is prompt-scoped (rule 26).
- Front-end changes need a mac-app version bump.

### 10k-agent behavior

Static assets on CDN; one active pointer row per user; manifest fetched once per
app load (plus a publish notification on the user's own session); bridge
streams reuse per-agent channels — no per-user firehose.

## Verification (automated)

- **Backend blackbox** `user-ui.blackbox.ts`: publish/activate/rollback;
  invalid manifest rejected; user B cannot read/activate user A's versions;
  storage paths keyed by userId.
- **Front-end vitest**: theme tokens applied as CSS variables and non-CSS
  values rejected; slot iframes have exact `sandbox`, `src` on the user's
  usercontent origin; bridge rejects undeclared capabilities and requires
  confirmation for writes; safe mode (query, shortcut, control) renders stock
  UI with the shell slot active.
- **Front-end vitest (inline)**: a message with `inlineView` renders the pinned
  version on the usercontent origin; offscreen messages render the poster;
  no more than the live-iframe cap are mounted in a 500-message trajectory;
  republishing a view does not change an older message's version.
- **Rose Desktop shell tests** (E2B template + Playwright):
  - a new user's active shell is `rose-desktop`;
  - before the first message the pane is opaque and Finder is hidden;
  - after sending one message, the pane background measures 20% opacity,
    text contrast stays at least 4.5:1, and Finder is visible on the right;
  - the transition holds at least 55 fps on `rose-ui perf`;
  - with reduced transparency the pane stays opaque.
- **Agents blackbox**: `send_message_to_user` with `inline_view` persists the
  pinned version and props; an unpublished or another user's view is rejected.
- **Structural test**: no user-UI artifact is ever loaded on the app origin
  (no `srcdoc`, `blob:` or same-origin URLs for user code).
- **E2B template test**: `rose-ui screenshot` produces a PNG of the preview host
  with a local theme change visible (pixel probe); `rose-ui perf` reports
  metrics for the shader example; `rose-ui check` fails a deliberately janky
  fixture.
- **Agents blackbox**: new code session contains `rose_user_ui/` with README,
  manifest, examples and current screenshots; state persists across sessions.
- **Benchmark** `rose-user-ui-menu-and-dashboard` (`pipeline-e2e`): "make my
  menu purple and add a dashboard of my running agents" → static check of the
  active manifest/theme + screenshot LLM judge; second user's UI unchanged.
