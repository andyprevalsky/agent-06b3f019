# Rose builds Rose: validation criteria

**North star:** Andy uses Rose, not boxes.dev, to build Rose. That covers
desktop and the iPhone web app, with code agents, previews, PRs, bug detection
and deploys.

Every requirement Andy stated in the 2026-10-20 sessions (this thread plus the
UI-agent thread) is listed here as a validation criterion. Each lane owner
(one sub-agent per lane):

1. turns its criteria into automated evals: tests, judge prompts or
   benchmarks;
2. builds the change;
3. iterates until every eval passes;
4. records evidence (SHA, test or eval run, recording link) in the Status
   column.

**Rules:**
- A criterion is **done** only with passing eval evidence. UI criteria also
  need a real recording, accepted by the UI-agent thread.
- **Approvals are collected at `/deploy`, not before.** That covers harness
  tools, prompt text, Zod schemas and env writes. Build everything and queue
  each approval item in the "Deploy approvals" list at the bottom.

UI specs, mockups and acceptance belong to the UI-agent thread (its "UI
ledger" in `rose-user-ui.md`). This file is the cross-cutting checklist, and
`U*` rows point at that ledger.

**Tier:** **M** = must-have for the north star; **N** = nice-to-have.

## Code agents

| ID | Tier | Criterion | Eval (minimum) | Lane | Status |
|----|------|-----------|----------------|------|--------|
| C1 | M | A new code session restarts from the exact last state: files including uncommitted and untracked, local commits, CLI conversation; memory too when the sandbox pause survived | backend + agents blackbox restore round trip; kill → restore from checkpoint | W5 | in progress |
| C2 | M | A failed code agent keeps its state on Temporal retry (same `code_session_id`) | agents blackbox: fail mid-run → retry → file present | W5 | in progress |
| C3 | M | Prompt: commit locally when a unit of work is done; merge when other agents or the user need it; the agent decides | template diff + judge on 3 replayed sessions | W5 | in progress |
| C4 | M | `merged` is reported only when the GitHub API confirms the merge and main contains the sha | blackbox with mocked GitHub | W5 | in progress |
| C5 | M | Everything a code agent did is greppable from the root tree (commands, outputs, diffs, repo files) | trajectory-grep blackbox | W5 | in progress |
| C6 | M | Code agents (Claude Code and Codex) are part of the Rose agent graph: they can list agents, message root and other agents, and grep the tree; root can message them | agents blackbox + live smoke with a real Codex session | L-A2A | open |
| C7 | M | The user can talk to a coding agent directly: open it in the tree, type, and the message reaches the CLI; output streams back. Typed message to first token p50 ≤ 3 s | e2e smoke + latency eval; usability judge comparing direct vs relayed | L-DIRECT | open |
| C8 | M | Code-capability benchmarks in `tasks.json` (repo bug fix, feature, refactor, front-end build). The Rose code agent matches the underlying CLI run directly (within ±1 task or 5%), and results reproduce across 3 runs | new `rose-bench` code tasks + parity runner | L-BENCH | open |
| C9 | M | Codebase sync integration (like boxes.dev): pick up a local dev checkout, including env files, secrets, symlinks and the dependency setup the cloud needs, so a cloud code session runs it. Secrets are never committed or logged | mac-app/CLI blackbox: fixture repo with symlinked `.env` → cloud session `run.sh` health OK; secret-leak scan | L-SYNC | open |
| C10 | M | Bug detection runs on Rose infra: auto-RCA (`slack-auto-rca`) spawns a Rose code agent on the Rose repo instead of a GitHub Actions dispatch, and its result posts back | backend blackbox (signed Slack event → Rose agent created with RCA goal) + live smoke | L-RCA | open |

## Projects (replaces "folders"/Apps naming)

| ID | Tier | Criterion | Eval (minimum) | Lane | Status |
|----|------|-----------|----------------|------|--------|
| PJ1 | M | Repos and apps are **Projects**. The left bar has a Projects section, Rose first; a settings icon appears on the right of a project row when the bar is expanded or hovered | FE blackbox + recording | L-NAV | open |
| PJ2 | M | Project settings: **default branch** (default `main`), **startup script**, **startup timeout** (default 120 s), **environment files** with managed values (add, delete, search by name/file/description; values encrypted, never logged), **lifecycle** (auto-wake on/off) | backend blackbox (owner-scoped CRUD, encryption at rest, defaults) + FE blackbox | L-SYNC (backend) / L-NAV (UI) | open |
| PJ3 | M | A code session for a project checks out the default branch, writes the managed env files (0600), then runs the startup script with the timeout. A timeout or failure is reported to the agent and the user and doesn't hang the session; it runs on create and on resume after boot | local-sandbox blackbox: fixture project → env files present, script ran, timeout enforced | L-SYNC | open |
| PJ4 | M | The Rose project is seeded with its real setup: startup script `agents/benchmarks/fixtures/projects/rose-startup.sh`; env files `agents/.env`, `back-end/.env`, `agents/.env.benchmark-temporal`, `front-end/.env`, `mac-app/.env`, `research/.env`, imported by codebase sync (C9) from Andy's checkout. A Rose code session reaches a healthy `scripts/run.sh` | live smoke on the Rose project | L-SYNC | open |

## rose_user_ui, Apps, Rose-in-Rose

| ID | Tier | Criterion | Eval (minimum) | Lane | Status |
|----|------|-----------|----------------|------|--------|
| A1 | M | Rose-in-Rose: a code session on the Rose repo runs vite HMR. Andy sees the edited Rose on screen about 1 s after a write. Publish opens a PR; ships only via `/deploy`; dev accounts only | e2e: agent write → preview DOM change ≤ 3 s; non-dev account 403 | L-APPS | blocked on W5 |
| A2 | N | Lovable-style Apps: "Make me an app", "+ new app", Apps section on the left bar (Rose first). Full-screen app with the floating query box and Popular Goals hidden; live-preview card in the trajectory; History restore; per-user publish URL | FE blackbox + e2e (UI ledger) | L-APPS | blocked on W5 |
| A3 | N | `rose_user_ui` per user: `root/` changes the whole app, `inline/` renders in the trajectory (version pinned), `tools/` adds root-agent tools whose results render inline; safe mode | W1/W2/W4 suites (passing) + recordings | merged | code merged; recordings pending |
| A4 | N | Code agents get UI instructions, current screenshots and `rose-ui screenshot/record/perf/check` | E2B template test | L-APPS | open |
| A5 | M | `display(paths\|urls, caption?)` tool for root, sub-agents and code agents; media posts inline in that agent's trajectory; idempotent per content hash | agents blackbox | L-DISPLAY | open (approval at deploy) |
| A6 | N | Root browser with world state split by website: agents fork Root's state; logins merge back; you can take over any tab | agents/browser blackbox | L-BROWSER | open |

## UI (specs live in the UI ledger, owned by the UI-agent thread)

| ID | Tier | Criterion | Lane | Status |
|----|------|-----------|------|--------|
| U1 | M | Top-left button becomes **Home** (same function: return to root) | L-NAV | open |
| U2 | M | Agents pane gains the key boxes.dev functions: project settings, build settings, and the template box as Home | L-NAV | open |
| U3 | M | Integrations, Network and similar move from the left bar to the right app bar | L-NAV | open |
| U4 | M | Hovering the right bar or the agents pane expands it to full titles (no dragging) | L-NAV | open |
| U5 | M | On mobile, ultrafast/fast toggle stays visible; ultra looks more lit; **ultrafast is the default** | L-DEFAULTS | open |
| U6 | M | **rose-flash** is the default model selection | L-DEFAULTS | open |
| U7 | N | Dark mode as an app: navi black reflected into a lighter black across the diagonal (two triangles) | L-DARK | open |
| U8 | N | Popular goals: "Go to youtube.com", "Go to instagram.com", "Go to linkedin.com" (plus the existing background/game goals) | L-DEFAULTS | open |
| U9 | N | Phone app: renders the attached phone as an iPhone. If an agent is using it: "Another agent is using this", a button to view that agent, a bigger blue **Take control** button, and a release-back trigger | L-PHONE | open |
| U10 | M | Everything above works on the mobile web/PWA (layout, hit targets, safe area) | every FE lane + L-PERF | open |
| U11 | M | Images and video inline by default (desktop and mobile web) | W6 | in progress |
| U12 | M | Mobile query box hugs the bottom screen curve (safe area plus matching radius) | W6 | in progress |
| U13 | N | Chrome cleanup: Research/Careers removed; About/Privacy/Terms behind an info icon in the nub toolbar; pinned "Import Code Repo" goal | W6 | in progress |
| U14 | N | Already merged, awaiting recordings: nub, white Join Waitlist, right app bar with Browser and Voice, Browser drawer replacing fullscreen, background fade, no wrappers | merged | recordings pending |

## Performance (added by the parent agent; all M)

| ID | Criterion | Eval |
|----|-----------|------|
| P1 | iPhone web app is fast: cold load LCP ≤ 2.5 s and TTI ≤ 3.5 s on simulated 4G, mid-tier iPhone CPU (4x throttle); warm load ≤ 1 s | Lighthouse mobile + WebKit Playwright (iPhone 15 profile); validate on the phone harness / real device when available |
| P2 | Interactions: INP ≤ 200 ms on send, open agent, open drawer and switch tab | Playwright performance traces |
| P3 | Smooth: ≥ 55 fps for drawer, nub and fade animations and for scrolling a 1,000-message trajectory; no long task > 50 ms during scroll | trace frame timing |
| P4 | Realtime: agent message to on-screen p95 ≤ 500 ms | instrumented e2e |
| P5 | Memory: the mobile tab stays ≤ 300 MB JS heap after 30 min with 4 live inline views; no leak across 50 agent switches | heap snapshots |
| P6 | Bundle: main JS ≤ current baseline + 10%; user-ui, apps and drawers code-split | build size check in CI |
| P7 | Code agent latency: resume ≤ 5 s (paused) / ≤ 30 s (from checkpoint); HMR preview ≤ 3 s after a write | blackbox timings |
| P8 | 10k-agent rule: no per-user firehose; per-agent channels only; O(1) queries per message for every feature above | review + structural checks |

## Lanes

- **W5:** persistent code sessions.
- **W6:** front-end follow-ups.
- **L-A2A:** code agents in the Rose graph.
- **L-DIRECT:** direct chat with code agents.
- **L-BENCH:** code benchmarks and parity.
- **L-SYNC:** codebase sync integration.
- **L-RCA:** bug detection on Rose infra.
- **L-APPS:** Rose-in-Rose and Apps (after W5).
- **L-DISPLAY:** the display tool.
- **L-BROWSER:** root browser and world state.
- **L-NAV:** Home, boxes functions, right-bar moves, hover-expand.
- **L-DEFAULTS:** speed and model defaults, popular goals.
- **L-DARK:** dark mode app.
- **L-PHONE:** phone app.
- **L-PERF:** mobile performance validation (P1–P6), run last over the merged branch.
- **Auditor:** an independent judge that re-checks every row against its evidence before `/deploy`.

## Deploy approvals (collect at `/deploy`)

- Harness: user tools in root toolset (W4); `display` tool (A5); code-agent graph tools (C6); `code_session_id` tool param (C1).
- Prompt text: code-agent template commit/merge guidance (C3); tool descriptions added by each lane.
- Schemas: `rose-ui.json` and `tool.json` validation; any new Zod schemas.
- Env and prod: `USERCONTENT_BASE_URL` (separate origin), `USER_UI_TOKEN_SECRET`, E2B template rebuild.
