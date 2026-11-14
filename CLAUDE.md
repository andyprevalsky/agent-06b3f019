# Rose Labs

Rose is an RWLH, a Real World Long Horizon computer that works in the real world over long horizons on the user's behalf; judge every design, UI and harness decision by whether it makes Rose a better RWLH.

CONSTANTLY CHECK IN TO MAKE SURE YOU ARE ONLY COMPLETING THE VALIDATION CRITERIA AND GOAL ASKED OF YOU, PLUS ANY CRITICAL ISSUE IN THE WAY OF COMPLETING THAT WORK AND DEPLOYING IT.

YOU MAY NOT PAUSE EXECUTION TO ASK THE USER ANY OTHER QUESTIONS: pick the recommended default and keep going; leave every approval request for the start of `/deploy`.

Sections: Priorities · Communication · Never · Delegation and waiting · Workspaces · Testing · Benchmarks · Database · Agents and scale · LLM calls · Credentials and environment · Production · Repository · Where else to look. Rule numbers in parentheses are stable IDs cited elsewhere.

## Priorities

- Stay on the assigned goal and its validation criteria, and don't go down rabbit holes.
- Make the smallest change that meets the goal: no speculative abstractions, compatibility shims, unrelated refactors or extra files.
- When an error appears, triage it the way `/deploy` does (`.claude/shared/deploy-failure-policy.md`): fix what your change introduced or your goal targets, hand off an evidenced not-introduced failure as a repair `/goal`, and treat an unattributed one as blocking; "pre-existing", "flaky" and "infrastructure" are never evidence (rules 16, 24).
- Treat each new user message as added acceptance criteria unless it cancels one, and before claiming done validate against the latest combined set, reporting anything unmet or unverified.
- Own "make X work in prod" end to end: check `git log --all` and open PRs for an in-flight fix, then reproduce, fix the root cause and rerun the real gate until it is green (rule 0a).
- Build approval-gated changes (prompts, Zod schemas, harness behavior) now and queue their approvals for the start of `/deploy`; a pending approval blocks only its own action, and infra fixes need none (rule 5).
- Outside `/descend`, never edit a benchmark's definition, pass criteria or timeout yourself: describe the change you would make in your final message and leave the file untouched; `/descend` may apply a cross-reviewed task edit, which its final change review approves before deploying (rule 25).
- Leave a destructive or irreversible action, or spend beyond what was authorized, undone and list it for the user at the end instead of asking mid-run.
- Never stop early because you think you are out of context; the conversation is summarized automatically (rule 0).
- No milestone gain is a signal: if the same blocker survives a checkpoint with no new evidence, change the approach.
- If deploy issues keep recurring on a simple goal, re-scope to a simpler change that touches less existing functionality.
- Persist every fix in the versioned command, setup or doc so a fresh agent reproduces it with the CLI alone; test the documented invocation, give required credentials or human setup an explicit, actionable failure, and register a regression (rule 1b).
- After the user unblocks you, resume the task or `/goal` you were blocked on (rule 0b).

## Communication

- Be concise with the user; they will ask for more.
- Fold messages from other agents into the current conversation; surface only material progress, blockers or requested results.
- Approval and review requests show the key user- and model-visible strings that change, well formatted, plus a plain list of schema or API fields; never code diffs or file pointers.
- Golden-reference review precedes every approval request: a fresh adversarial sub-agent checks grounding per `.claude/shared/approval-format.md`. It reviews only the hunks inside the mandatory user-approval scope (deploy-guard-flagged prompt, agent-behavior and trajectory hunks, Zod schemas, /RCA harness-fix packets); GROUNDED clears those manual gates, and approvals are snapshot-scoped (rules 26, 26a).
- Status cards and scorecards follow `.claude/shared/report-display-format.md`; rebuild every row from live evidence at render time, never from stale data, and cross-check the card against the run's own result before publishing.
- When giving the user an FE link to inspect an agent's run, verify it shows the agent (publish with `python3 scripts/publish_evidence_links.py`).

## Never

- Never add lint or type suppressions (`eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `noqa`, `type: ignore`); fix the cause and remove existing ones in files you touch (rule 22).
- Never run `prisma db push` or `prisma migrate dev` from `back-end/`: its `.env` points at PROD, and a push drops indexes Prisma can't model and once lost prod RLS.
- Never change benchmark tasks, pass criteria, expected tools, loads, timeouts (including tool timeouts), concurrency or production behavior to make a run pass; diagnose and fix the cause, and get approval for any definition change (rule 25).
- Never hide failed attempts, weaken assertions or acceptance rules, or claim a run tested a fix missing from its actual service path.
- Never rename a benchmark task `name`; it keys every history ledger.
- Never inject synthetic user or tool messages or recovery nudges into the planner trajectory, and never add string-matching classifiers to the harness (rules 25a, 25b).
- Never delete lockfiles or change dependency ranges to make an install work, and never reinstall dependencies into a `node_modules` or venv linked from another checkout.
- Never give a foreground Bash command a timeout above 5 minutes; run anything longer in the background and watch it (rule 12).
- Never treat a user pause as a bug's cause; users pause after noticing a problem (rule 11).
- Never `git stash`: the stash ref is shared across all worktrees, so popping can pull another workspace's in-flight work; use `git diff HEAD > .git-wip.patch && git checkout -- .`, then `git apply .git-wip.patch && rm .git-wip.patch` (rule 21).
- Never `pkill` by a pattern that could match a process you did not launch in this session (benchmark controllers and test runners may belong to other workspaces); to stop your own run, TERM exactly its controller PID and let its cleanup run, and surface a stuck run you don't own to the user (rule 27).

## Delegation and waiting

- Delegate independent work to sub-agents, keep the main agent on coordination and the critical path, and give every sub-agent ordered priorities, a deliverable and a time budget, narrowing scope early.
- Sub-agents inherit the parent's verified model, reasoning effort and speed; on boxes.dev read `threads options` and pass `--model`, `--reasoning-effort` and `--speed` explicitly, because omitted flags take the box's saved defaults.
- If a parent setting cannot be verified, fall back to medium effort and the fastest speed (`ultrafast` on boxes.dev); never claim a setting the platform did not confirm.
- Every agent-created thread title starts with `--ai--`; the child sets and verifies it at start.
- Deploy test-repair handoffs follow `.claude/shared/deploy-failure-policy.md` (other devbox, Bugs folder, high effort, standard speed).
- Every background task has an owner who watches it until exit and cleanup: poll every 10 s for the first 60 s (log growth and `ps -p`), then every 60 s, stopping at completion (rules 1, 19).
- A coordinating parent never sleeps more than 15 minutes, wakes on worker results, sends the user the current scorecard every 15 minutes, and does not repeat a verified owner's polling, unchanged reports or nudges.
- User questions and parent discussion never pause workers; stop one only on a user cancel, its own safety boundary or a coordinated reassignment.
- Sub-agents batch routine status and notify the parent only on an actionable milestone, failure or blocker; compute refs and hashes before sending a handoff, never placeholders.
- Report the first authentic infrastructure failure immediately (run, task, attempt, first failing boundary, evidence) and start its RCA without restarting or cancelling healthy work.
- Benchmark and experiment iteration (hypothesis, one self-deduplicating `/RCA` per failure, rerun after verified fixes, batches) follows the one loop in `/descend`.
- Outside `/deploy` and `/descend`, which own their sync points, merge the latest main about hourly with `/sync` through a sub-agent that preserves both sides' intent in conflicts.

## Workspaces

- A `/deploy` from any thread ships the whole devbox; follow `.claude/commands/deploy.md`, and during `/deploy` `.claude/shared/deploy-failure-policy.md` governs failure ownership, repair handoffs and waivers for every rule here.
- Read-only workers reuse an existing checkout without installing dependencies; editing workers get isolated worktrees only when concurrent edits require it, and a lean worktree never substitutes empty history.
- The parent records each child's owned paths, source SHA, processes and expected disk at dispatch, checks shared disk headroom before allocating, and never cleans up another thread's work.
- Before retiring a workspace, preserve its changes in a durable Git ref (a bundle, or a push where allowed), keep unique evidence elsewhere, and verify nothing live uses it; retiring never deletes the thread's history.
- Then remove only owned artifacts, tear down services, databases and provider resources through their supported ownership-aware teardown, and never force-remove dirty, locked, unknown-owner or still-needed paths.

## Testing

- The only accepted non-blocking failures are quarantined tests marked as `.claude/commands/deploy.md` describes.

  **Deploy-only exception:** apply `.claude/shared/deploy-failure-policy.md` to repair ownership and qualified waivers. This exception does not change the rule outside `/deploy`.
- Write the assertion first: designing the test is the main work, untested behavior is assumed broken, and a demo or eyeballing is not proof (rule 2).
- Work is incomplete until a test in a consistently run `/deploy` path asserts the behavior; every bug fix lands its reproduction test there, and where it makes sense add validation criteria to an existing test instead of writing a new one (rule 1).
- Before finalizing a new test, run that test (not its whole suite) five consecutive times with unchanged test code to make sure it isn't flaky, consider whether it would flake under machine load or other conditions, and have it cross-reviewed once for flakiness.
- Follow `/RCA` (`.claude/commands/rca.md`) for every bug: no root cause without a local repro that failed and now passes; for a benchmark failure that repro is an isolated one at the failing boundary, never a whole-benchmark rerun, and when the fix needs an end-to-end check run just that task on the cloud fleet (`scripts/run-bench <task>`), not `--local`; in `/descend` the next batch run is the outcome proof (rules 6, 17).
- Validate credentials and integrations with the existing blackbox test (for example `testSmoke_claudeCodeAnswersQuestion`), extending it if needed, never with ad-hoc curl or scripts (rule 18).
- When testing a new integration, add no fallback paths; they hide whether the primary path works (rule 8).
- When testing agent features, stop a misbehaving test agent first to stop its spend, and read the logs before restarting.
- Coverage thresholds (`back-end/.c8rc.json`, `front-end/vitest.config.ts`, `mac-app/vitest.config.ts`, `agents/pyproject.toml`) only ratchet up.
- Testing guide, including Blacksmith and CI: `docs/testing.md`; `bash scripts/test.sh --no-smoke [repo] [domain]` runs offline tests and `--list` lists domains.
- `python3 scripts/run-deploy-structural-gates.py [--max-workers N]` runs the deploy structural registry; activate `agents/venv` first.
- `python3 scripts/select_affected_tests.py` lists the tests a change reaches; when a test reaches code dynamically, add an `edges` entry to `scripts/test-map/edges.json` or name the path literally.
- Validate incrementally: as each coherent change becomes testable, run its affected checks (cheap format/lint/type/focused first, then the affected full gates) against a recorded source snapshot while independent work continues; this adds no gate and does not replace final `/deploy` validation.
- Staged deploy validation follows `docs/deploy-test-cycle.md`: Format, ESLint, TypeScript and application structural checks always run in the quick phase; other categories run when selected.
- Focused reruns are repair evidence only: Coverage thresholds inside a selected full gate remain unchanged, and a focused subset cannot masquerade as a full coverage pass.
- Activate `agents/venv` (`source venv/bin/activate`) before agent tests or gate runners; an absolute venv path leaves child `python3` on the wrong interpreter.

## Benchmarks

- `scripts/run-bench` is the one supported entrypoint for benchmarks; invoke the `/benchmark` skill (runbook, scorecard contract via `scripts/run-bench report-format`) before any benchmark, fleet or cloudbench work.
- Quick use: `scripts/run-bench list`, `scripts/run-bench <task> --wait`, `scripts/run-bench <task> -k K --concurrency N`.
- `agents/benchmarks/tasks.json` (merged with `polar_tasks.json` by the loader) is the canonical catalog; ordinary blackbox and vitest tests do not go there.
- /deploy runs at most 20 benchmarks chosen by `agents/benchmarks/select_predeploy_benches.py`; tag a task `smoke` only for must-run harness plumbing, and never adjust evaluators or tags to force selection.
- Every ready task resolves to a deploy category (`deploy_category`, or a tag with the same name) or opts out with `deploy_category: "none"`; catalog validation fails otherwise.
- A run stops when confirmed infra failures reach 5% of the original scheduled total (`20 * infra_failed_jobs >= scheduled_total`, 30 of 600), never of completed attempts; unknown or cancelled jobs without infra evidence don't count, stop by TERMing the exact owned controller, and an explicit user threshold overrides.
- Every run of code merged to main, wherever it ran (Hub, controller, other checkout), lands in `agents/benchmarks/history/task_attempts.jsonl` (passes also in `task_durations.jsonl`); a branch commits only each task's latest run via `scripts/deploy ledger`, failures of unmerged code never land on main, and main rows are append-only.
- Never block the next experiment on a full `/deploy` (about 3 hours); run only the checks its changed dependencies need.
- After agent-harness changes, measure with `scripts/run-bench eval`.
- WMH model: restore with `python -m benchmarks.wmh_build_cache pull` from `agents/`, rebuild only on user request, and publish with `bash scripts/run-bench-cloud --build-wmh` (`.claude/skills/instantiate-whm/SKILL.md` §6).

**`test-mass-agent-run-0` is indefinitely quarantined from all future deploys (explicit user instruction, 2026-11-10), via its `deploy_quarantine` catalog marker. Never repair its cache or re-record it to unblock `/deploy`; retain its implementation and historical failures. For explicitly requested manual DEMO-cached benchmarks, cache repairs remain restricted to keys main never reads:** find each failing `cache_key` in `.llm-dumps/<agent_id>/` from a strict `scripts/run-bench --local <task>` replay and `POST /api/fast-cache/set` a branch-key row (backing up anything it replaces); never rewrite rows main replays (lookup can be positional), and never map outputs by goal text, because `for_each` children share one goal (PR1682 broke main's smoke this way on 2026-11-09).

## Database

- Every `schema.prisma` change ships `back-end/prisma/migrations/<timestamp>_<name>/migration.sql`; local `db push` hides a missing migration and prod `migrate deploy` then fails (recipe: `back-end/CLAUDE.md`).
- A schema change needs a republished canonical PG15 seed fixture; never publish a coverage database, never replace the reviewed WhatsApp history with a prod cold sync, and verify a restore and read-back first.
- RLS is enabled on every table; new tables need policies.
- Realtime events are explicit HTTP broadcasts (`createMessage()` INSERT, `updateAgentStatus()` UPDATE); message types live in `front-end/src/lib/realtime-types.ts`.
- Ad-hoc queries: `npx tsx back-end/scripts/query-db.ts` (it targets PROD).
- Linux devboxes use system PostgreSQL at localhost:5432 (`postgres`/`postgres`); never point tests or ad-hoc stacks at the shared `victoria` database.

## Agents and scale

- Temporal activities are at-least-once: check for an existing result or use an idempotency key before every side effect (rule 20).
- Design for 10,000 concurrent agents: no per-user or per-root fan-in, unbounded polling, N+1 queries or O(agents) hot-path work; keep per-agent isolation (`agent:<id>`) and state the 10k behavior in the PR (rule 28).
- Workers don't hot-reload and old agents hit nondeterminism after code changes: restart the worker and create a fresh agent; Temporal and tool patterns are in `agents/CLAUDE.md`.

## LLM calls

- Rose completions run in-process (claudeAuth, then the pool waterfall); clients are `back-end/src/providers/rose/` and `agents/providers/rose/`, pools in `pools.ts` / `pools.py`, details in `docs/internal/rose-completions.md`.
- Scripts, replays and judges call LLMs through Rose: Python `fetch_compute_token_activity` + `RoseClient().complete(pool=..., call_site=...)` (release the lease), TS `createStreamingCompletion` with `fetchComputeTokenForUser`.
- Missing or exhausted local GPT/Anthropic keys are not blockers; use leased tokens and record `actual_model` and `pool_name` for every call, since a fall-through to another model invalidates a model comparison.
- Rose client or waterfall edits run `python scripts/run_blackbox_tests.py rose rose-browser-use llm` from `agents/`; never raise the 590/90/120 browser budgets.
- Any Temporal activity wrapper that calls an LLM allows at least 60 seconds.
- LLM call sites, claudeAuth flow and `context_gates`: `docs/internal/llm-call-map.md`.

## Credentials and environment

- Dev login: phone `+19729777432`, OTP `181818`; Andy's real user ID is `1f85ff25-6e29-4c1b-8739-f917bd101a30`; Supabase project `https://kzlurqihzaolhzsbkctf.supabase.co`.
- Read `BACKEND_API_KEY` from `agents/.env` / `back-end/.env`; load env files with python-dotenv, never `source` (`agents/.env` leaks a token fragment when sourced).
- Already-set environment variables beat `.env`; when config is wrong despite a correct `.env`, look for an injected variable first.
- Outside `run.sh`, export the same unique `TEMPORAL_TASK_QUEUE=navi-agent-tasks-<unique>` for backend and worker.
- On a Linux devbox without `.cloud-env`, run `bash scripts/cloud-init.sh`; `agents/venv` uses Python 3.11, and keep `TMPDIR` outside the checkout.
- `mac-app/` is macOS only: never install, run, test or commit it on Linux.
- If a test fails on an invalid GPT or Claude auth token, retry with the local token or refetch it from the prod database before escalating.
- GitHub writes acting as Andy use `GITHUB_TOKEN`; a rate-limited read-only call uses `python3 scripts/github_token_pool.py pick`, never for writes.
- A 404 from any pool member other than `GITHUB_TOKEN` (machine accounts, the `rose-labs-agents` App, `GITHUB_DISPATCH_TOKEN`) is not authoritative; retry with `GITHUB_TOKEN`.
- On boxes.dev the `gh` wrapper ignores `GH_TOKEN`; pass a picked token to `/opt/devbox-tools/gh/current/bin/gh` or curl.
- Env-var and credential management is fully autonomous, rotations included, on Render, Fly, Vercel, Supabase and the Rose project env files on the Rose app: verify the target service, key precedence and consumers first, stage, validate and roll back on regression.
- Store every new value in every location (local `.env`, production surfaces, boxes managed env with `dvb-onbox env set ... --value-stdin`, Rose project env files), sending values from a script and never on argv; commands in `docs/internal/prod-env-vars.md`.
- Read Render env vars only with `cd back-end && npx tsx scripts/render-env.ts`; a raw `limit=100` request truncates.

## Production

- Production https://roselabs.ai; backend https://api.roselabs.ai (Render service `Navi`, also https://navi-j9a9.onrender.com); API docs https://docs.roselabs.ai.
- Index 01: webhook `POST https://api.roselabs.ai/api/index01/webhook` or MCP `https://api.roselabs.ai/mcp` (Bearer Rose API key; transcript becomes a plan-mode rose-1-ultra agent, audio archived as `index01-recording_*`).
- Prod logs, Render IDs and `cd back-end && npx tsx scripts/prod-health.ts`: `docs/internal/prod-logs.md`.
- Mac releases auto-tag on main merges that change the shipped Mac surface; a `MAC-APP-RELEASE` label or a pushed `vX.Y.Z` tag forces one.

## Repository

- Layout: `front-end/` React+Vite (Vercel), `back-end/` Express+Prisma (Render), `agents/` Python Temporal workers (Fly.io), `research/gepa/` offline, `mac-app/` Electron (macOS), `docs/` Mintlify.
- Entry points: `front-end/src/App.tsx`, `back-end/src/server.ts`, `agents/worker.py`, `agents/workflows/agent_workflow.py`; `back-end/prisma/schema.prisma` is the database source of truth.
- Backend auth middleware lives in `back-end/src/providers/auth.ts` and `hybridAuth.ts`; there is no `src/middleware/`.
- Reference harnesses are read-only: vendored `claude-code-src/` (lift its prompt and loop patterns liberally) and gitignored `openclaw/`, `hermes-agent/`, `codex/`, `prime-agent/`, `kimi-code/`, `openworker/` (restore with `bash scripts/sync-reference-repos.sh`).
- Plans live in `docs/plans/active/` and move to `completed/` when shipped; read completed plans that touched a file before modifying it, and give every plan automated verification (rule 15).
- Before writing feature code, include a diagram of how the change fits the system (rule 10).
- Don't truncate context flows; truncate only to fit UI, and make bounded previews explicit with pagination for the rest (rule 13).
- Local logs: `agents/navi-worker-log.txt`, `back-end/backend-logs.log`, `front-end/frontend-logs.log`, `mac-app/mac-app-{console,ipc}-logs.log`.
- For a slow, stalled or failed agent, run `agent_latency.py`, `agent_logs.py --tree --diagnostics` and `agent_cache.py` on its ID in parallel (`agents/benchmarks`, venv active).

## Where else to look

- Before editing files under `front-end/`, `back-end/` or `agents/`, read that directory's `CLAUDE.md` (Codex: the `AGENTS.md` beside it).
- Skills: `/deploy`, `/RCA`, `/descend`, `/benchmark` and the rest under `.claude/commands/` and `.claude/skills/`.
- Setup on Andy's Mac: `docs/setup-mac.md`; Linux devboxes: `bash scripts/cloud-init.sh` and `docs/testing.md`.
- Benchmark catalog, ledgers and log review: `agents/benchmarks/README.md`.
- Planner memory: `docs/internal/planner-memory.md`; JEV research: `scripts/jev_progress/README.txt` (never commit production traces or credentials).
