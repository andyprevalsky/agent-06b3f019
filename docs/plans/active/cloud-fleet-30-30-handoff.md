# Cloud fleet 30/30 — handoff (for Codex)

**Branch:** `andyprevalsky/pass-predeploy-benchmarks-3`  **HEAD:** `e9c6f6147` (clean tree)
**Worktree:** `/Users/andyprevalsky/conductor/workspaces/navi-whisper-lux-v2/minsk`

## THE GOAL (definition of done)

Run the **`daily` benchmark group (30 unique tasks)** fully concurrently in the
isolated Fly cloud fleet such that:

1. **All 30 tasks run and complete with a real `pass` or `fail`** — no `NORESULT`,
   no whole-batch aborts, and **zero failures caused by infra** (rate limits, port
   collisions, boxes stopping, barrier stalls, launch deaths, etc.). Infra losses
   must be driven to **0/30 excluded**.
2. **Total wall-clock ≈ the single slowest task** (perfectly parallel + isolated),
   NOT the sum. Drive the "ready time" (provision → all boxes at the start barrier)
   as low as **optimal / physically possible** (currently ~10–15 min). **MUST stay
   on Fly** — the fleet exists to replicate **prod** behavior, and prod runs on
   Fly (`navi-whisper-lux`). Do NOT move to a different substrate to go faster;
   optimize the Fly path (pooling, fewer/parallel API calls, warm state).
3. Then produce **two artifacts**:
   - **(a) Report card**: per-task pass/fail + the pass/fail rate + total wall-clock.
   - **(b) LLM usage by provider AND sub-model**, summed across the whole run's
     agent tree: **Codex token, Claude token (OAuth), GPT API key, Anthropic API
     key, OpenRouter model 1, OpenRouter model 2** — with each provider's
     sub-models broken out (calls / input tok / output tok / cost).
     **Perplexity is never used — do not include it.**

## WHERE IT STANDS (what's built + validated)

The launch architecture was rebuilt to remove Fly Machines-API rate-limit
saturation. Committed + working on `e9c6f6147`:

- **Boot-launch** (`scripts/cloudbench-boot.sh` + the `CLOUDBENCH_BOOT_LAUNCH` branch
  in `scripts/run-bench-cloud`, default on in `run-bench-fleet`): the controller
  injects the boot script via `flyctl machine update --file-local`, sets per-run
  params as machine `--env`, sets the boot script as `--command`, then `machine
  start`. The box auto-runs the driver on boot with **ZERO launch SSH** (the old
  ~7-ssh/box burst that killed drivers is gone). Validated end-to-end: box boots →
  `fetch-ref` checks out the ref (token via `CLOUDBENCH_GITHUB_TOKEN_B64`) → driver
  runs git_sync + full prod-data sync + stack startup.
- **Data-plane status polling**: on-box `python3 -m http.server --directory /data`
  on `:8011`; controller reads `bench.log` over `flyctl proxy` (WireGuard data
  plane — **no Machines-API cost**), so N boxes polling can't saturate the limit.
- **Tolerant barrier** (`release_start_barrier` in `run-bench-fleet`): excludes a
  box that fails before the barrier (infra, not a verdict), releases the ready set,
  fails only if all die. Plus **data-plane staleness exclusion** (paused during the
  barrier-wait so a ready box isn't wrongly killed) + **per-box barrier timeout**.
- Seed-SIGSEGV retry (`scripts/run.sh`), clone stagger + exponential backoff,
  stack-death-cause capture. **59 regression tests**:
  `agents/benchmarks/cloudbench_dependency_sync_test.py` (all green — keep green).

## THE OPEN BUGS (what's blocking 30/30) — RCA these

Last full run (`e9c6f6147`): 16/30 reached the barrier, **14 excluded**, released,
then **only 2 produced results; 14 boxes STOPPED post-release without a DONE
marker** and their launchers hung polling for a DONE that never comes.

1. **Post-release boxes stop without DONE (PRIMARY BUG).** All 14 "running" boxes'
   status proxies went empty = the machines stopped. Prime suspect: the barrier
   **RELEASE is still SSH** — `FLY ssh console -C "touch /data/cloudbench-start-
   <RUN_ID>.release"` fired for ~30 boxes at once → the last remaining SSH burst →
   rate-limited → some boxes never receive `.release` → the on-box driver's
   barrier-wait (`scripts/cloudbench-run.sh` ~line 542) times out / exits → box
   stops → launcher polls `RUN_TIMEOUT` (2 h). **Fix direction:** make the release
   **data-plane** (e.g. the on-box status server also exposes/writes a release
   signal, or poll a controller value), or retry the release SSH per-box with
   backoff, or make the driver poll a data-plane release. MUST get a **local repro**
   first (read a stopped box's log — see commands). Also rule out benchmark agents
   genuinely hanging.
2. **~14/30 excluded at the barrier.** Even with boot-launch, clone-from-snapshot
   is slow and some boxes fail bring-up. Drive exclusions → 0 (see speed below;
   pool provisioning also removes the clone-fork failures).
3. **Provisioning speed (~5 min).** `machine clone --from-snapshot` forks a ~2 GB
   volume per box and rate-limits. **Fix:** pre-provisioned **POOL** — the fleet
   already has `claim_pool_machine` + `--provision-pool N`. Keep ~30 stopped clones
   warm; the fleet claims them instantly (no fork). This is the biggest "ready
   time" win. **Stay on Fly** (must mirror prod); make it as fast as optimal by
   pooling + minimizing/parallelizing Machines-API calls — do NOT switch substrates.
4. **The two deliverables aren't produced yet** (no 30/30 completion). Wire the
   LLM-usage aggregation: data is in per-agent dumps (`agents/benchmarks/.llm-
   dumps/<agent_id>/`), run records (`agents/benchmarks/runs/*.json`), and the
   tool-usage tree (`GET /api/tool-usage/tree/:id`). `run_benchmark.py --compare`
   already does tree-wide token/cache breakdown — extend it to split by provider +
   sub-model. Provider detection: Rose completions `actual_model` suffix
   (`-claude` = Claude OAuth token; waterfall = OpenRouter; `gpt*` = GPT key;
   codex = codex token) — see `docs/internal/llm-call-map.md` ("claudeAuth Flow").

## WORKING DISCIPLINE — check in continuously, kill failing runs EARLY

A full fleet run is long (~30–50 min). **Do not fire a run and wait the whole
time.** Poll it continuously (every ~30–60 s) and **abort the moment it shows
failing behavior** — don't burn 30+ min (and paid Fly machines) on a run that's
already dead. Concrete early-abort triggers:

- Boxes stopping / proxies going empty post-release (the current primary bug).
- `DONE` count flat for several minutes while boxes claim to be "running".
- Exclusions climbing past a few, or the barrier not converging.
- Rate-limit errors (`resource_exhausted`) recurring, or clones failing to resolve.

When you see any of these: **read the evidence, `TERM` your own controller PID,
fix, re-run.** Iterate in tight loops — a fast failed run + fix beats a slow run
you babysat to a known-bad end. (Same cadence rule as the repo's rule 19 for any
background task: poll every ~10 s for the first minute to catch silent early
death, then ~60 s; exit the instant it completes or is clearly failing.)

## EXPLICITLY DO NOT

- **Do NOT kill other run-bench tasks (rule 27).** Broad `pkill -f run-bench|flyctl|
  benchmark`, port-scan kills, etc. have repeatedly murdered healthy fleets from
  other workspaces on this shared machine. To stop YOUR run, `TERM` **exactly its
  controller PID** (modal PPID of the `run-bench-cloud` children) and let its
  cleanup traps reap machines/volumes — never kill children directly. **A live
  controller + 31 clones are running right now** — treat as possibly someone
  else's; surface, don't kill.
- **No prompt changes** (harness/system/benchmark prompts, skills, `.claude/commands`)
  without fresh human approval (rule 26). Approval is snapshot-scoped.
- **No benchmark reward-hacking** (rules 24/25): do not change task definitions,
  prompts, expected tools, pass criteria, load sizes, **timeouts**, or concurrency
  to make it pass. Do NOT raise a timeout as a workaround — RCA the timeout first.
  Any LLM/verifier activity timeout must be **≥ 60 s**.
- **Never rename an existing task `name`** — it's the primary key across all history
  stores (`task_attempts.jsonl`, `task_durations.jsonl`, `span_durations.jsonl`,
  `runs/*.json`).
- **No linter/type escape hatches** (rule 22: no `eslint-disable`, `# noqa`,
  `@ts-ignore`, etc.). **Never `git stash`** (rule 21 — shared ref across worktrees).
  **Fix ALL test failures** — no "pre-existing / not my change" excuses (rules 16/24).
- **Do not fake-pass**: `NORESULT` is not a pass; `actual_model` = gemini/google/
  a silent fallback is not a Claude pass — assert the `claude-*` family for the
  Claude path.
- **Env-var writes need user approval** (Render/Fly/Vercel/Supabase).
- **RCA gate (rule 6):** never report a root cause without a LOCAL REPRO you ran and
  watched fail, plus a fix that makes that same repro pass. No theories ("probably
  load / a race / a 404").
- Do not touch the **prod** worker app `navi-whisper-lux` — the fleet app is
  `navi-whisper-lux-bench`.
- Do not create markdown docs unless asked — this handoff was explicitly
  requested.

## KEY FACTS / COMMANDS / CREDS

- **Fly Machines-API token** is `~/.fly/config.yml` `access_token` — NOT
  `agents/.env` `FLY_API_TOKEN` (org config token → `unauthorized` on `machines
  list`). Read it:
  `TOK="$(grep -E '^access_token:' ~/.fly/config.yml | head -1 | sed 's/^access_token:[[:space:]]*//; s/^["'\'']//; s/["'\'']$//')"; export FLY_API_TOKEN="$TOK"`
- **Fleet app** `navi-whisper-lux-bench`, region `iad`. **Warm/clone-source machine**
  `683e47df5094d8` (`cloudbench-warm`), volume `vol_vwnym366kn7k8mmv`.
- **GitHub**: token in `back-end/.env` or `agents/.env` `GITHUB_TOKEN`; repo
  `Rose-Ai-Labs/rose`.
- **Run the daily fleet** (boot-launch default on):
  `bash scripts/run-bench-fleet <30 daily task names> --detach`
  Daily list = `tasks.json` entries with `group=='daily'`, de-duped (drop the dup
  `message-person-agent-sms` + `browser-agent-amazon-passkey`) → 30 unique.
- **Snapshot pin**: `CLOUDBENCH_SNAPSHOT_ID=<vs_...>` (auto-select picks newest,
  which can be dep-stale). Snapshots: `flyctl volume snapshots list vol_vwnym366kn7k8mmv -a navi-whisper-lux-bench`.
- **Monitor a run**: detached log `.context/fleet/runs/detached-*.log`; per-box
  `.context/fleet/runs/<run-id>/<bench>/fleet-child.log`.
- **Read a stopped box's on-box log** (idle-override, no re-run):
  `flyctl machine update <mid> -a navi-whisper-lux-bench --command "sleep infinity" --skip-health-checks --yes && flyctl machine start <mid>`, then
  `flyctl ssh console -a navi-whisper-lux-bench --machine <mid> -C "bash -lc 'tail -40 /data/bench.log'"`.
- **Read progress via data plane (no SSH)**: curl the box's status proxy port from
  its `fleet-child.log` (`status proxy: 127.0.0.1:<port>`): `curl -s http://127.0.0.1:<port>/bench.log`.
- **Tests**: `cd agents && python3 -m pytest benchmarks/cloudbench_dependency_sync_test.py -q` (59 pass).
- **Cost hygiene**: after any TERM'd/failed run, sweep leaked clones + unattached
  `cloudbench_data` volumes (the teardown traps usually reap, but a rate-limited
  teardown can leak).

## FILES

- `scripts/run-bench-fleet` — controller (clone, barrier, teardown, snapshot select).
- `scripts/run-bench-cloud` — per-box launcher (boot-launch branch + data-plane poll).
- `scripts/cloudbench-boot.sh` — on-box boot entrypoint (RUNSTAMP + status server +
  fetch-ref checkout + exec driver).
- `scripts/cloudbench-run.sh` — on-box driver (git_sync → bring-up → barrier → bench).
- `scripts/run.sh` — the stack (`--benchmark`); seed retry lives here.
- `agents/benchmarks/tasks.json` — the canonical catalog (`group` label).
- `agents/benchmarks/cloudbench_dependency_sync_test.py` — regression suite.
