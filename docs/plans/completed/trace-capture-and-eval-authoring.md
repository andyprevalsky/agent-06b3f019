# Trace Capture, World-Model Corpus & Eval-from-Trace

Status: DRAFT — awaiting scope approval
Owner: Andy
Related: `agents/benchmarks/long_horizon.py`, `agents/providers/fast_cache/`,
memory `reference-rosebench-simworld-research`, `reference-rosebench-simworld-chokepoints`

## Goal

Four coupled requirements from the founder:

1. **Permanently save every trace (LLM trajectory).** Spans may stay 7-day;
   the trajectories themselves are gold and must go to durable/cold storage.
2. **Permanently save third-party provider request+response pairs** (LLM,
   browser DOM/screenshots/recordings, Vapi voice recordings, SMS/email,
   Firecrawl, people lookup) — the raw material for a future **world model**
   (ref `github.com/experientiallabs/world-model-harness`, trace-grounded
   `WorldModel.step(action)`).
3. **One standardized full-suite eval**, marked in `CLAUDE.md`, plus a **skill
   that turns a root `agent_id` into an eval fast**: agent_id → initial goal +
   DB fixture (delta off a base image) + success criteria → run → report → add
   to the core suite. May also **generate + host synthetic env** (payment twin,
   Amazon twin, fake-persona phone number, or a whole collection).
4. **Save a DB fixture / environment snapshot alongside each trace** so the run
   is reproducible in the sim.

These map cleanly onto the 3-tier sim-world fidelity model already researched
(Tier 1 personas, Tier 2 trace-grounded services, Tier 3 spec-only cold start).

---

## Current State (audited 2026-07-02)

### What survives permanently today
| Data | Store | Retention | Completeness |
|---|---|---|---|
| Messages (text, role, metadata, filePointer) | Postgres `Message` | ∞ (cascade on agent delete) | text + tool metadata only — **not** full LLM prompt/completion |
| Agent aggregate metrics | Postgres `Agent` | ∞ | counts/tokens only |
| Fast-mode cache (LLM / browser_http / web_fetch responses) | Postgres `FastModeCacheEntry` + Supabase `attachments/fast-mode-cache/` blobs | ∞, but keyed for *replay*, only written when fast-mode/allowlist on | response payloads |
| Benchmark run results (+ merged logs) | `agents/benchmarks/runs/*.json` (gitignored) | ∞ but only when a benchmark runs | task-level pass/fail + transcript |
| Pass ledger | `agents/benchmarks/history/task_durations.jsonl` | ∞ | passes only (skips fast-mode-cache runs) |

### What is ephemeral (the gap)
| Data | Store | Retention |
|---|---|---|
| **Full LLM context dumps** (system prompt + tool schemas + raw completion) `dump_llm_context` | ClickHouse `observability.fly_logs` (prod) / `.llm-dumps/` (dev disk) | **7 days** prod |
| Span/trace timing hierarchy | ClickHouse / Render | 7 days / ~30–90 days |
| **Vapi voice** transcript + `recordingUrl` | structlog only | **discarded** |
| **Steel browser** screenshots / DOM / session recording | `.context/browser-agent-recordings/` (dev only) | **not in prod** |
| SMS/email outbound bodies, delivery | none (send transport removed) | n/a |
| People-search results/ranking | none | n/a |

**Bottom line:** the richest artifact (full LLM request+response per call) exists
via `dump_llm_context` but evaporates after 7 days in prod, and the highest-value
world-model signals (voice recordings, browser DOM/video) are never persisted in
prod. There is no per-run DB fixture snapshot at all.

---

## Design

Reuse, don't reinvent. Two existing systems already do 80% of the plumbing:
- `dump_llm_context` (`agents/helpers/observability.py`) already serializes the
  **full** LLM call (messages, config, tools, response_format, output).
- `fast_cache` (`agents/providers/fast_cache/`) already fingerprints, normalizes,
  strips secrets, and blob-stores third-party request/response pairs to
  Supabase storage.

We add a **durable archival sink** behind both, plus a **fixture snapshotter**,
plus the **eval-authoring skill** on top.

### System context diagram

```
                    ┌──────────────── AGENT RUN (Temporal) ────────────────┐
                    │                                                       │
  LLM call ─────────┤ dump_llm_context ──┐                                  │
  browser/vapi/     │ fast_cache write ──┼──► ArchiveSink (NEW, always-on) ─┼──┐
  firecrawl/people ─┤ provider hooks ────┘        │                         │  │
                    │                              │  writes:                │  │
  agent completion ─┤ FixtureSnapshotter (NEW) ───┼─► base-image + delta     │  │
                    └──────────────────────────────┼─────────────────────────┘  │
                                                    ▼                            ▼
                                     ┌── COLD STORAGE (S3/R2 or Supabase) ──┐
                                     │  trace-archive/<agent_id>/            │
                                     │    trajectory.jsonl   (full LLM calls)│
                                     │    messages.json      (DB transcript) │
                                     │    fixture.sql.gz      (DB delta)     │
                                     │    provider/<span>.json (req+resp)    │
                                     │    media/<span>.{mp4,wav,png,html}    │
                                     │    manifest.json  (index + hashes)    │
                                     └───────────────────────────────────────┘
                                                    │
                          /eval-from-trace <agent_id>│  reads manifest
                                                    ▼
                                     long_horizon_evals.json  (the ONE suite)
```

### Trajectory bundle format (world-model-harness compatible)

`manifest.json` per agent_id indexes an ordered list of steps. Each step is a
`(state, action, observation)` tuple so the corpus drops straight into a
`WorldModel.step(action)` replay buffer:

```jsonc
{
  "agent_id": "…", "root": true, "goal": "…",
  "base_image": "rose-base-2026-07",          // named DB snapshot the fixture extends
  "created_at": "…", "final_status": "COMPLETED",
  "steps": [
    {
      "span_id": "…", "call_site": "execute_loop",
      "state":  { "messages_ref": "trajectory.jsonl#L42", "phase": "execute" },
      "action": { "kind": "TOOL_CALL", "name": "spawn_browser_agent", "arguments": {…} },
      "observation": { "provider": "steel",
                        "request_ref": "provider/steel-abc.json",
                        "response_ref": "provider/steel-abc.json",
                        "media": ["media/steel-abc.mp4","media/steel-abc-dom.html"] }
    }
  ]
}
```

### Requirement 1 — permanent traces

- Add `ArchiveSink` behind `dump_llm_context`: when
  `TRACE_ARCHIVE=1` (prod default on), in addition to ClickHouse, upload the
  full dump to `trace-archive/<agent_id>/trajectory.jsonl` (append per call).
  Reuses `fast_cache/blob_store.py` upload path.
- On agent completion (workflow finalizer, **idempotent** per rule 19), snapshot
  the full `GET /api/agents/:id` messages array → `messages.json`, and write
  `manifest.json`. Idempotency key = `agent_id` + final message count.
- Spans stay 7-day (explicitly out of scope for cold storage).

### Requirement 2 — provider request/response + media corpus

Flip `fast_cache` from replay-only to **always write-through to the archive**
(reads still gated by fast-mode). Add the missing capture at each chokepoint
(verified call sites from memory `simworld-chokepoints`):

| Provider | Call site | Add |
|---|---|---|
| Voice (Vapi) | `agents/domains/call_phone_number/handler.py` → `/api/vapi/call` | backend downloads `recordingUrl` + transcript → `media/` + `provider/` |
| Browser (Steel) | `agents/domains/spawn_browser_agent_v3/` + `/api/browser-session/*` | export Steel session recording + DOM snapshots to durable storage (promote existing dev recorder to prod behind flag) |
| Web scrape | `agents/domains/web_fetch/repo.py` (Firecrawl) | already cached — route to archive |
| People lookup | `back-end .../people/routes.ts` `/api/people/messages/search` | log query + ranked results |
| SMS/Email | `agents/domains/message_person/handler.py` | when send hook lands, log body + delivery |
| LLM | `agents/providers/rose/client.py` | already via `dump_llm_context` |

### Requirement 4 — per-run DB fixture

- `FixtureSnapshotter` (new, `agents/benchmarks/fixtures.py` + backend endpoint):
  given `agent_id` + `user_id`, dump the **delta** of the tables the agent can
  read/act on (User, Person, Message, Integration, BrowserContext, sessions,
  passkeys, credits) relative to a **named base image** → `fixture.sql.gz`.
  This is exactly the `environment.db_fixtures` + `base_images` fields already in
  the `long_horizon` schema — we're now populating them for real instead of
  placeholders.
- Base image = periodic `pg_dump` of the canonical seed (reuse
  `_ensure_grep_frozen_base_snapshot` pattern in `run_benchmark.py`). Fixture =
  base + delta so storage stays small and reproduction = `restore(base) ; apply(delta)`.

### Requirement 3 — the ONE suite + `/eval-from-trace` skill

#### Benchmark unification (the scattered → one problem)

Benchmarks live in **four disconnected places** today, with heavy overlap and no
single source of truth:

| Source | Count | Format | Has runner? | Has evaluators/fixtures? |
|---|---|---|---|---|
| `agents/benchmarks/tasks.json` | 28 | rich (env, timeout, expected tools, verifier) | ✅ `run_benchmark.py` | partial (expected-tool checks) |
| `agents/benchmarks/long_horizon_evals.json` | 8 | eval contract (`environment`+`evaluators`) | ❌ loader only | ✅ (the new schema) |
| `front-end/.../test-prompts-selector/prompts.ts` | 26 | goal text only (dev UI picker) | ❌ | ❌ |
| back-end `*.blackbox.ts` smokes | 3 | TS test fns | ✅ (vitest) | ✅ (assertions) |

**Decision: `tasks.json` becomes THE single canonical catalog**, because it
already has the mature runner (`run_benchmark.py`), rich per-task config, and the
22-task passing history. We *extend its schema* rather than maintain a second
file:

- Fold the `long_horizon` contract into each task as optional fields:
  `environment` (mode/timeout/db_fixtures/base_images/services/secrets/live_targets),
  `evaluators[]` (static_check | single_turn_llm_judge | agentic_llm_judge),
  `source` (origin `agent_id` / smoke fn / test-prompt), `status`
  (`ready` | `incomplete`). `long_horizon.py`'s validator is repurposed to
  validate the extended `tasks.json`; `long_horizon_evals.json` is **deleted**
  (its 8 entries migrate in; the fabricated `gaia-catalog-comparison` is dropped).
- **Front-end test-prompts are fetched from the catalog**, not hand-authored.
  Backend already serves it via `GET /api/benchmarks`; add a `/test-prompts`
  adapter and have `TestPromptsSelector` fetch it, then delete `prompts.ts`
  (see "Downstream impact" below). UI picker and eval suite can no longer drift.
- **Backend smokes register their task id** from the catalog (the 3 E2E smokes
  become `status: ready` catalog entries with `static_check` evaluators pointing
  at their existing assertions), so "smoke tests are evals" is literally true.

Result: one file (`tasks.json`), one runner, one validator, one UI source — the
`/eval-from-trace` skill appends here, and everything else derives from it.

#### Standardized suite (marked in CLAUDE.md)

- Single runner: `agents/benchmarks/run_eval_suite.py` — the *only* full-suite
  entrypoint (thin wrapper over `run_benchmark.py`'s suite selection).
- `CLAUDE.md` gets a top-level **"## Eval Suite"** section that names the one
  catalog (`agents/benchmarks/tasks.json`), the one runner, the `status` field,
  and the current holding set (ready vs incomplete tasks) — so it's unambiguous
  where benchmarks live and how to run them all.
- Backfill: migrate the 8 long-horizon evals + 3 smokes into the catalog; drop
  gaia; mark boxing/jobs/event `incomplete` with explicit fixture/judge TODOs.

**`/eval-from-trace <agent_id>` skill (steps):**
1. Fetch trajectory bundle from cold storage (or reconstruct live if <7d).
2. Derive `prompt` ← root agent `goal`.
3. Derive `environment.db_fixtures` ← `FixtureSnapshotter(agent_id)` delta off
   current base image; `mode` ← synthetic|live from the providers touched.
4. Draft `evaluators[]` — static checks from deterministic end-state (DB rows
   the trajectory wrote), plus an `agentic_llm_judge` seeded with the successful
   trajectory as the reference rubric.
5. **Synthetic env generation (optional, per provider touched):** emit + host a
   twin — payment twin (like AgentCard test-payment page), Amazon twin, a
   fake-number persona whose system prompt is grounded in the real counterpart's
   transcript from the bundle (Tier-1 persona engine + anti-cooperation knobs).
   These are Tier-2 trace-grounded services, not hand-coded HTML.
6. Run via `run_eval_suite.py --only <new-id>`, report pass/fail.
7. On confirm, append the eval to `long_horizon_evals.json` with a `source`
   pointer back to the origin `agent_id`.

---

### Downstream impact & hard constraints (reviewed 2026-07-02)

Changing the canonical catalog ripples into the p99/success scripts, the history
corpus, and the FE. Full consumer map:

**Catalog readers (`tasks.json` / `benchmark_tasks.py`):** loader splats
`BenchmarkTask(**t)` (`benchmark_tasks.py:77`); ~23 call sites read existing
fields (`run_benchmark.py` create/evaluate/tool-count validators at
:500,:1345-1470,:3380-3430; `local.py:60`; `benchmark.blackbox.py` assertions;
`benchmark.md` skill). **Extension is safe iff additive:** new fields
(`environment`, `evaluators`, `source`, `status`) must be **Optional with
defaults** — never rename/remove/require. Zero-dependency modules:
`benchmark_monitor.py`, `context_validator.py`, `results.py`, `realtime_monitor.py`.

**⛔ HARD CONSTRAINT — task `name` is the cross-store primary key. Never rename an
existing task name.** It keys:
- `history/task_durations.jsonl` (`"task"`) → the **success/pass ledger** +
  timeout derivation (`timeout_history.py`: p95×2.25, `get_timeout`,
  `SMOKE_TIMEOUT_CAPS`).
- `history/span_durations.jsonl` (`"benchmark"` + `"span_key"`) → **p99/latency
  baselines + regression detection** (`span_history.py`, `agent_latency.py`).
- `runs/*.json` (`TaskResult.name`) → run comparison (`results.py:compare_runs`).

Renaming orphans 20-30 runs of history (timeout caps reset to floor, p99
baselines lost). So: migration is **additive-only** — every existing name is
preserved verbatim; the 8 long-horizon evals + 3 smokes enter under **new** names
(no history to orphan). `span_key` stability (handler-path refactors orphan
per-span baselines) is a separate pre-existing risk, noted, out of scope here.

**p99 & success clarity (the "connectors and logs" ask):** the CLAUDE.md "## Eval
Suite" section will state explicitly: **success/pass** = `task_durations.jsonl`
per task name (read via `timeout_history.summary()`); **p99/latency** =
`span_durations.jsonl` per `(benchmark, span_key)` (read via
`agent_latency.py` / `span_history.summary()`); **full run record** =
`runs/*.json`. One task name threads all three, so a task is traceable end-to-end.

**FE querybox unification — already half-wired.** Backend `GET /api/benchmarks`
(`back-end/src/domains/benchmarks/routes.ts`, `service.ts` caches `tasks.json` at
startup) already serves the catalog. The hardcoded
`test-prompts-selector/prompts.ts` (42 entries) is a *parallel* list that never
consumed it. Fix: add a `GET /api/benchmarks/test-prompts` adapter (maps
`attachment`→`attachmentUrls[]`, adds optional `description`), have
`TestPromptsSelector` **fetch** it instead of importing `prompts.ts`, then delete
`prompts.ts`. Dev/admin gating stays FE-side (`QueryInput.tsx`); attachment
resolution (`fetchTestPromptFiles` → `/test-assets/*`) is already generic.
A structural test asserts the picker's source == catalog (no drift).

## Resolved decisions (2026-07-02)

1. **Cold storage target: Cloudflare R2, from day one.** Not Supabase-now /
   migrate-later. R2 is S3-API-compatible (so `blob_store.py`'s upload shape is a
   config/endpoint swap, not a rewrite) and has **zero egress fees** — decisive
   because the corpus is large binary media (voice `.wav`, browser `.mp4`/DOM)
   re-read repeatedly for world-model replay/training. Small JSON manifests +
   pointers stay in Postgres for queryability; binaries live in R2. New env:
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET_TRACE_ARCHIVE`, `R2_BUCKET_WORLD_MODEL` — mirror to all prod
   surfaces per CLAUDE.md env policy.
2. **Prod capture: ON by default.** `TRACE_ARCHIVE=1` and always-on provider
   capture ship enabled in prod (no allowlist gate). Recording downloads run
   async post-run so agent latency is unaffected.
3. **No redaction for now — capture everything.** Voice recordings + browser DOM
   stored raw. (Revisit governance later; noted as future work, not a blocker.)
4. **Single entrypoint + full unification** — see "Benchmark unification" below.

## Phasing (each phase independently shippable + verified)

- **P0 — Persist traces:** `ArchiveSink` behind `dump_llm_context` + completion
  snapshot + manifest. Verify: blackbox that runs a cheap agent, asserts
  `trajectory.jsonl` + `manifest.json` land in storage with correct step count.
- **P1 — Fixture snapshotter:** `FixtureSnapshotter` + base image. Verify:
  snapshot an agent, restore base+delta into a scratch DB, assert the agent's
  read rows reappear.
- **P2 — Provider capture:** Vapi recording + Steel DOM/recording to durable
  storage; people-search logging; fast_cache write-through to archive. Verify:
  per-provider blackbox asserting `provider/*.json` + `media/*` exist with hashes.
- **P3 — Suite unification: ✅ SHIPPED 2026-07-02** (branch `andyprevalsky/long-horizon-evals`) — extend `tasks.json` schema additively
  (`environment`, `evaluators`, `source`, `status` — Optional, defaults; existing
  `name`s untouched); migrate the 8 long-horizon evals + 3 smokes in under new
  names; delete `long_horizon_evals.json`; drop gaia; add
  `GET /api/benchmarks/test-prompts` adapter + point `TestPromptsSelector` at it +
  delete `prompts.ts`; add `run_eval_suite.py`; add the "## Eval Suite" section to
  CLAUDE.md (naming catalog + the success-ledger / p99 / run-record stores).
  Verify: repurposed validator over `tasks.json`; suite dry-run; structural test
  asserting FE picker source == catalog; assert no existing task `name` changed
  (history-orphan guard).
- **P4 — `/eval-from-trace` skill:** agent_id → eval → run → append. Verify:
  round-trip a known-good agent_id into an eval and assert it passes; a
  known-bad agent_id produces a failing eval.

## Automated verification (per rule 14)

Every phase ships a blackbox test under `agents/tests/blackbox/` (extend
`benchmark.blackbox.py`) — no manual steps. P0–P2 assert artifacts land in
storage with content hashes; P3 asserts catalog validity; P4 asserts the
agent_id→eval round-trip. Secrets needed: Supabase storage service key (already
in `agents/.env`), Steel/Vapi tokens (already present) — flagged here so the
approved plan runs straight through to PR via `/deploy`.
```
