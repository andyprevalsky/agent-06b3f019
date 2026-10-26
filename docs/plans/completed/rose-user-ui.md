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

### UI ledger (owner: UI-agent thread)

Every UI pointer from Andy, in order. The UI agent owns specs, mockups,
acceptance and recordings for each; code lands through the coding thread.
Status: `done` (merged + verified in a recording), `building`, `queued`,
`decision`.

| # | Pointer | Status |
|---|---------|--------|
| 1 | No mountain/macOS wallpaper by default; background only if user sets one; 20% fade after first message | building (W2 merged, W3) |
| 2 | Voice orb: rose tint, no white tile/padding, minimized and expanded | building (W3) |
| 3 | Root browser always available; one tab per agent; world state forked per agent, logins merge back | queued |
| 4 | No decorative wrappers anywhere (tiles, chips, rings, pills around icons/labels); active = color/weight | standing rule |
| 5 | Mic icon raised and clear on top of every orb | building (W3) |
| 6 | Agent browser opens as a smooth right drawer, replacing full-screen view | building (W3) |
| 7 | Rose in Rose: edit Rose's own UI live through a code agent | queued (Apps, #10) |
| 8 | Extension points: user tools rendered inline + alter root view | W4 merged (read-only tools, off in prod) |
| 9 | Recordings of everything working, all recordings in every UI report | standing rule |
| 10 | Apps, Lovable-style; left-bar Apps section; app full screen in its own browser; query box over it; Popular Goals hidden; live preview card in trajectory; Rose is an app | queued (after W5 sessions) |
| 11 | Mobile query box hugs the iPhone bottom curve | queued (after W3) |
| 12 | A2A: coding agents and root message each other; tree includes coding; Codex lists agents | queued (after A2A lands) |
| 13 | Images/videos inline by default, desktop web + mobile web/PWA; `display` tool for agents | queued; `display` tool = decision (harness) |
| 14 | Remove Research/Careers; About/Privacy/Terms behind info icon in nub toolbar | queued (after W3) |
| 15 | "Import Code Repo" is just another popular goal: same pill style as the rest, first in the rotation, not pinned, no special colors | spec'd (supersedes the pinned navi-black pill) |
| 16 | Screenshots shown without Join Waitlist (logged-in look) | standing rule |
| 17 | Top-left button is **Home** = the root project (same function as before: return to root) | spec'd, queued (L-NAV) |
| 18 | Left bar = agents pane: Home, **Projects** (Rose first; ⚙ on the right of a row when expanded opens project settings), New project, live agents, Archived, Settings, account | spec'd, queued (L-NAV) |
| 19 | Project settings (boxes.dev model, Rose light styles): default branch (main), startup script editor, startup timeout (120 s), Environment files (count, managed values note, + Add a file, search, rows expandable with trash), Lifecycle (auto-wake, startup script) | spec'd, queued (L-NAV + L-SYNC) |
| 20 | Right bar apps: Browser, Voice, Phone, **Files**, **Terminal**, Integrations, Network, Payments, Benchmarks, What's new, Dark mode (moved off the left bar) | spec'd, queued (L-NAV) |
| 21 | Hovering either bar expands it to full titles; no dragging | spec'd, queued (L-NAV) |
| 22 | Panels/drawers open flush against their bar: full height, no gap or margin, no floating card | spec'd, queued (W6/L-NAV) |
| 23 | Defaults: model rose-flash; speed toggle Fast · **Ultrafast** (default, rose and slightly lit), visible on mobile | spec'd, queued (L-DEFAULTS) |
| 24 | Goals (flag on): first Andy's set — Import Code Repo, Make me an app, Make me a website, Change my background photo, Make me a game, Go to youtube.com, Go to instagram.com, Go to linkedin.com — then the existing goals **minus**: Get me into Stanford, Make me happy, Make sure my parents are taken care of, Save children in Gaza | spec'd, live in nav.js |
| 25 | Dark mode is an app: icon = navi black (#272725) top-left triangle + lighter black bottom-right triangle | spec'd, queued (L-DARK) |
| 26 | Phone app: attached phone drawn as an iPhone; when an agent uses it: "Another agent is using this", View agent, big blue Take control (#0a84ff), release-back line | spec'd, queued (L-PHONE) |
| 27 | Mobile web/PWA: both bars become a slide-in drawer from the header; same items; 44 px hit targets; safe areas | spec'd, queued (U10) |
| 28 | UI review happens live in the shared Browser pane, not screenshots | standing rule |
| 29 | Collapsed left bar keeps the existing icons unchanged (gray `Bot` agent glyph + status dot, black New Agent button, archive, settings) | spec'd |
| 30 | Left bar keeps Search and a raw **New Agent**; each project row also has **+** (new agent in that project) next to its ⚙ | spec'd |
| 31 | Rose nub = small tab on the BACK of the query box, flush with its left edge. Closed: a **4px** lip (20% of open height), 34px wide. Hover/tap: grows to 18px tall (~220 ms) and slides sideways to show white 12px icons/10px text (lock, context files, tools, budget, context %, settings, info). Background = Rose icon gradient; its lower part continues behind the box and is masked so the gradient wraps the box's 12px top-left curve but never shows through the box. 30px gap above it to Popular Goals | spec'd, live in nav.js `.mk-tab` |
| 43 | Every nub item has an instant hover tooltip (navi black #272725, 11.5px, above the item): Safe writes on · click to unlock / Writes unlocked · click to lock, Context files, Tools, Budget used · $X of $Y, Context window used, Agent settings, About · Privacy · Terms | spec'd, live in nav.js `.mk-tip` |
| 44 | Code agents in the trajectory (existing ClaudeCodeChip look): completed = check + 'Completed Successfully' + task subtitle + duration, expanded summary shows commit sha, branch, tests passed, files changed (+/−) and only **Open preview** (no View diff / Open PR links); active = pulsing green dot + 'Active' + live dark terminal (#101211) with a running timer; root shows a one-line waiting status under them. Multiple code agents can share one branch | spec'd, live in nav.js starter trajectory |
| 45 | Steer code agents like a normal coding-agent UI: the code-agent chip's default tab is **Transcript** (collapsible Thinking, assistant messages, compact tool rows Read/Edit ±/Run ✓), with **Terminal** as the second tab; a **Message <agent> directly** box at the bottom of the chip sends straight to that CLI session (C7). The code agent is also openable from the left tree as a full conversation | spec'd, live in nav.js |
| 46 | Code agents talk to the user only through Rose tools (exposed in the sandbox): `send_message_to_user` (text + inline views, e.g. scorecards rendered as a colored table attributed "Codex · via send_message_to_user"), `request_user_approval` (existing ApprovalChip pinned above the query box, labelled with the requesting agent; the answer returns to the CLI as the tool result and the agent waits), `display` (images/recordings). Prompt rule: never rely on the user reading the raw terminal | spec'd → coding thread (harness + prompt; approval at /deploy) |
| 47 | A code agent's **question** goes through `display(..., placement: "pinned")`: rendered fixed directly above the query box (not inline), header "<agent> asks" with its icon and a dismiss ✕, the question, then the candidate answers **listed vertically and numbered 1, 2, 3** (bold label + one-line description, optional "Recommended"), and a final numbered **Other…** text input like a normal question picker. Click or press the number to answer; Enter in Other sends free text. Answered → unpins, answer appears in the agent transcript and returns to the agent. Approvals keep using request_user_approval (ApprovalChip) | spec'd, live in nav.js |
| 47b | Question routing by spawner: a code agent spawned by the **root** agent pins its question for the user (row 47). A code agent spawned by any **non-root** agent (anywhere in the network) sends its question to the parent Rose agent that spawned it via the A2A send-message path; the parent answers from its own context, or escalates up the tree the same way. Only root ever pins a question for the user. The exchange shows in both agents' transcripts as "Codex → <parent>" / "<parent> → Codex" | spec'd → coding thread (L-A2A) |
| 50 | Branch/worktree model: a **new agent** (New Agent, or + on a project) gets its own isolated worktree on a new branch cut from the project's default branch (`main`). A **sub-agent** gets its own worktree on a new branch cut from its parent's branch (e.g. `rose-ui/polish` → `rose-ui/polish/speed`) and merges back into the parent's branch when done. Only right-click **New agent in this branch** shares the parent's worktree/session. The trajectory and agent rows show each agent's branch | spec'd → coding thread (W5); live in nav.js |
| 51 | Local execution (like the Claude/Codex desktop apps), 90/10: one param on the existing code-agent tool, `target: "cloud" \| "local"` (default cloud). `local` runs the same `ws-server.mjs` the E2B template uses (already proven by `providers/claudeCodeLocalSession.ts`) inside the Mac app, in a folder the user granted, and **opens a real local terminal window** (Terminal/iTerm via the Mac app) attached to that session so the user can watch and type. `local` is **only available to agents initiated from the Mac app** (web/PWA-created agents see cloud only). If the Mac app is closed or disconnects, a local code agent **fails immediately** (no waiting, no silent fallback to cloud) with this exact error, shown in the chip's existing red failure box and returned to the calling agent as the tool error: "**Can't run locally: the Rose Mac app on <device name> is closed or disconnected.** Open the Rose Mac app and retry, or run this agent in the cloud." A web/PWA-initiated agent asking for local gets: "**Local runs need an agent started from the Rose Mac app.** Start this agent from the Mac app, or run it in the cloud."  Transcript, steering, questions, display, branches and no-timeout rules are otherwise identical. Chip header shows the target ("This Mac · ~/Developer/rose" or "Cloud") | spec'd → coding thread; live in nav.js |
| 52 | Dark mode is **just a toggle** in the right bar (no panel/drawer): moon icon + 'Dark mode' in light; sun icon + 'Light mode' in dark; click flips and persists per user. Icon is a standard **moon** (not the triangles). Dark also turns on the app's native `dark` class. Background: solid navi black #272725, no triangles; **no tile animations and no dots** (SmallTileAnimationCanvas layers hidden); grid lines, the main tile border and sparkle circles are neutral silver (never blue) at the **same low brightness** as each other; pill-light streaks dimmed; header pill dark (rgba(32,32,30,.78), light text); Fast/Ultrafast toned down (no glare) | spec'd, live in panels/dark.js |
| 53 | Send (and pause) button: **light mode = stock LiquidWhiteButton, untouched** (matches the Mac quick launcher). **Dark mode only**: the liquid-metal shader shows just as a ~3px outer ring, the core is black glass (dark radial tint, backdrop refraction via an SVG turbulence×edge displacement filter, launcher-style inset top highlight, soft top specular, no rainbow/chromatic fringe), white icon. Rule: no dark-mode change may alter light mode | spec'd, live in nav.js + panels/_liquidglass.js (dark-scoped CSS) |
| 54 | Code agents can display **HTML + JS** (e.g. a game) via `display`: rendered in a sandboxed iframe on the usercontent origin with scripts allowed, playable inline and in the preview drawer. Today the preview drawer's `default-src 'none'` CSP blocks scripts (recording run2, flow 3) | spec'd → coding thread |
| 55 | Popular Goals row is exactly as wide as the query box: its left edge and the pills' right-hand cutoff line up with the query box's left/right edges (today it overshoots by ~28px each side) | spec'd, live in nav.js |
| 56 | Remove **Terminal** and **Network** from the right-bar apps (right bar: Browser, Phone, Files, Integrations, Dark mode; admin: Payments, Benchmarks, Feedback). Send button liquid-metal ring dimmer and inner white inset glow minimal (less white shine) | spec'd, live in nav.js |
| 57 | Left bar order: Home, New Agent, Search, then agents **grouped by project**: each project row (folder, name, + new agent here, ⚙ settings) followed by its agents (indented), then + New project, then the Home (root project) agents — Projects on top (Andy, 2026-10-26). Collapsed bar: project rows hidden; the groups of agent icons are separated by small line-pill dividers (18×3px, neutral) | spec'd, live in nav.js |
| 58 | Right bar now: Browser, Phone, Integrations, Dark mode; admin bottom: Payments, Benchmarks, Feedback (**Files removed for now**; Files app, when back, has no New file / New folder buttons). Panels slide left as the right bar hover-expands so they are never covered. **Browser opens full screen** between the two bars. **Phone is not a panel/modal**: just the iPhone (plus its Take control button), floating off the right bar, vertically centered, with a drop shadow | spec'd, live in nav.js |
| 59 | Right bar bottom: **Feedback** sits right above the Admin section and is shown to **all** users; Admin (admins only) = Benchmarks. Payments moves into **account settings**. Left bar has **no Settings button**: clicking the account row (Andy) opens Settings **flush against the right bar, in the same slot as the other right panels**, with **exactly the existing Settings tabs** (features/settings/Settings.tsx, reuse its components): Customization · Personal Info · Billing · API Keys. Payments (credits, budget, AgentCard cards, charges) live under **Billing**. Panels beside the left bar slide right while it hover-expands | spec'd, live in nav.js |
| 60 | Projects: **+ New project creates inline** (an input row in the list; Enter creates, Esc cancels). Right-click a project: Rename project (inline edit), Project settings, Delete project (red). Project settings gains **Code repo**: repository URL with Change, default branch, GitHub connection status | spec'd, live in nav.js |
| 61 | Integrations panel: keep the new grouped layout; **Browser Cookies section first**; remove the "X of Y connected · Rose reads these…" summary line | spec'd, live in panels/integrations.js |
| 62 | Dark mode scrollbars: `color-scheme: dark`, thumb #4a4a46 (hover #5c5c57) on transparent track, everywhere | spec'd, live in panels/dark.js |
| 63 | Account row (bottom-left): signed-in = the **first letter of the user's name as a cursive capital** (Pinyon Script, self-hosted OFL font; ~27px, current text color, no circle/wrapper); signed-out/anon = the existing member (user) icon | spec'd, live in nav.js |
| 64 | Agent rows use **only the supported run-state glyphs** (existing AgentStatusIndicator / CompactRow): running = bare Bot glyph (expanded: the existing ROSE dot-matrix), needs your input/question = amber alert, done = muted check, failed = muted red ✕. No custom colored dots | spec'd, live in nav.js |
| 65 | Dark mode covers **every** surface: right panels, Settings, project settings, context menus, tooltips, code-agent chips, scorecards, the pinned question card, bars and query box (panel bg #262624, raised #2f2f2c, text #ecece8, muted #a3a39d, borders rgba(255,255,255,.09), dark icons lightened). Implement with Tailwind `dark:` tokens on each component (mock uses panels/_darkify.js only as a stand-in) | spec'd, live in mock |
| 66 | **No right bar.** In the app (flag on), the 4 app icons — Browser, Phone, Integrations, Dark mode toggle — sit bare along the **top-right** (no bar/background, 34px hit targets, tooltips on hover). Research / Careers / Download are removed in the app. The signed-out **website** keeps Research / Careers / Download and shows no app icons. Feedback (all users) and Benchmarks (admin) move to the bottom of the left bar above Archived. Right panels and Settings open flush against the window's right edge starting below the icon row (top 56px, top-left radius 12px); Browser is full screen from the left bar to the right edge below the icons; Phone floats 24px from the right edge, vertically centered, and nothing behind it: no background between or around the iPhone and its Take control button | spec'd, live in nav.js (supersedes right-bar rows 20/33/56/58/59 placement) |
| 67 | Top-right app icons open **full-height** drawers (top 0, flush right edge); the icon row floats over the drawer's top-right; clicking the active icon closes it (panels have no own ✕). Settings behaves the same | spec'd, live in nav.js |
| 68 | Integrations icon shows a small **red dot** when any integration needs reconnection (tooltip names it) | spec'd, live in nav.js |
| 69 | Admin item is **Biz health** (existing features/admin-health page in the right drawer), not Benchmarks | spec'd, live in nav.js + panels/bizhealth.js |
| 70 | Feedback uses the existing lucide **Megaphone** icon (SidebarFeedbackButton) | spec'd, live in nav.js |
| 71 | Dark mode: completed agents' check is **green** (#22c55e); light keeps the muted gray check | spec'd, live in panels/dark.js |
| 72 | Theme switch is **instant** for every background layer: tile dots/grid/streaks repaint on the same frame the `dark` class flips (canvas redraw on theme change, no fades) | spec'd |
| 73 | Every icon in panels stays visible in dark (dark brand marks/glyphs lightened to #d6d6d2) | spec'd, live in panels/_darkify.js |
| 74 | Browser drawer has real browser chrome: tabs row (Root + one per agent), then **Back / Forward / Reload** buttons and a rounded **address bar** showing the current URL (Forward dimmed when unavailable) | spec'd, live in panels/browser.js |
| 75 | Query box keeps exactly two controls from the old toolbar, pinned **top-left inside the box, always visible, exact existing styling**: the Rose toolset (RoseToolSetChip wrench) and, admin only, the world simulator (SimulatorToggle). **Both keep byte-identical styling in dark mode** (no dark: overrides on them; global dark rules must exclude them). Everything else from that row lives in the nub strip (lock, context files, budget, context %, settings, info — no Tools item there) | spec'd, live in nav.js |
| 76 | Left bar button reads **New Super Agent** | spec'd, live in nav.js |
| 77 | Model selector shows only the short pool name: **rose-flash** or **rose-ultra** | spec'd, live in nav.js |
| 78 | Integrations (flag on): sections in the **existing order** (Browser Cookies, Passwords, Messages, Compute, Banks, Socials, File System); **existing icons/assets**; every integration supports **multiple connected accounts shown as ConnectedAccountChip chips** (tone synced/syncing/warning) with remove on the chip and '+ Add account'; **no Manage state**; every syncing account shows a progress bar (rose→violet gradient, 4px, soft glow + shimmer) with 'N of M <unit>' and '~ETA left', flipping to synced at 100% — for iMessage, WhatsApp, Gmail, LinkedIn, Plaid, browser cookies, passwords and any other syncing source | spec'd, live in panels/integrations.js |
| 48 | Code agents have **no timeouts** anywhere in the path (Temporal workflow/activity start-to-close and schedule-to-close, CLI wrappers, sandbox lifetimes): liveness is heartbeat-only, and when activity stops the session sleeps (sandbox paused, resumable) instead of failing | spec'd → coding thread (W5 / harness) |
| 49 | Remove **Voice** from the right-bar apps | spec'd, live in nav.js |
| 32 | Speed = FastModeToggle shape (26px square, Zap icon only at ~10.4px — 20% smaller than 13px, NO words) next to the model button, 3 states: Normal (muted outline) → Fast (icy rose-blue: pale rose→ice-blue gradient, blue #3a8fdc filled zap) → **Ultrafast** (default; very icy: brighter ice gradient, #1f8ff0 zap with white/cyan glow and a faint rose halo). Bottom row: attach is a bare paperclip (no background, border or shadow); speed is a square exactly the model selector's height (26px); the info icon button is removed | spec'd, live in nav.js `.mk-spd` |
| 33 | Right bar: apps on top (Browser, Phone, Files, Terminal, Integrations, Network, Dark mode); admin tabs pinned to the bottom (Payments, Benchmarks, Feedback). The megaphone is Feedback (no "What's new") | spec'd |
| 34 | Background end state after the first message is **80%** opacity (was 20%) | spec'd (changes #1) |
| 35 | (superseded by #15: Import Code Repo is a plain goal pill) | superseded |
| 37 | Right-click an agent row: menu styled like the boxes.dev thread menu (icon + label rows, dividers, destructive items red, Copy ›), first item **New agent in this branch** (same E2B session/branch), then Archive, Mark unread, Mute notifications, Rename, Share, Delete, Schedule a prompt…, Copy › | spec'd, live in nav.js |
| 38 | Files app matches the boxes.dev Files panel in Rose light styles: header (icon, Files, expand, close), toolbar Up/Home/Reveal + New file/New folder, breadcrumb, Search files, one tree with chevrons, git-modified entries tinted blue, Quick Look on click | spec'd, mock in progress |
| 39 | Two browsers: when an agent is building an **app**, its preview renders in the user's LOCAL browser (a window/tab of Rose pointing at the E2B session's hosted preview URL, per agent/branch, so a swarm = one preview URL per code session); when an agent does a **real-world task**, it's the remote browser (Kernel live view) in the Browser drawer | spec'd |
| 40 | Root agent write lock = one small bare lock icon (no "Safe Writes" pill/label); click toggles; unlocked = rose | spec'd, live in nav.js |
| 41 | Anything coding-based is routed to a code agent (root delegates; it doesn't code itself) | spec'd → coding thread (harness; approval at /deploy) |
| 42 | **All of this ships behind one feature flag, on only for Andy's account** (user 1f85ff25-6e29-4c1b-8739-f917bd101a30, root devbox); everyone else sees today's UI | spec'd → coding thread |
| 36 | Every right-bar tab opens a working panel flush to the bar (mock reference: `.context/rose-app-builder-mock/panels/*.js`) | mocks done (11 panels) |
| 79 | (superseded 2026-10-20 by #81: no thinking bubble or status glyphs on code-agent rows) | superseded |
| 80 | Clicking a **code-agent row** in the left bar enters that code agent: its own conversation view (provider icon, title, target/branch, state; full transcript) and the normal query box talks to it directly ("Message Codex…"); Escape/parent/Home returns | spec'd, live in nav.js; FE-16 |
| 81 | Code-agent rows = provider icon + title only (no check, x, alert or thinking bubble); agent (robot) rows keep their status glyphs | spec'd, live in nav.js; FE-16 |
| 82 | Left bar Home row reads just **Home** (no "· root project") | spec'd, live in nav.js; FE-16 |
| 83 | **Left-bar Apps section removed** (Andy: "rm the weird apps shit"); the full-screen app view opens only from a code agent's live preview card | spec'd, live in nav.js; FE-15 |
| 84 | Mobile/iPad header (flag on): hamburger + Rose pill + the four app icons (Browser, Phone, Integrations w/ red dot, Dark) — never just "Rose ≡" | spec'd, live in nav.js; FE-16 |
| 85 | Integrations = one account per integration (single chip, × disconnects, no "+ Add account") + the gradient sync loader; icons keep their **stock app-icon backgrounds** (iMessage/WhatsApp tiles, DropdownIconFrame) visible in dark; backend loader contract sent to the coding thread | spec'd, live in panels/integrations.js; FE-17 + L-CULL-INTEG |
| 86 | Phone app = floating iPhone with a calm **Coming soon** screen (phone harness built in its own devbox; no /api/phones) | spec'd, live in panels/phone.js; FE-17 |
| 87 | Browser app is not auto-opened; opening it with an agent selected starts at that root tree's default_url | spec'd → FE-17 |
| 88 | Dark mode dividers/hairlines are subtle (row separators ≈ rgba(255,255,255,.07), outer borders ≤ .10), never bright white | spec'd, live in nav.js; FE-13 |
| 89 | **Removed (Andy, 2026-10-20):** whole-app user settings — user theme/tokens, background image + fade (rows 1, 25, 34), and slots (sidebar header/menu, home dashboard, agent panel, background). Apps, versions/rollback, inline views and the Rose dark-mode toggle stay | removing → FE-18 + backend |
| 90 | Display is a full inline renderer (page/bundle/model/image/video/pdf via usercontent_url; frame sandbox "allow-scripts allow-pointer-lock allow-popups", never same-origin; models get a viewer page) | backend L-DISPLAY3; FE after contract |
| 91 | Integrations: multi-account support that already existed stays; only the new per-phone/per-profile/LinkedIn-multi additions are removed; every account gets the sync loader | supersedes the multi-account part of 78/85 → FE-17 |
| 92 | Code-agent conversations (Claude Code + Codex) reuse the **main-chat renderer**; the existing query box targets the native session (attachments, per-session model/effort/speed with effective-state ack, drafts kept until delivery ack); send always steers (idle → next turn, no default queue); questions/approvals sit above the composer, which stays; display output appears in the code agent's own AND parent conversation (canonical id, no duplicates); real streaming with stable rows and duplicate-free reconnect; no file/diff/plan views | agreed by Andy (Codex thread thr_4aa53d39…); FE-16 + backend thread |

### UI ledger owners (audit 2026-10-20)

Every ask from Andy in the UI-agent and coding threads, mapped to an owner. FE-n = UI-agent front-end workers (merged by the UI agent into one SHA for the coding thread); L-* / C* = coding-thread lanes (rose-builds-rose.md).

| Owner | Rows | State |
|---|---|---|
| FE-1..FE-10 | 11-15, 17-25, 29-34, 37, 40, 43-47, 51-53, 55, 57-78 (UI halves) | merged in ui-integration (gate green at b4870be23; feat merged at 511197ab0) |
| FE-11 code agents | display HTML via usercontent_url, code_agent paused / usage-limit text (Retry waits on L-CODEAGENT-API), batched code-agents list, share_code_session_with, 79 | merged |
| FE-12 integrations | Gmail I3, Passwords/Passkeys I7, LinkedIn I4 (export goal text: approval at deploy), WhatsApp I2 | merged |
| FE-13 dark visual fixes | dark query surface, dark New Super Agent + model chip, speed square radius, admin switcher into Settings | in progress |
| FE-14 root browser | Browser drawer: Root by default, selected agent's tab, take over, per-site fork/merge text, sites list; server account labels | in progress |
| FE-15 apps | 10, 39: left-bar Apps (Rose first, dev only), full-screen app view + query box, History restore, Publish → PR, live preview card | in progress (mock: Apps section in nav.js) |
| Coding thread | 3/A6 root browser world state, 10 + 39 Apps / Rose-in-Rose / local preview URLs (L-APPS), 12 A2A (C6), 13 display tool (A5), 34 backend default, 37 backend new-agent-in-branch, 41 + C12 routing prompts, 46-47b in-sandbox tools + routing by spawner, 48 no timeouts (C11), 50 branch model (C13), 51 local target (C14), 54 HTML+JS (done a151a214c), Phone backend, Projects REST + Agent.projectId | lanes running / queued |
| UI agent | real recordings (rerun after C12/row-41 merge), integration merge of FE-1..5, live mock | ongoing |
| Dropped by Andy | Voice, Terminal app, Network app, Files app, right bar, pinned Import pill, liquid-black send (light), two-triangle dark bg | — |

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

### Apps (Lovable-style builder; Rose is one app)

Rose replaces the user's devboxes, so making apps is first-class. This reverses
the earlier removal: the "Make me an app" goal comes back. UX reference: Lovable.

```
 left bar                 selected app = full screen, in its own browser
 ┌────────────┐ ┌──────────────────────────────────────────────────────────┐
 │ + new      │ │ Rose ▾   Preview · Code · History              Publish   │
 │ Agents …   │ │                                                          │
 │ ── Apps ── │ │          live app UI (vite HMR, ~1 s after a write)      │
 │ ● Rose     │ │                                                          │
 │   Game     │ │                       ┌── chat with this app ──────────┐ │
 │   + new app│ │                       │ "make the header sticky"       │ │
 │            │ │                       │ edits stream in, file chips    │ │
 └────────────┘ │                       │ [ message input ]              │ │
                └───────────────────────┴────────────────────────────────┴─┘
 trajectory: any agent making an app posts a live preview card in its chat;
             clicking it opens the same full-screen app view.
```

- **Apps section on the left bar:** below agents, one row per app plus
  "+ new app". Rose is always first for dev accounts. The selected app is
  marked by color/weight only (no wrappers).
- **Selecting an app renders it full screen** in that app's own browser tab
  (its preview URL), replacing the chat view. The normal query box floats over
  the app (Popular Goals hidden) and talks to that app's code agent; the latest
  exchange shows just above it.
  Escape or reselecting the agent list returns to the normal view.
- **Trajectory shows the app:** whenever an agent is building an app, its
  conversation shows an inline live-preview card of the app (updates on every
  write). Clicking the card opens the full-screen app view. This works for any
  agent, including sub-agents, so the user always sees what is being built.
- **An app is a repo in the user's persistent code session**
  (`code-agent-persistent-sessions.md`): checked out, deps installed, dev server
  kept warm between spawns. Its code agent is a normal resumable code session.
- **Lovable-style loop:** query box over the live preview, Code view of the files, History of versions with one-click restore, Publish to a
  per-user URL on the usercontent origin. New apps start from a template and
  are previewable within the first agent turn.
- **Rose is a built-in app.** Its repo is the Rose GitHub repo; the same
  workspace edits the real Rose front-end with HMR preview (Rose-in-Rose).
  Preview talks to the prod backend as the user and is limited to dev
  accounts. Publish for Rose means opening a PR; everyone gets it only through
  `/deploy`. Safe mode always returns stock Rose.
- **Mobile query box:** hugs the bottom of the iPhone display curve exactly:
  sits on `env(safe-area-inset-bottom)` with bottom corner radius matched to
  the device's screen corner radius (no gap, no flat edge against the curve),
  in the normal view and over a full-screen app.
- **A2A with coding agents** (after the background-agents A2A work lands):
  coding agents can message root and root can message coding agents;
  agent-tree messages include coding agents; Codex can list agents.
- **Apps vs `rose_user_ui`:** an app is a standalone thing the user opens from
  the left-bar Apps section; `rose_user_ui` changes Rose's own chrome, tools and inline
  views. Both are written by the same code agent.
- **Tests:**
  - "Make me an app" adds a row to the left-bar Apps section and its
    trajectory shows a live preview card;
  - selecting an app (including Rose) renders it full screen with its chat
    panel, and a message sent there reaches that app's code agent;
  - an agent file write appears in the preview within a few seconds;
  - History restore brings back the previous preview;
  - the Rose app is hidden for non-dev accounts and its Publish opens a PR,
    never a direct deploy.

### Chrome cleanup

- **Remove Research and Careers** from the top nav on desktop and from the
  mobile web/PWA header.
- **About · Privacy · Terms move behind the rose nub:** the footer links are
  removed; the toolbar the nub reveals ends with a small bare info icon (no
  wrapper) that opens a tiny menu with About, Privacy and Terms.
- **Pinned goal "Import Code Repo":** fixed at the left of the Popular Goals
  row (right after the label on desktop; first item on mobile) while the other
  goals keep rotating behind it. Navi black (`navi-black` #272725) pill, white
  label, bare import arrow (tray + down arrow) stroked white→rose gradient, no
  wrapper around the icon. Selecting it starts the import-repo flow (code
  session clones the repo; it then shows up as an app).
- **Tests:** "Import Code Repo" stays at the same x position while the
  carousel moves; no Research/Careers link renders on desktop or a 390px viewport;
  the footer has no legal links; hovering/tapping the nub shows the info icon
  and its menu links resolve to the existing pages.

### Images and media inline by default

- **Default inline, desktop web and mobile web/PWA:** images and videos in any message,
  tool result or file output render inline in the trajectory at full column
  width (aspect preserved, no chip and no click needed). Several in a row form
  a gallery strip; tapping opens the existing preview drawer. Mobile uses the
  full screen width. Videos show a poster and play inline, muted.
- **`display` tool for agents:** root, sub-agents and coding agents (Claude
  Code and Codex sessions) get a `display` tool: `display(paths|urls, caption?)`
  publishes the files to the user's storage and posts them inline in that
  agent's trajectory. Coding agents use it for screenshots and recordings of
  what they built (pairs with the app live-preview card). Idempotent per
  content hash so a Temporal retry never posts twice.
- **Tests:** an image attachment renders as an `<img>` inline on desktop and a
  390px mobile viewport without a click; a `display` call from a coding agent
  shows the image in the parent tree's trajectory once, even after a retry.

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
