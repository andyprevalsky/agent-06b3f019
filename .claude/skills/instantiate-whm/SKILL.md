---
name: instantiate-whm
description: Instantiate a World Model Harness (WMH) simulation for a given long-horizon trajectory (for example the $5M fundraiser) — ground the world in the acting user's real data, calibrate every outcome distribution from research, insert them as reference examples, run the trajectory against the native WMH, and report cache/DEMO rates, progress and the FE link. Use when the user asks to simulate a trajectory, calibrate WMH probabilities, or "instantiate the whm/wmh".
---

# instantiate-whm — simulate a trajectory under the World Model Harness

A WMH run replaces the real world behind every environment-boundary tool (browser,
email, SMS, explore, Claude Code, payments) with a native world model that
predicts an outcome distribution for each action and samples one. The agent
under test is unchanged. This skill encodes how to make that world realistic and
how to run it end to end. Learned on the `raise-5m-rose-labs-brex` fundraiser,
October 2026.

## Non-negotiables

1. **Every probability is grounded in research.** Each outcome distribution
   must cite its basis: published studies or platform data (with URL and year),
   or a documented measurement you ran (sample size, date, method). Model or
   agent intuition is not a source. If no data exists, either measure it (for
   example, sample N real websites with a browser) or leave that action out so
   the world model falls back to its archive-grounded retrieval. Never ship an
   unsourced number, and label weak sources (vendor data, heuristics) as weak.
   `benchmarks/wmh_context_insertion.py` rejects examples without sources.
2. **Examples, not enforcement.** Researched distributions are inserted as a
   reference section (`structured.outcome_distribution_examples` plus one
   scratchpad note); the world model reasons from them about the current state.
   Do not force outcomes or probabilities in the runner.
3. **Per-run overrides only.** Never edit the catalog task, its prompt, its
   evaluators or its timeout to make a trajectory progress (CLAUDE.md rule 25).
   World state goes through `--wmh-initial-state-file`.
4. **Report after every run**: outcome, WMH provider prompt-cache rate, DEMO
   cache rate, committed world steps, a short narrative, trajectory completion
   (%) against the previous runs, and a verified FE link. Then ask the user the
   next decisions as multiple-choice questions.
5. Do not deploy or merge unless the user asks.

## 1. Define the trajectory

- Find the catalog task (`agents/benchmarks/tasks.json`) and its
  `wmh_initial_state` (the seed world: `structured` + `scratchpad`).
- Write the stage ladder that defines completion, e.g. research → outreach →
  replies → meetings → commitments → signing → wires → goal met. Each run's
  completion % is the fraction of stages reached (partial stages count partly).
- Enumerate the actions the trajectory needs. Past runs list them exactly:
  `scripts/session-outcomes.py <wmh root> <session>` prints every committed
  world step with its tool and selected outcome.

## 2. Ground the world in the user's real data

- The acting user's data is keyed by the **auth identity `User.userId`**, not
  `User.id`. Querying the wrong one made a connected user (549 contacts, 8
  data sources) look empty. For the fundraiser persona Tamy, use
  `live_fixtures.TAMY_IDENTITY_USER_ID`.
- Check the frozen fixture (`SEED_REMOTE_DATABASE_URL`) and, read-only, prod:
  `Integration` (connected sources and last successful sync), `Person` (the
  network tab), `MessageRecord` (joined through `Person`). Prod access:
  `back-end/.env` `DIRECT_URL` with the `pgbouncer` parameter stripped, inside
  `BEGIN READ ONLY`. Never print credentials.
- The network tab is built only from connected sources (Gmail, email,
  LinkedIn, WhatsApp, Telegram, Mac-app iMessage) or a VCF import; nothing
  backfills it. Whatever is absent is simulated, and the starting state must
  say so without inventing prior correspondence, interest or money.
- Small, session-constant context (a network up to ~15k tokens) can ride in
  the seed state: it lands in the cached system evidence (section 5).

## 3. Calibrate outcome distributions from research

For each action write the full distribution (outcomes summing to 1), a typical
duration and its sources. Evidence order:

1. **Rose's own tool outcomes** (browser navigation, explores, Claude Code):
   the native world model already retrieves real archived transitions for these;
   only add an example when you have measured frequencies from the archive.
2. **External human or institutional behavior** (investors, contacts, banks):
   published research. Starting points that were verified for fundraising:
   Gornall & Strebulaev (80k cold VC emails: 6.5% reply, 4.3% interested);
   Gompers et al. NBER 2016 (per closed deal: 34 met → 11 partner → 4.6
   diligence → 1.5 term sheets → 1 close; ~90% of closed deals via networks);
   DocSend (successful seeds: ~66 investors contacted, ~38 meetings, ≤12
   weeks); Carta (lead ≈ 60% of the round); Validity (email bounce 1.5%);
   DocuSign FY2025 (76% signed within 24 h); FRB/ILPA (wire and capital-call timing).
3. **A measurement you run** when nothing is published (e.g. sample seed-fund
   websites for intake forms vs. emails). Record n, date and method as the source.

Delegate the literature search to a research subagent with an explicit output
contract (table per action, sources, confidence). Present the result to the
user with research vs. measurement vs. weak clearly labeled, and let them adjust
it in the distribution editor: copy `assets/distribution-editor.html`, replace
its `ACTIONS` array, preview and publish it with the boxes-inline-visualizations
workflow (± one percentage point, others rebalance proportionally, Copy exports
the edits). Sanity-check the whole funnel: research says ~250 cold pitches yield
~5 meetings and well under one commitment; successful seeds need warm intros.

## 4. Insert the examples

```bash
cd agents && source venv/bin/activate
python -m benchmarks.wmh_context_insertion --task <catalog task> \
  --examples examples.json --out run-state.json
```

`examples.json` is a list of `{action, outcomes: [{outcome, probability}],
sources[, applies_when, typical_time]}`. Validation enforces sources, sums and
one example per action. Keep the file and the run-state with the run's evidence.

## 5. Provider, cache and infrastructure facts

- **Model route.** The WMH pool `rose-wmh-gpt61` tries the Azure Foundry
  `gpt-6.1-sol` deployment first, then OpenRouter's same model. Before a run,
  check OpenRouter credit (`GET https://openrouter.ai/api/v1/credits`); on
  2026-10-10 it ran out mid-run (HTTP 402 on every step). Local
  `agents/.env`/`back-end/.env` need the Render `AZURE_FOUNDRY_*` values.
- **Prompt caching** (GPT-5.6+ incl. `gpt-6.1-sol`, measured 2026-10-12). The
  cache is read and written only at **breakpoints**. In the default implicit mode
  the only one is the end of the latest message, so a growing history never
  matches and almost the whole prompt is billed as a cache write (1.25×; reads
  are 0.05×). Run 7 wrote 4.40M of 4.64M input tokens: 1.19× the cost of no
  caching. Rose marks a GPT-5.6+ `prompt_cache_breakpoint` after every completed
  user message and at caller `cache_control` markers, on Foundry and the OpenAI API
  key route (implicit mode stays on; prompts are unchanged), and each world's
  evidence goes out as one **append-only stream** shared by all its agents (`benchmarks/wmh_wire_stream.py`):
  task, world baseline, completed history batches, world changes as JSON Patch
  since the agent's last call, and reference examples sent once by id, each a
  breakpoint. A final per-call message carries the example ids, tools and
  candidate. Every rendering must fold back to the exact canonical evidence or
  the call keeps the canonical layout, so no evidence is lost. Replay keys,
  outcome checks and records keep using the canonical evidence. A long-lived
  agent reaches 90–98% cached (live replay of run 8: 60% overall, 0.52× cost).
  `WMH_WIRE_STREAM=0` restores the canonical layout for a diagnostic. Report
  reads, writes and cost per call (`scripts/measure.py`), not just the hit rate.
  Compare layouts on recorded requests with `scripts/layout-ab.py`.
  `scripts/cache-sim/` replays recorded requests through the measured GPT-5.6+
  cache rule (validated within 6 tokens per call on run 10): `marking.py`
  compares marking patterns over `.llm-dumps`, `replay_world.py` replays
  recorded WMH runs through the world stream (run from `agents/` with `PYTHONPATH=.:<that dir>`).
- **Devbox memory.** A cold native load peaks near 40 GB and takes 13–25 min.
  Run it in its own systemd scope (`MemoryHigh` ≤ 11G, swap ≥ 40 GB) so the
  devbox OOM watcher spares it; keep `MemAvailable` above ~1.1 GB. Serve the WMH
  externally: `run.sh`'s 600 s readiness bound is shorter than the load.
  Stop it by TERM to the exact owner PID only.
- **World clock** (policy `rose-outcome-distribution-v3`, the scripts' default):
  one clock per world starting at the seed's `as_of_utc`, which every seeded
  world must pin (ISO UTC). Simulated agents see that world date in their
  planner prompt and `wait_for`, never today's wall-clock date. Each action runs at
  its agent's world time and every outcome states `elapsed_ms`; later results
  go into `structured.scheduled_events` with `available_at_ms` and stay hidden
  from earlier actions. `wait_for` in simulate mode waits on the shared clock
  (`agents/benchmarks/wmh_world_clock.py`): an agent resumes once every other
  agent has passed its deadline, and the clock jumps when all agents wait.
  Agents register at start and finish before signalling their parent.
  Inspect it at `GET /world_models/<name>/scopes/<root agent>/clock`.
- **Native concurrency** (already in code): conflicted predictions take the
  commit turn oldest-first; predictions that only add new records merge
  without re-predicting; there is no per-operation deadline (a Temporal retry
  rejoins); cut-off outputs recover at a larger limit; the tree-stall detector
  counts in-flight WMH predictions as activity.

## 6. Run

```bash
.claude/skills/instantiate-whm/scripts/run-trajectory.sh --task <task> --timeout 3600 \
  --wmh-root <native model root> --state-file run-state.json --out <evidence dir>
```

It refuses a dirty tree or busy ports, starts the WMH in a scope, waits for
health, runs the unchanged task with the per-run state, saves the history-ledger
patch, retires the WMH by exact owner PID and records `run.env`. Launch it
detached and poll (`scripts/progress.sh <evidence dir>`) every 10 s for the
first minute, then every 60 s, checking liveness each time (CLAUDE.md rule 19).

Failure signatures seen: `tree stalled … silent` (stall detector; fixed by
counting WMH activity), `402` from OpenRouter (credit), `Unterminated string`
with `finish=length` (output cut-off; recovered), a queue of ~1 commit per
1–2 min during wide fan-out (every commit invalidated the rest; fixed by
record merging), and `Server disconnected` on bridge calls (keep-alive race; fixed).

## 7. Validate the calibration

Before a long run, replay exact recorded requests with and without the examples:

```bash
cd agents && source venv/bin/activate && set -a && source .env && set +a
PYTHONPATH=. python ../.claude/skills/instantiate-whm/scripts/calibration-replay.py \
  --wmh-root <root> --session <session id> --record <prefix> [--record ...] \
  --examples examples.json --out replay.json
```

Pick records whose original distributions were skewed (for example, a route
search that assigned most mass to "no route"). Compare the recorded, control
and treatment distributions against the examples; the treatment should move
toward the researched rates where the state supports it, and stay put where
the state contradicts them.

## 8. Report and iterate

- Metrics: `python3 scripts/measure.py --session-dir <root>/native-predictions/<session> <wmh-serve.log>`.
- Committed steps: `scripts/session-outcomes.py <root> <session>`.
- FE link: `python scripts/publish_evidence_links.py --run-json <run.json> --agent-id <root agent>`
  with the agents env loaded; cite only links it verified in a fresh browser.
- Then ask the user multiple-choice questions for the next run (rates,
  window, fixes), with a recommended option first.
