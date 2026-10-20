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
| C1 | M | A new code session restarts from the exact last state: files including uncommitted and untracked, local commits, CLI conversation; memory too when the sandbox pause survived | backend + agents blackbox restore round trip; kill → restore from checkpoint | W5 | **built + merged** (f78bf8aa8; suites ×5, re-run on every merge); live E2B pause unverified |
| C2 | M | A failed code agent keeps its state on Temporal retry (same `code_session_id`) | agents blackbox: fail mid-run → retry → file present | W5 | **built + merged** (f78bf8aa8; suites ×5, re-run on every merge); live E2B pause unverified |
| C3 | M | Prompt: commit locally when a unit of work is done; merge when other agents or the user need it; the agent decides | template diff + judge on 3 replayed sessions | W5 | **built + merged** (f78bf8aa8; suites ×5, re-run on every merge); live E2B pause unverified; C3 judge on 3 replayed sessions still open |
| C4 | M | `merged` is reported only when the GitHub API confirms the merge and main contains the sha | blackbox with mocked GitHub | W5 | **built + merged** (f78bf8aa8; suites ×5, re-run on every merge); live E2B pause unverified |
| C5 | M | Everything a code agent did is greppable from the root tree (commands, outputs, diffs, repo files) | trajectory-grep blackbox | W5 | **built + merged** (f78bf8aa8; suites ×5, re-run on every merge); live E2B pause unverified; C5 `code_repo` document source still open |
| C6 | M | Code agents (Claude Code and Codex) are part of the Rose agent graph: they can list agents, message root and other agents, and grep the tree; root can message them | agents blackbox + live smoke with a real Codex session | L-A2A | open |
| C7 | M | The user can talk to a coding agent directly: open it in the tree, type, and the message reaches the CLI; output streams back. Typed message to first token p50 ≤ 3 s | e2e smoke + latency eval; usability judge comparing direct vs relayed | L-DIRECT | built, not deployed: agents `code-session-direct-chat` (14) + backend `claude-code-direct-chat` (6) blackboxes 5/5 green; `benchmarks/direct_chat_latency.py` p50 0.003 s plumbing (real ws-server) + 0.94 s real Claude Code first token (10 turns). Open: usability judge, live E2B smoke |
| C8 | M | Code-capability benchmarks in `tasks.json` (repo bug fix, feature, refactor, front-end build). The Rose code agent matches the underlying CLI run directly (within ±1 task or 5%), and results reproduce across 3 runs | new `rose-bench` code tasks + parity runner | L-BENCH | eval passing 2026-10-20: 7 `code-bench-*` tasks (hidden-test graders fail the start repo, pass the reference: `code_bench_test.py`, run by the agents `benchmark` blackbox domain). `scripts/run-bench code-parity`, K=3, claude-sonnet-5 via the same OpenRouter gateway: Rose 7/7/7, raw Claude Code 7/7/7, stdev 0, `c8_ok`; 16 Rose INFRA rows (memory-watchdog backend kills) rerun, not counted. Codex parity not run; tasks saturate at 100% |
| C9 | M | Codebase sync integration (like boxes.dev): pick up a local dev checkout, including env files, secrets, symlinks and the dependency setup the cloud needs, so a cloud code session runs it. Secrets are never committed or logged | mac-app/CLI blackbox: fixture repo with symlinked `.env` → cloud session `run.sh` health OK; secret-leak scan | L-SYNC | built: `scripts/rose-sync` + `/api/projects/:id/sync` (client-side encrypted, incremental) → restore into the code session; `project-workspace` blackbox (symlinked `.env` outside the repo, secret-leak scan) passes. Open: Mac app main domain (Linux pre-commit blocks `mac-app/`); live `run.sh` health on the Rose project (PJ4) |
| C10 | M | Bug detection runs on Rose infra: auto-RCA (`slack-auto-rca`) spawns a Rose code agent on the Rose repo instead of a GitHub Actions dispatch, and its result posts back | backend blackbox (signed Slack event → Rose agent created with RCA goal) + live smoke | L-RCA | blackbox `slack-auto-rca` 9/9 cases, 5/5 consecutive runs at e8d253402; live smoke pending deploy (needs owner env) || built b437add6b (blackbox 9/9, 5× green); live smoke after deploy + `SLACK_AUTO_RCA_OWNER_USER_ID` |
| C11 | M | **No timeouts for code agents** (UI ledger row 48). Liveness is heartbeat-only; when activity stops, the session sleeps (E2B pause, resumable per C1) instead of failing. Limits to remove or convert (audit 2026-10-20): `MAX_RUNTIME_S=1800` (`spawn_claude_code_agent/config.py`, enforced in `service.py` loop); `SDK_IDLE_TIMEOUT_S=180` and `SDK_WAIT_TOOL_IDLE_TIMEOUT_S=900` idle kills (idle → pause, not fail); `SDK_POST_RESULT_EXIT_GRACE_S=180`; activity `start_to_close_timeout=50 min` + `maximum_attempts=5` (`handler.py:360`; keep `heartbeat_timeout`); E2B `SANDBOX_TIMEOUT_MS=30 min` (`back-end/src/providers/e2b.ts`; use autoPause instead of kill); Codex `rose-bridge.mjs` poll deadline 900 s; ws-server "Forced exit after timeout" and `CLAUDE_STREAM_IDLE_TIMEOUT_MS` (`e2b-templates/*/ws-server.mjs`). Short control-plane calls (health 5 s, chmod 10 s, verifier ≥ 60 s) stay. Benchmark task timeouts are separate and unchanged | agents blackbox: a session idle past every old limit is paused, not failed, then resumes; structural check that the code-agent activity has no start_to_close/schedule_to_close limit | W5 (with C1) | **built + merged** (f78bf8aa8; suites ×5, re-run on every merge); live E2B pause unverified |
| C13 | M | Branch model: new agents get an isolated worktree and a branch cut from the project's default branch; sub-agents get an isolated worktree and a branch cut from the parent's branch and merge back into it; only "New agent in this branch" shares the parent's worktree/session; every result reports the branch (see `code-agent-persistent-sessions.md` §1b) | agents + backend blackbox: branch names, merge targets, shared-session case | W5 + L-SYNC | **built + merged** (f78bf8aa8; suites ×5, re-run on every merge); live E2B pause unverified |
| C14 | M | Local laptop control, about 90% shared code with cloud (UI ledger row 51). The code-agent tool takes `target: "cloud" \| "local"`, default cloud. Local means the Mac app runs the same `ws-server.mjs` as the E2B template inside a folder the user granted, and relays it to the worker; `claudeCodeLocalSession.ts` already proves this on localhost. Transcript, steering, questions, display, branch model and no timeouts all stay the same. Local also opens a local Terminal window on the Mac, attached to that session. It is offered only to agents started from the Mac app; agents created on the web or PWA get cloud only. If the Mac app is closed or disconnected, a local code agent fails immediately with a clear tool error: no waiting and no silent cloud fallback (this is a disconnect, not a timeout; C11 still applies). Exact error text, shown in the chip's red failure box and returned as the tool error: Mac app closed or disconnected → "Can't run locally: the Rose Mac app on <device name> is closed or disconnected. Open the Rose Mac app and retry, or run this agent in the cloud."; web/PWA-started agent asking for local → "Local runs need an agent started from the Rose Mac app. Start this agent from the Mac app, or run it in the cloud." Folder grants live in the Mac app (`MAC-APP-RELEASE` label). The chip header shows the target; Files and Terminal apps get a This Mac / Cloud switch | mac-app blackbox (grant, relay, local Terminal opens, disconnect → immediate tool error, web-created agent gets cloud only) + agents blackbox (target routing; cloud unchanged); mac-app tests run on macOS | L-LOCAL | **built + merged (4570ecefd)**: agents blackbox `code-agent-local-target` 17/17 (target routing, cloud args unchanged, disconnected/web exact text, create-race 409, folder metadata; 5/5 runs); backend blackbox `local-devices` 12/12 (origin recorded, register first-owner, owner-scoped control/tunnel, per-task HMAC relay channels, exact text at once, 409 no cloud fallback, Rose tools relocated; 5/5 runs); mac-app `local-code-runner` 20/20 under Linux vitest (grants + symlink escape, ws-server spawn args, Terminal osascript, session manager, tunnel mux; 5/5). Not run here: mac-app vitest under its own config/jsdom, Electron wiring and a real Mac end-to-end (macOS only) |
| C12 | M | Code agents talk to the user only through Rose tools inside the sandbox (rows 45–47): `send_message_to_user` (text + `inline_view`, e.g. scorecards), `request_user_approval` (existing ApprovalChip above the query box, labelled with the agent; the answer returns to the CLI as the tool result and the agent blocks until answered), and `display(..., placement: "pinned", options: [{label, description, recommended?}], allow_other)` for questions: pinned above the query box ("<agent> asks", dismiss), answers listed vertically and numbered 1/2/3 (bold label + one-line description), then a numbered "Other…" input; click or press the number to pick, Enter sends Other; the query box is not hijacked. Routing by spawner: a code agent spawned by root pins for the user; one spawned by any other agent sends the question to its parent via A2A, which answers or escalates up the tree, and only root pins; the exchange shows in both transcripts. Prompt rule: never rely on the user reading the raw terminal. The chip's default tab is a parsed Transcript (Claude Code stream-json / Codex `exec --json`); Terminal is tab 2 | agents + FE blackbox; approval round trip blocks then resumes the CLI | L-DIRECT + L-DISPLAY + L-A2A | **done** (b10b038c1; agent-tools + agent-tools-requests ×5); "make me a game" outcome rerun pending |
| C15 | M | **Usage-limit failover** (Andy, 2026-10-20). Detection uses structured signals only: Claude `rate_limit_event` status `rejected` with `resetsAt`; the Codex rate-limit snapshot. The session is checkpointed and paused, exactly that credential gets `rateLimitedUntil` = reset, and the parent gets a retryable error naming the exact retry (`spawn_agent(type='code', code_session_id=…)`). The retry leases the next token of the same provider; with none left it continues on the other provider from the checkpoint (same branch, commits and uncommitted files) with a transcript handoff. Never restarts from scratch | agents blackbox (a fake CLI emits the real limit event mid-task: retry error, credential reported, same-provider retry and provider switch, prior work present) + backend blackbox (token marked until reset, availability, provider switch keeps commit and branch), 5/5 | W5b | **built + merged** (f78bf8aa8; suites ×5, re-run on every merge); live E2B pause unverified; Codex rollout reader has no automated test yet |
| C16 | M | **Adaptive sandbox size** (Andy, 2026-10-20). A code agent can change its own environment size through a `change-environment-size` skill (in-sandbox `rose` CLI/MCP tool plus skill instructions). The instructions say to use it when legitimate work needs more memory or CPU (repeated OOM kills, swap, sustained CPU saturation on builds/tests), and not for a runaway process or leak: kill or garbage-collect that instead. Sizes are E2B templates built per tier (CPU/RAM are fixed per template), so a resize checkpoints the session, starts the new-size sandbox, restores and resumes the same CLI conversation (W5b). The project setting gives the default size. Guardrails: tier cap, rate limit, no ping-pong; downsizing is allowed | backend + agents blackbox with fake E2B: resize request → checkpoint → new-tier sandbox → restore → same branch/files/conversation; runaway guard (the tool reports top memory consumers and refuses without a reason); cap and rate limit; project default size; skill text in prompt-invariants; 5/5 | L-ENVSIZE | running |

## Projects (replaces "folders"/Apps naming)

| ID | Tier | Criterion | Eval (minimum) | Lane | Status |
|----|------|-----------|----------------|------|--------|
| PJ1 | M | Repos and apps are **Projects**. The left bar has a Projects section, Rose first; a settings icon appears on the right of a project row when the bar is expanded or hovered | FE blackbox + recording | L-NAV | open |
| PJ2 | M | Project settings: **default branch** (default `main`), **startup script**, **startup timeout** (default 120 s), **environment files** with managed values (add, delete, search by name/file/description; values encrypted, never logged), **lifecycle** (auto-wake on/off) | backend blackbox (owner-scoped CRUD, encryption at rest, defaults) + FE blackbox | L-SYNC (backend) / L-NAV (UI) | backend built; `projects` blackbox passes (owner scoping, envelopes at rest, defaults, env-file CRUD/search, Agent.projectId). UI open (L-NAV) |
| PJ3 | M | A code session for a project checks out the default branch, writes the managed env files (0600), then runs the startup script with the timeout. A timeout or failure is reported to the agent and the user and doesn't hang the session; it runs on create and on resume after boot | local-sandbox blackbox: fixture project → env files present, script ran, timeout enforced | L-SYNC | built for Claude Code (local + E2B); `project-workspace` blackbox passes (default branch, 0600 env files, startup ok/failed/timeout in the CLI prompt and transcript, resume keeps the workspace). Codex sessions not wired |
| PJ4 | M | The Rose project is seeded with its real setup: startup script `agents/benchmarks/fixtures/projects/rose-startup.sh`; env files `agents/.env`, `back-end/.env`, `agents/.env.benchmark-temporal`, `front-end/.env`, `mac-app/.env`, `research/.env`, imported by codebase sync (C9) from Andy's checkout. A Rose code session reaches a healthy `scripts/run.sh` | live smoke on the Rose project | L-SYNC | seed built: `scripts/rose-sync seed-rose` (fixture startup script + six env files, declared until synced); blackbox passes. Live smoke open: run from Andy's checkout after deploy |

## Integrations: real sync progress and multiple accounts (UI ledger row 78)

Andy: "sub agent for each". There is one lane per integration that syncs today, after a shared core lane. Messenger and Instagram are skipped because nothing syncs yet ("if they sync"). Survey 2026-10-20: no per-account progress model exists, and every writer except Compute hard-codes `accountId: ''`. Copy the `ComputeAccountConnection` and `EmailIntegrationCredential` patterns. All these rows are M.

| ID | Criterion | Eval (minimum) | Lane | Status |
|----|-----------|----------------|------|--------|
| I0 | **Shared core.** A per-account progress model `(userId, provider, accountId) → { pct, done, total, unit, eta_sec, state, startedAt, updatedAt }`, writable by Mac-app uploads and backend jobs while a sync runs. Exposed on `GET /api/integrations`, one entry per account. Generic per-account delete (`DELETE /api/integrations/:provider/accounts/:accountId`) that removes that account's data. Connecting again creates a new account. Indeterminate progress (no total) is reported as `total: null`, not faked. 10k rule: one row per account and O(1) writes per batch | backend blackbox (progress round trip, two accounts per provider, delete one keeps the other, owner scoping) | L-INTEG-CORE | **done** (639e3baf5; integration-accounts 19/19 ×5) |
| I1 | iMessage: total from `chat.db` count; per-batch progress; one account per Mac (device id) | mac-app main tests (mac CI) + backend blackbox | L-INT-IMESSAGE | **built + merged** (87d5c0ec2): one account per Mac (`macDeviceId()`), chat.db COUNT total, 500-row batches with resume; backend 38/38 ×5, Mac 247/247 ×5 on the Linux harness; real Mac run pending |
| I2 | WhatsApp: Baileys `progress` surfaced; multi-account (one auth dir and socket per account) | mac-app main + backend | L-INT-WHATSAPP | **built + merged** (092847a8b): one Baileys auth dir + socket per phone, Baileys pct surfaced with `total: null`, per-phone delete; backend 54/54 ×5, integrations 283/283, Mac 407/407 ×5 on the Linux harness; real Mac + live pairing pending |
| I3 | Gmail: per-address progress using `messagesTotal`; `SYNCING` per address, not per row; incremental save during a full sync | backend blackbox | L-INT-GMAIL | **built + merged** (a22e8a0b4): per-address scanning → saving → synced against `messagesTotal`, batch saves with resume cursor, no double syncs; integration-accounts 40/40 ×5, integrations 272/272 |
| I4 | LinkedIn: honest phases (export requested → waiting → uploading → parsing with counts); multi-account | backend blackbox | L-INT-LINKEDIN | **built + merged** (7a2226bf2): honest phases starting → export_requested → waiting_for_export → uploading (bytes) → parsing (records) → synced/failed; per-account rows + delete; 17/17 ×5, integrations 283/283. **Live export not yet run**: needs the export-agent goal text (UI thread, prompt approval) |
| I5 | Plaid: per-item progress (indeterminate total → counts + state); multi-item already exists | backend blackbox | L-INT-PLAID | **built + merged** (9ab236225): per-Item progress, `total: null` + transaction counts, `waiting_for_plaid`, `needs_reconnect`; integration-accounts 26/26 ×5, plaid 17/17 incl. live sandbox |
| I6 | Browser cookies: account = browser profile (profile detection beyond Chrome); progress from known counts; delete removes the cookie rows | mac-app main + backend | L-INT-COOKIES | **built + merged** (e1e6c5eea): account = `<browser>:<profile>`, all Chromium profiles + Safari, per-profile delete; backend 22/22 ×5, Mac 31/31 ×5 on the Linux harness; better-sqlite3 cases need a real Mac |
| I7 | Passwords and passkeys: fix `BrowserPassword` unique key (add source + profile; migration); per-source account; delete | backend blackbox + migration | L-INT-PASSWORDS | **built + merged** (0b5fb9db7): unique key + source/profile, `<source>:<profile>` accounts, per-account delete, deterministic reader preference; integration-accounts 41/41 ×5, 20 related suites green. The Mac app still collapses duplicate logins across profiles before upload |
| I8 | Telegram: progress from chat-list total; multi-account sessions | mac-app main + backend | L-INT-TELEGRAM | **built + merged** (1d4248d96): one session per Telegram account, chats total, `MessageRecord.sourceAccountId`; backend 24/24 ×5, Mac 351/351 ×5 on the Linux harness; real Mac + live login pending |

## rose_user_ui, Apps, Rose-in-Rose

| ID | Tier | Criterion | Eval (minimum) | Lane | Status |
|----|------|-----------|----------------|------|--------|
| A1 | M | Rose-in-Rose: a code session on the Rose repo runs vite HMR. Andy sees the edited Rose on screen about 1 s after a write. Publish opens a PR; ships only via `/deploy`; dev accounts only | e2e: agent write → preview DOM change ≤ 3 s; non-dev account 403 | L-APPS | **backend built** (L-APPS, see Deploy approvals): `rose-preview` CLI in dev sessions (vite on 5173 in E2B, Rose-repo cloud sessions autostart `front-end/`); `GET /api/claude-code-session/:taskId/preview` + `POST .../publish` (push branch + PR via the C4 GitHub helper, never merges), 403 `ROSE_DEV_ONLY` for non-dev; `code_agent.preview_url`. `code-preview` blackbox 9/9 ×5: real vite on a copy of the Rose front-end, 25 edits over 5 runs: write→DOM p50 224 ms, max 929 ms (first edit of a cold run; budget 3 s), hot update without reload; agents `code_sessions` ×5. Open: live E2B run (proxy WebSockets, first `npm install`), preview sign-in on the preview origin (UI) |
| A2 | N | Lovable-style Apps: "Make me an app", "+ new app", Apps section on the left bar (Rose first). Full-screen app with the floating query box and Popular Goals hidden; live-preview card in the trajectory; History restore; per-user publish URL | FE blackbox + e2e (UI ledger) | L-APPS | **backend built** (L-APPS): `apps` in rose-ui.json (`apps/<slug>/`, `rose` reserved), `GET /api/user-ui/apps` (Rose first for dev accounts with its live preview, then published apps with per-user usercontent URLs), History = `/versions` + activate; user-ui blackbox 20/20 ×5. UI open (UI thread); stable app alias URL not built |
| A3 | N | `rose_user_ui` per user: `root/` changes the whole app, `inline/` renders in the trajectory (version pinned), `tools/` adds root-agent tools whose results render inline; safe mode | W1/W2/W4 suites (passing) + recordings | merged | code merged; recordings pending |
| A4 | N | Code agents get UI instructions, current screenshots and `rose-ui screenshot/record/perf/check` | E2B template test | L-APPS | **built** (43de031b5): rose-ui dev/screenshot/record/perf/check, screenshots/current/, six examples; unit + smoke + blackbox 5× green; live E2B check after template rebuild |
| A5 | M | `display(paths\|urls, caption?)` tool for root, sub-agents and code agents; media posts inline in that agent's trajectory; idempotent per content hash | agents blackbox | L-DISPLAY | **done** (b10b038c1; display 14 cases ×5) — approval at deploy |
| A6 | N | Root browser with world state split by website: agents fork Root's state; logins merge back; you can take over any tab | agents/browser blackbox | L-BROWSER | **built + merged** (d0b6000ba): per-site Root state, fork on prepare-auth, guarded last-writer-wins merge on close, Root browser on the persistent profile, take over any tab; browser-world-state 8 cases ×5. Agents still load the shared profile (per-task profiles need a provider change + live Kernel check) |

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
| U15 | M | Home **is** the root project: the base workspace every agent and code session forks from (repo checkout, env files, startup script). Home shows the root chat; its gear opens that project's settings | L-NAV | open |
| U16 | N | ~~Right bar also gets Files and Terminal apps~~ — **dropped for now** (UI ledger row 58: right bar = Browser, Phone, Integrations, Dark mode; admin Payments, Benchmarks, Feedback). No Files/Terminal/Network/Voice panel backends. The C14 local Terminal *window* on the Mac is kept | — | dropped |
| U17 | M | Panels and drawers open flush against their bar, full height, no gap, margin or floating card (fix the W3 Browser drawer's 12 px inset) | L-NAV | open |
| U18 | N | Popular goal "Make me a website" | L-DEFAULTS | open |

## Performance (added by the parent agent; all M)

| ID | Criterion | Eval |
|----|-----------|------|
| P1 | iPhone web app is fast: cold load LCP ≤ 2.5 s and TTI ≤ 3.5 s on simulated 4G, mid-tier iPhone CPU (4x throttle); warm load ≤ 1 s | Lighthouse mobile + WebKit Playwright iPhone 15 emulation (no device rig exists; results labelled "emulation") |
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
- **L-LOCAL:** local laptop target through the Mac app (C14) (built; real-Mac e2e pending).
- **L-APPS:** Rose-in-Rose and Apps (after W5).
- **L-DISPLAY:** the display tool + in-sandbox Rose tools (done, b10b038c1).
- **L-BROWSER:** root browser and world state (queued; starts when a running lane finishes).
- **L-NAV:** Home, boxes functions, right-bar moves, hover-expand.
- **L-DEFAULTS:** speed and model defaults, popular goals.
- **L-DARK:** dark mode app.
- **L-PHONE:** phone app backend + Mac side (phase 1 done, ffd4d1333; phase 2 agent tap/type tools planned).
- **L-PERF:** mobile performance validation (P1–P6), run last over the merged branch.
- **L-INT-* (I1–I8):** one lane per integration (running); **L-RCA-RETIRE:** remove the GitHub Actions auto-RCA (running).
- **Auditor:** an independent judge that re-checks every row against its evidence before `/deploy`.

## Accountability ledger: every ask in the code thread (audit 2026-10-20)

Status: **done** = merged into `feat/rose-user-ui` with tests; **running** = a lane is building it; **queued** = has an owner but no lane yet; **UI** = UI sister thread; **gap** = has no owner yet (fix listed). Nothing is deployed or pushed (Andy: "don't deploy anything yet").

| # | Ask (Andy's words, paraphrased) | Row | Owner | Status |
|---|---|---|---|---|
| 1 | Code agent persistence; restart from exact last state; failed agent keeps state on retry | C1–C2 | W5 | running |
| 2 | Commit locally when done, merge when sharing state; "merged" only if real | C3–C4 | W5 | running |
| 3 | Grep over code agents' work | C5 | W5 | running |
| 4 | `rose_user_ui` folder in every workspace, per user, publish | A3 | W1 | done (7cdddf5bf) |
| 5 | Instructions + **screenshots of the current UI / a way for the code agent to view them** (`rose-ui screenshot/record/perf/check`) | A4 | L-UIKIT | **done** (L-UIKIT 43de031b5); live E2B pending template rebuild |
| 6 | **Hyper-expressive, high-res, smooth, performant examples** (plan lists 6; only 2 seeded) | A4 | L-UIKIT | **done** (L-UIKIT 43de031b5); live E2B pending template rebuild |
| 7 | `root/` alters the whole app (colors, gifs, dashboards, "a whole OS") | A3 | W2 runtime | done (87d1f3532); recordings pending |
| 8 | `inline/` views in the trajectory | A3 | W1/W2 | done; game flow failing → #24 |
| 9 | Write a tool for root and render its result any way | A3 | W4 | **done** (ed4069172): `code_session` executor in the user's own tools session + side-effecting tools at-most-once via `ToolSideEffect` |
| 10 | "Change my background photo" goal; background fade (now 80%); query box + left bar opaque | U14 / row 34 | W2 + UI | backend README done (5accf4e82); front-end UI |
| 11 | Nub, Join Waitlist white, no wrappers, mic, rose tint | U14 | W3 + UI | merged; Join Waitlist reverted to stock for signed-out visitors by the flag rule (UI thread to confirm) |
| 12 | Browser app follows selected agent; drawer replaces fullscreen, smooth | U14 | W3 | done (legacy fullscreen kept for non-flag accounts) |
| 13 | Root browser always available; agents splice by world state | A6 | L-BROWSER | queued |
| 14 | **"Another app should be sent to the agent working on the demo video"** | — | parent | **gap: no demo-video thread found; asked UI thread to get Andy's answer** |
| 15 | Rose in Rose: sync Rose repo, live HMR preview on screen, Publish = PR | A1 | L-APPS | backend built (L-APPS); UI + live E2B run open |
| 16 | Apps (Lovable-style), "Make me an app", "+ new app", Rose is one app | A2 | L-APPS + UI | backend built (L-APPS); UI open |
| 17 | Recordings of it working | — | UI thread | flow 1 pass; flows 2–3 fail → #24 |
| 18 | Codex tool to talk to other agents in the Rose graph | C6 | L-A2A | done (6d1b49779: rose-agents CLI list/send/grep, exactly-once delivery, spawner routing; 5/5); root-side tool pending A2A-thread merge |
| 19 | Talking to the coding agent directly (is relaying clunky?) | C7 | L-DIRECT | running |
| 20 | Code benchmarks; replicate the underlying CLI's results | C8 | L-BENCH | running |
| 21 | Codebase sync like boxes.dev (secrets, symlinks) | C9 | L-SYNC | running |
| 22 | Bug detection runs on Rose infra | C10 | L-RCA | done (b437add6b); live smoke after deploy |
| 23 | Must-have / nice-to-have split | — | parent | done (this file) |
| 24 | Route coding / look-and-feel asks to a code agent (flows 2–3 fixes) | row 41 / C12 | L-ROUTING | routing done (8d3dd5e28; real replays: flow 2 7/7 code agent vs 2/2 browser before; flow 3 3/3 inline view vs 0/3); end-to-end re-recording pending (UI thread) |
| 25 | Code agents talk to the user only via Rose tools (messages, approvals, scorecards, pinned questions); routing by spawner | C12 | L-DISPLAY + L-A2A | running |
| 26 | Code-agent chips: Transcript / Terminal tabs, direct box, completed summary | rows 44–45 | L-DIRECT (backend) + UI | running + UI |
| 27 | No timeouts for code agents (heartbeat only, pause when idle) | C11 | W5 | running |
| 28 | Branch model (new agent from main; sub-agent from parent; shared only via right-click) | C13 | W5 | running |
| 29 | Local laptop target via the Mac app (local Terminal window, Mac-app-only, exact errors) | C14 | L-LOCAL | built; real-Mac e2e pending |
| 30 | Projects (default branch, startup script + timeout, env files, autowake); Rose project seeded; agents grouped by project | PJ1–PJ4, row 57 | L-SYNC + UI | running + UI |
| 31 | Home button = root project; boxes.dev functions in agents pane; hover-expand; flush drawers; right-bar layout | U1–U4, U15, U17, rows 29–33, 55–58 | UI | UI |
| 32 | Mobile makes sense; query box hugs screen curve; inline images by default | U10–U12 | UI (W6 WIP handed over) | UI |
| 33 | Fast/ultrafast visible on mobile, ultrafast default; rose-flash default model | U5–U6 | UI | UI (front-end defaults; backend API default `rose-1-ultra` kept so other accounts and benchmarks are unchanged) |
| 34 | Dark mode app; youtube/instagram/linkedin/website goals; phone app | U7–U9, U18, rows 52–53 | UI + L-PHONE (backend) | UI; L-PHONE queued |
| 35 | Display HTML + JS (games) | row 54 | UI front-end done (a151a214c) + L-DISPLAY (`text/html`) | done (preview) + running |
| 36 | Feature flag: all new UI only for Andy | row 42 | parent | done (7fbe04b59) |
| 37 | Approvals collected at deploy; don't deploy yet | — | all lanes | in force (memory + every lane prompt) |
| 38 | iPhone web app hella performant, validated (phone harness → WebKit iPhone 15 emulation) | P1–P6 | L-PERF | queued (runs on the merged branch) |
| 39 | Each criterion analysed by its own sub-agent with an eval/judge suite; iterate until met | all rows | lane owners + Auditor | lanes running; **Auditor queued** (re-checks every row against evidence before any deploy) |
| 40 | Recording blockers: decode hang, account pill overlaps | — | parent | done (ac42c75f4, ab8f1bcf8, a151a214c) |
| 41 | One sub-agent per integration: real sync progress + multiple accounts (iMessage, WhatsApp, Gmail, LinkedIn, Plaid, cookies, passwords/passkeys, Telegram; Messenger/Instagram only if they sync) | I0–I8 | L-INTEG-CORE then one lane each | core running; per-integration queued |
| 42 | Sub-agents keep going after interruptions | — | parent | done: all 8 lanes resumed after the 2026-10-20 usage-limit stop |
| 43 | A code agent that breaks on a usage limit resumes on whichever coding agent comes next; the error tells the parent to retry; retries lease a token automatically and continue | C15 | W5b | running |
| 44 | E2B box sizes auto-adapt to the coding agent's demand via a change-environment-size skill; use it when it needs more memory/CPU, not for runaways (garbage-collect instead) | C16 | L-ENVSIZE | running |

Open follow-ups with owners: ~~C10 stuck agent on crash between create and start~~ **done (b33bfed97, fail→pass, 5/5)**; C6 root→code-agent messaging: L-A2A backend done (6d1b49779), root-side tool belongs to the A2A thread's `send_message_to_agent` — wire its address resolver to `send_agent_graph_message` after both branches merge (A2A thread agreed; contract `to, message`, idempotency `workflow_id:tool_call_id`); **flag the backend side of Rose Desktop** — `rose_user_ui` workspace materialization (W1 `workspace.ts`), the code-agent `rose_user_ui` instructions (`codeAgentPrompt.ts`) and the `code`/`spawn_agent` tool descriptions should apply only to Rose Desktop accounts, because a non-flag account can't see published UI (queued: L-FLAG-BE); code agents need a headless browser in the sandbox to actually play-test games (A4 template, L-UIKIT); bench-only `SpawnAgentToolNoGP` description unchanged; C10 crash-between-create-and-start stuck agent (L-TOOLS2 queue); retire `.github/workflows/auto-rca*.yml`; W1: live E2B check that `rose-ui` is on PATH (needs a real E2B sandbox; no deploy); W2 bridge `rose.*` capability calls + write confirmations (UI thread, plus a backend if one is needed).

## Decisions made without asking (for Andy's review at the end)

Per the 2026-10-20 goal ("make intelligent guesses; keep critical ones for review at the end"):

1. **Phone app = your iPhone through macOS iPhone Mirroring**, operated by the Rose Mac app. Phase 1: device state + exclusive control (take control / release); Phase 2: agent tap/type/screenshot tools. *Critical: if "the mobile phone attached" meant something else (AgentPhone SMS number, a cloud device farm), L-PHONE's device layer changes.*
2. **"Another app sent to the agent working on the demo video"**: no demo-video thread or app found on this box. Parked. *Critical: which app, which thread?*
3. **Integrations progress**: `total: null` when unknown (indeterminate bar, never a fake %), `eta_sec: null` when unknown, browser-cookie account = browser profile, Messenger/Instagram skipped because nothing syncs today.
4. **Root → code-agent messaging**: the backend path is done; the root-side tool comes from the A2A thread's `send_message_to_agent` after both branches merge (agreed with that thread).
5. **Backend API default model stays `rose-1-ultra`**; rose-flash + ultrafast are the default *selections* in the front-end (UI thread), so other accounts' API calls and benchmarks don't change.
6. **Join Waitlist for signed-out visitors stays stock** (only Andy's account changes; relayed by the UI thread).
7. **User tools v1 are read-only and run on the worker**; side-effecting tools and the in-code-session executor are queued (L-TOOLS2).
8. **Rose-in-Rose (L-APPS)**: dev accounts = the front-end Rose Desktop list (`utils/roseDevAccess.ts`, pinned by a structural test; `ROSE_DEV_USER_IDS_EXTRA` for test stacks). The preview talks to the backend through vite's `/api` proxy (`VITE_BACKEND_SAME_ORIGIN=true`), so no CORS change. Publish pushes from the session's own checkout and opens a PR against the merge target; it refuses to push the merge target itself.
9. **Apps (L-APPS)** are static bundles in `rose_user_ui/apps/<slug>/`; the publish URL is the immutable usercontent version URL (changes per publish; a stable alias is a follow-up). A built vite app is copied in.

## Deploy approvals (collect at `/deploy`)

- Harness (L-DIRECT, C7/C12): `agents/domains/spawn_claude_code_agent/service.py` (trajectory-injection watched file) monitor keeps a user-held session open, arms exit grace from the sandbox's `pending_turns`, persists transcript batches; `repo.py` `save_code_transcript_batch`; ws-servers (`--include-partial-messages`, user_turn/hand_back/relay_paused, queued_turn_count accounting, thinking/tool ids); A2A `relay_paused` → 409 tool error text (`agentGraphSendService.ts`). Schema: `directTurnSchema` (Zod). No prompt text changed.
- Harness: user tools in root toolset (W4); `display` tool with `placement` (A5); code-agent graph tools (C6); `code_session_id` tool param (C1); code-agent Rose tools + approval blocking (C12); removing code-agent Temporal/sandbox timeouts (C11); code-agent `target` param (C14); root routes coding work to code agents (UI ledger 41).
- Prompt text: code-agent "never rely on the raw terminal" rule (C12).
- Prompt text: code-agent template commit/merge guidance (C3); tool descriptions added by each lane.
- Prompt text (L-ROUTING, UI ledger 41 + flows 2/3): spawn_agent `code` type description and planner `code:` line (coding and Rose-app changes go to code agents; viewable work ships as an inline view shown with `inline_view`); `INLINE_VIEW_DESCRIPTION`; code-agent "Rose app UI" instructions (`codeAgentPrompt.ts`); rose_user_ui README "Something for the user to see or play".
- Schemas: `rose-ui.json` and `tool.json` validation; any new Zod schemas.
- Env and prod: `USERCONTENT_BASE_URL` (separate origin), `USER_UI_TOKEN_SECRET`, E2B template rebuild; C10 `SLACK_AUTO_RCA_OWNER_USER_ID` (required — with `AUTO_RCA_ENABLED=1` already on Render every error card 503s until set), `SLACK_AUTO_RCA_FEEDBACK_USER_IDS`, optional `SLACK_AUTO_RCA_REPO_URL`/`SLACK_AUTO_RCA_SIGNATURE_WINDOW_MINUTES`; migration `20261020170000_slack_auto_rca_incidents`.
- Prompt text: C10 RCA goal/occurrence/feedback text `back-end/src/domains/slack-auto-rca/rcaGoalService.ts` (78 lines).
- C10 follow-ups: ~~retire `.github/workflows/auto-rca*.yml`~~ **done (cfa7e12d4: 5 workflows, prompt file, `scripts/auto-rca-tool`, alert-context route and their tests removed; 60/60 structural gates)**; update `.claude/commands/rca.md` automated-alert section (prompt approval); stuck agent if the backend crashes between agent-row create and workflow start.
- Prompt text (C10): the auto-RCA root goal, occurrence and reviewer-feedback messages, and the RCA response schema in `back-end/src/domains/slack-auto-rca/rcaGoalService.ts`.
- Env and prod (C10, Render): `SLACK_AUTO_RCA_OWNER_USER_ID` (Andy's user id) must be set at deploy, because `AUTO_RCA_ENABLED=1` is already set and error cards then answer 503 until it is; `SLACK_AUTO_RCA_FEEDBACK_USER_IDS` (Slack user ids allowed to steer an RCA); optional `SLACK_AUTO_RCA_REPO_URL` (default `https://github.com/Rose-Ai-Labs/rose`) and `SLACK_AUTO_RCA_SIGNATURE_WINDOW_MINUTES` (default 60). `GITHUB_DISPATCH_TOKEN` is no longer read for auto-RCA. Fly worker cards must post with the same Slack app's bot token (`SLACK_BOT_TOKEN` + `SLACK_ERROR_CHANNEL_ID`); new tables ship in migration `20261020170000_slack_auto_rca_incidents`.
- Projects (L-SYNC): Zod schemas in `domains/projects/types.ts`, `project_id` on agent create and code-session create; ws-server project mode and the startup note at the top of the CLI prompt (prompt text); code-agent transcript `project_startup` line; migration `20261020130000_projects`. No new env vars (reuses `CLAUDE_CREDENTIAL_DECRYPTION_KEY`, `GITHUB_TOKEN`).
- Benchmarks (C8): seven new `code-bench-*` task definitions in `tasks.json` (prompts, hidden-test `static_check`s, 900/1200 s timeouts); the `code_bench_screenshot_judge` method and its judge prompt (`SCREENSHOT_JUDGE_SYSTEM` in `agents/benchmarks/code_bench.py`); the test-only Zod enum value `code_bench_screenshot_judge` in `back-end/src/tests/blackbox/benchmarks.blackbox.ts`. No agent-harness or product prompt changes.
- Local target (C14, L-LOCAL): harness: `target: 'cloud' | 'local'` on `spawn_agent` (both schemas, one-sentence description) and the new `resolve_code_agent_target_activity`; Zod: `target`/`device_id` on claude/codex session create, new `registerDeviceSchema`; prompt text: `buildLocalCodeAgentSystemPrompt` (local-Mac code-agent instructions) and two new user-facing strings not in the C14 spec (`no_folder_granted`, `no_own_credentials` in `providers/localDevices/messages.ts`); migration `20261020200000_local_devices` (LocalDevice table, Agent.originDeviceId); optional env `LOCAL_CODE_RELAY_SECRET` (defaults to BACKEND_API_KEY) and `LOCAL_CODE_RELAY_BASE_URL` (defaults to BACKEND_URL/RENDER_EXTERNAL_URL); E2B codex template rebuild (ROSE_PROJECT_WORKDIR project mode); Mac app release (`MAC-APP-RELEASE` label: new `ws` dependency, code-agent extraResources).

- L-DISPLAY (C12, merged b10b038c1):
  - Prompt text: the `CODE_AGENT_INSTRUCTIONS_VERSION` v4 "Talking to the user" block; the template `CLAUDE.md` "Talking to the user" section (needs an E2B template rebuild); new `agents/tools/prompts/display.py`; MCP tool descriptions in `rose.mjs`.
  - Harness: `display` in `EXECUTE_PHASE_TOOLS`/`TOOL_MODELS`/`TOOL_EXECUTORS`; Claude ws-server `--mcp-config` + `mcp__rose`; Codex `mcp_servers.rose` with `tool_timeout_sec=31536000`.
  - Zod (`domains/agent-tools/types.ts`): display/option/request/message/approval/answer/wait schemas.
  - Env (optional): `AGENT_TOOLS_TOKEN_SECRET`.
- L-INTEG-CORE (I0, merged 639e3baf5):
  - Prisma model `IntegrationSyncProgress` + migration `20261020180000_integration_sync_progress` (RLS policy); Zod `progressWriteSchema`.
  - Three new endpoints, plus additive `accounts`/`accountsByProvider` on `GET /api/integrations`.
  - Legacy, Gmail and Plaid deletes now also remove progress rows.
- L-PHONE (phase 1, merged ffd4d1333):
  - Prisma model `PhoneDevice` + migration `20261020190000_phone_devices` (RLS); Zod `registerPhoneSchema`, `agentPhoneLeaseSchema`, `phoneIdSchema`, `frameQuerySchema`, `streamDemandQuerySchema`.
  - The agent-visible 409 messages (`PHONE_CONTROL_TAKEN` …).
  - A Mac app release (`MAC-APP-RELEASE`), plus a real-Mac run of the phone-mirroring suites, which were only run under a Linux electron stub.
- Harness (verifier RCA, merged 94732110c): `_call_llm_verifier` parses below-1.0 verdicts without the required-key constraint (prompt, schema and strict flag unchanged; RCA case `2026-10-20-verifier-parse-required-every-output-key-on-partial-verdicts`). The game recording flow still needs an outcome rerun.
- User UI realtime (merged 6621f1c20): publish tokens carry `agt` (session agent id); a publish that activates broadcasts `USER_UI_ACTIVE_CHANGED` on `agent:<code agent>` and `agent:<root>`. No Zod change.
- L-UIKIT (A4, merged 43de031b5):
  - E2B template rebuild for both templates (playwright-core 1.64.0 + chromium, ffmpeg, Noto fonts).
  - Code-agent prompt line on `screenshots/current/` + `rose-ui check` before publish (instructions version `code-agent-rose-ui-kit.v5`).
  - Usercontent CSP adds `worker-src blob:`.
  - README moved to `assets/user-ui/seed/README.md`: HSL tokens, "See your work", performance budgets, examples.
  - `.c8rc.json` excludes the browser-side seed examples.
- Mac device identity (merged 071b4acb9): phones, local code devices and iMessage share `macDeviceId()` (salted IOPlatformUUID hash); unreleased, so nothing to migrate.
- Integrations batch (all merged on feat):
  - I1 iMessage: Zod `imessageDeviceAccountSchema`.
  - I8 Telegram: migration `20261020210000_message_record_source_account` (`MessageRecord.sourceAccountId`, nullable, metadata-only); Zod `telegramAccountIdSchema`, `telegramConnectSchema`.
  - I3 Gmail: connect-time sync moves to the job pipeline; the stale `SYNCING` reclaim drops from 1 h to 10 min; Gmail HTTP uses global `fetch`.
  - I5 Plaid and I6 Cookies: no approval items.
  - I2 WhatsApp: migration `20261020230000_whatsapp_contact_source` (`Person.createdBySource`, nullable, metadata-only) so deleting one account also removes the contacts only WhatsApp created; message attribution reuses I8's `MessageRecord.sourceAccountId`. No Zod (manual validation of the E.164 `accountId`), prompt or env changes.
  - I1, I2, I6, I8 need a Mac app release (`MAC-APP-RELEASE`) and a real-Mac run of their suites.
- Display HTML on usercontent (merged 47c77a5e6): new public route `GET /usercontent/display/<agentId>/<sha256>.html` (inline-view CSP, content-addressed, owner-scoped); `file_pointer.usercontent_url` on text/html display items.
- Test infra (merged ff09676a2): blackbox and coverage runners use `victoria_<workspace>` on system Postgres, never the shared `victoria`. Instruction-file edit to approve:
  - `CLAUDE.md` Cloud/Linux Database bullet: "`scripts/run.sh` falls back to it. The backend blackbox and coverage runners use their own `victoria_<workspace>` database on that server (created on demand), never the shared `victoria`."
- Backend asks from the UI thread (merged): `USER_UI_ACTIVE_CHANGED` broadcast; `githubConnected` on Projects (63566611b); `a2a.text` (ea93d584b). No Zod changes.
- W5b (C1–C5, C11, C13, C15; merged f78bf8aa8):
  - Prompt `CODE_AGENT_INSTRUCTIONS_VERSION` = `2026-10-20.code-agent-rose-ui-kit-branch.v6`:
    - persistent-sandbox wording;
    - commit-locally / merge-when-needed / agent-decides lines;
    - branch + merge-target line.
  - Template `CLAUDE.md` persistent-sandbox and branch section (E2B rebuild).
  - Tool schema: `code_session_id` on `SpawnAgentTool`/`SpawnAgentToolNoGP`; "ephemeral" → "persistent" in descriptions and `tools/prompts/spawn_agent.py`.
  - Parent-visible tool-result texts: session block, idle pause, question-to-parent pause, usage-limit retry (cloud and Mac), provider handoff prefix.
  - Harness: removed `MAX_RUNTIME_S`, `SDK_IDLE_TIMEOUT_S`, `SDK_WAIT_TOOL_IDLE_TIMEOUT_S`, the 15-min ws-server linger and the rose-bridge 900 s default; activity `start_to_close` → `CODE_AGENT_ACTIVITY_NO_DEADLINE`; retries unlimited with a 5-attempt self-error cap; idle pause, keepalive, provider fall-over.
  - Zod: claude/codex create `code_session_id`, `lease_owner`, `base_branch`; close `reason`; `codeSessionCheckpointSchema`, `codeTaskUsageLimitSchema`, `credentialAvailabilityQuerySchema` (+`own_only`), `codeAgentsQuerySchema`; `createAgentSchema.share_code_session_with`.
  - Migration `20261020150000_code_sessions`: `CodeSession`, `CodeSessionShare` (RLS); `ClaudeCodeSession` + `codeSessionId`, `codeProvider`, `awaitingParent`; drops the unique constraint on `sandboxId`.
- L-APPS (A1, A2; branch worktree-agent-a1dc54f70d0a4394c):
  - Prompt text: dev-only "Live preview and apps" block in `codeAgentPrompt.ts` (`ROSE_IN_ROSE_INSTRUCTIONS_VERSION` `code-agent-rose-in-rose-apps.v1`; non-dev prompts byte-identical); rose_user_ui README "Apps" section and manifest example.
  - Zod: `apps` in `userUiManifestSchema`; `codePublishSchema`.
  - Harness (watched file, metadata only): `spawn_claude_code_agent/service.py` carries `preview_url` into `code_agent`.
  - New dev-only routes `GET/POST /api/claude-code-session/:taskId/{preview,publish}` and `GET /api/user-ui/apps`; E2B dev sessions get `rose-preview` + `ROSE_PREVIEW_*` env and a detached autostart for the Rose repo. No migration, no prod env, no template rebuild.
- I7 passwords (merged 0b5fb9db7):
  - Migration `20261020220000_browser_password_source_profile_key`: drop `BrowserPassword_userId_origin_username_key`, create unique on `(userId, origin, username, browserSource, browserProfile)`. The old instance's password upload returns 500 during the Render cutover until it drains; Mac retries are idempotent.
  - Agent-visible: credential readers return one login per origin+username (enabled → user-synced → most recently used → most recently synced).
- I4 LinkedIn (merged 7a2226bf2):
  - Zod `linkedinPhaseReportSchema` (agent-reported phases `export_requested`/`waiting_for_export`/`failed`; `error` only with `failed`).
  - Prompt text for `createLinkedInSyncAgentApi`'s goal (front end, UI thread) asking the export agent to report phases and upload with `account_id`.
  - No migration.
- I2 WhatsApp (merged 092847a8b):
  - Migration `20261020230000_whatsapp_contact_source` (`Person.createdBySource TEXT`, so deleting an account removes only the contacts it created).
  - Canonical seed re-publication under the new schema cache key (PG15, normal procedure).
  - Mac app release.
  - No Zod or prompt changes.
- L-RCA-RETIRE (merged cfa7e12d4):
  - CI deletion: `auto-rca*.yml` ×5 and `.github/auto-rca-prompt.txt`.
  - Prompt files:
    - `.claude/commands/rca.md`: the "Automated production-alert mode" section is rewritten for the Slack → Rose RCA agent path.
    - `.claude/commands/deploy.md`: the auto-RCA gate is dropped from the registry text.
  - Deleted tests: `agent-alert-context.blackbox.ts`, `auto-rca-lifecycle.blackbox.test.sh`, `auto-rca-workflow.test.sh`.
  - `scripts/test.sh` loses `--auto-rca-changed-from`.

## Operational follow-ups at deploy (for Andy)

- Redeploy Render and Fly right after the merge. Prod `main` still dispatches `agent-failure` to GitHub; between the merge and both redeploys, failures get no card and no RCA.
- Close or adopt the 77 open draft `auto-rca/*` PRs (#1232–#1561) and delete their branches.
- Remove the GitHub secret `RCA_CLAUDE_CODE_OAUTH_TOKEN` (and revoke the token), and the env var `GITHUB_DISPATCH_REPO` on Render and Fly. Keep `GITHUB_DISPATCH_TOKEN`.
- Set `SLACK_AUTO_RCA_OWNER_USER_ID` on Render (C10; error cards 503 until it is set).
- E2B template rebuild (L-DISPLAY, L-UIKIT and W5b template changes).
- Mac app release (L-PHONE, L-LOCAL, I1, I2, I6, I8) plus a real-Mac run of their suites, which have only run on the Linux electron-stub harness so far.
- Canonical seed re-publication for the new schema cache key (PG15).
- Set `USERCONTENT_BASE_URL` to a separate origin before any user UI goes live.
- A6 root browser (merged d0b6000ba):
  - Migration `20261020224000_browser_world_state`: `BrowserSiteState`, `BrowserSiteFork` (RLS).
  - Zod: `signed_in_sites` on browser close; `openRootBrowserSchema`, `agentIdParamSchema`, `siteParamSchema`.
  - Browser harness: sign-in evidence recorded and sent on close (not LLM-visible).
  - Product behaviour: one extra read and upsert per prepare-auth; one CDP cookie read plus merge per close (6 s budget). Kill switch `BROWSER_WORLD_STATE=off`.
- L-TOOLS2 (merged ed4069172):
  - Zod: `userToolRunRecordSchema`, `userToolCallClaimSchema`, `userToolCallCompleteSchema`, `userToolCallReleaseSchema`, `userToolRunSchema`.
  - Code-agent-facing README text on `side_effects` and `idempotency_key_field`.
  - Harness: the workflow passes the idempotency key; side-effecting user tools are declared to the root agent.
  - Prod env at deploy: Fly `USER_TOOLS_EXECUTOR=code_session`.
