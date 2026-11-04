---
id: 2026-11-04-local-bench-launcher-leaked-worker-dotenv-into-backend
date: 2026-11-04
title: Multi-task local benchmark launcher leaked agents/.env into the backend, so predeploy browser tasks ran on Kernel instead of the production provider
surface: harness
component: agents/benchmarks/local.py start_services (via agents/helpers import-time load_config)
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "agents/helpers/check_usage.py + helpers/fetch_queue_pointer.py — module-level load_config() load_dotenv()ed agents/.env into any importer; local.py imported them (via run_benchmark in needs_independent_worlds) before start_services forwarded {**os.environ} to run.sh, so the backend inherited BROWSER_PROVIDER=kernel over back-end/.env tilion"
symptoms:
  - "FCaptcha captured API risk score 0.187 exceeds ratchet 0.163 (lower = more human; this gate only ratchets down, never up) [FCaptcha engine v1.46.1"
  - "Request from known datacenter IP range"
  - "proxy_source kernel_residential_city in predeploy, tilion_direct_country in single-task run-bench --local"
  - "browser-biometrics-webdecoy fails in run-predeploy-local but passes in scripts/run-bench --local browser-biometrics-webdecoy"
tags:
  - browser-biometrics-webdecoy
  - fcaptcha
  - predeploy
  - local-stack
  - dotenv
  - env-leak
  - browser-provider
sources:
  - agent 8d029581-c5ca-418a-b255-69df3f729eef
  - fleet run 3c854835-c09e-44ed-85f9-acb0fd33746c
  - commit 1a53cf85be5bd4e8682fac5705c1a710e8861d03
  - commit 8c8e19bb65
repro: agents/tests/blackbox/benchmark.blackbox.py::test_benchmark_launcher_imports_do_not_load_worker_dotenv
status: fixed
---

## Problem

Pre-deploy local smoke `browser-biometrics-webdecoy` (run 3c854835, agent
8d029581, source 4d30348b2 of PR #1684) failed with
`FCaptcha captured API risk score 0.187 exceeds ratchet 0.163 … [FCaptcha engine v1.46.1 …]`.
The same task passed on the same box ~12 hours later at 0.153164. Passing ledger
rows kept no score, so failures and passes could not be compared from history.

FCaptcha `/api/verify` responses carry `categoryScores` and `detections` (the
`/api/score` response is a bare score). They decompose both canonical runs exactly:

- pass 0.153164 = bot 0.6128×0.13 (`PoW verification failed: challenge_network_mismatch`)
  + vision_ai 0.49×0.15 (`Click injected with no pointer trajectory (1 teleport clicks)`)
- fail 0.186764 = the same + datacenter 0.48×0.07 = 0.0336
  (`Request from known datacenter IP range`, present on the first, checkbox-mode
  verify and carried into the final `/api/score`)

Both canonical runs used `provider: kernel, proxy_source: kernel_residential_city`.
On the repair devbox, single-task `scripts/run-bench --local` used Tilion
(`tilion_direct_country`) and scored 0.018 twice. Production Render
`BROWSER_PROVIDER=tilion`.

## Diagnosis

Critical path: `run-predeploy-local → run-bench --local <batch> → local.py with
more than one task and --max-concurrency 2 → needs_independent_worlds() (past its
max_concurrency<=1 early return) imports benchmarks.run_benchmark →
helpers/check_usage.py:12 / helpers/fetch_queue_pointer.py:14 call load_config()
at import → config.py load_dotenv(agents/.env) into os.environ →
start_services: env = {**os.environ} → run.sh → backend process env
BROWSER_PROVIDER=kernel beats back-end/.env tilion → selectedBrowserProvider()=kernel
→ Kernel residential exits`.

Evidence per rung:

1. Both checkouts: back-end/.env `BROWSER_PROVIDER=tilion`, agents/.env
   `BROWSER_PROVIDER=kernel`. It is the only shared key with differing values.
   The worker sends no provider to `/api/browser-session/init`; the backend
   default decides (`config.ts` `process.env.BROWSER_PROVIDER ?? 'tilion'`).
2. `/proc/<pid>/environ` of the live pre-fix predeploy stack backend on the repair
   box: `BROWSER_PROVIDER=kernel`, `BENCHMARK_ATTEMPT_SUITE=predeploy`. Its parent
   `run.sh --benchmark` had it; `local.py`'s exec-time env did not.
3. From `agents/` (find_dotenv resolves from cwd under `python -c`),
   `env -u BROWSER_PROVIDER python -c 'import benchmarks.run_benchmark'` set
   `os.environ["BROWSER_PROVIDER"]="kernel"`. A load_dotenv spy traced it to
   `helpers/check_usage.py:12 config = load_config()`. `config.py` itself
   documents that it "must NOT have side effects at import time"; these two
   helpers were the only module-level callers.
4. Single-task runs return early in `needs_independent_worlds`, so they never
   imported it, which is why they ran on Tilion and the failure was predeploy-only.
   The pre-stack import arrived with commit 8c8e19bb65 (2026-09-11).
5. Sibling leak on the canonical failing stack: services.json shows worker
   `max_concurrent_activities 500 / workflows 200 / cached 1000 / pollers 10`.
   Those are the agents/.env values, overriding run.sh's benchmark defaults
   (16/32/64/16).

The score failure itself is probabilistic: the env boundary reproduces every time,
but on Kernel the ratchet needs PoW network mismatch, teleport click and a
datacenter exit together against a 0.01 margin. The predeploy ledger on main
since 2026-10-28 shows one ratchet failure. Repair-box runs with
`BROWSER_PROVIDER=kernel` exported reproduced the canonical session
(Kernel, `kernel_residential_city`, `new_user_persistent`) and the canonical
0.153164. Another Kernel exit scored 0.0492 with the datacenter flag; a third timed
out after 424s (cause not investigated). The pre-fix predeploy on the repair box ran
webdecoy on Kernel and passed at 0.0492. The exact >0.163 failure was not
re-observed locally; the original failing capture is the replayed fixture.

Why possible (Step 5a): dotenv loading mutates process-global state, so a
launcher that imports worker modules forwards one service's env file to every
child as its highest-priority config. The cloud path enforces a provider contract
(`cloudbench_validate_browser_provider_contract`); the local path had no
equivalent guard.

Archive searches: "FCaptcha captured API risk score exceeds ratchet 0.163" and
"webdecoy risk score intermittent behavioral biometrics mouse". Relatives:
2026-07-28-remote-cdp-roundtrip-inside-click-hold (same ratchet, different
boundary) and 2026-09-07-webdecoy-exclusive-under-isolated-profiles-contention
(predeploy-only, scheduler boundary). Novel at the env-inheritance boundary.

## Solution

1. Boundary: `local.py` snapshots `_LAUNCH_ENVIRON` before any worker import.
   `start_services`, independent-world child launchers and
   `seed_payment_fixture` (a backend script) forward `service_base_environ()`,
   which drops keys that were absent at launch and whose value equals the worker
   dotenv (`WORKER_DOTENV_PATH`). Operator exports and launcher-set values (task
   queue, DB URLs, isolation flags) still pass; each service reads its own env
   file. python-dotenv's own `dotenv_values` is used; agents/.env has no `${}`
   interpolation today.
2. Not changed here: the import-time `load_config()` in `helpers/check_usage.py`
   and `helpers/fetch_queue_pointer.py` (the deeper rung). Making them lazy is a
   worker-runtime change that triggers a production Fly cutover; it was reverted
   from this harness fix and is listed under follow-ups.
3. Observability: every webdecoy attempt records `evaluator_evidence`
   (score, source, engine version, detections from all verify responses,
   browser provider/exit) in the attempts ledger. The ratchet failure line names
   the detections and the browser session.

Regressions (agents blackbox `benchmark` domain, deploy Step 4g):
`test_benchmark_launcher_imports_do_not_load_worker_dotenv` (fresh interpreter,
real import chain; with the pre-fix `{**os.environ}` stack env, 12 worker-dotenv
keys leak, including `BROWSER_PROVIDER`; post-fix none),
`test_local_stack_env_excludes_worker_dotenv_loaded_by_launcher_imports`
(pre-fix `backend inherited the worker dotenv BROWSER_PROVIDER='kernel' over back-end/.env`),
`test_webdecoy_score_evidence_is_recorded_for_comparison` (replays the failing
capture; pre-fix ImportError for the missing capture). All pass post-fix. The
post-fix predeploy backend env had no BROWSER_PROVIDER, allocated Tilion, and
webdecoy passed at 0.0516 (datacenter exit + headless voices; no PoW mismatch or
teleport).

Behavior change to note: multi-task local stacks no longer receive agents-only
keys the backend reads (`PAYMENT_DECRYPTION_KEY`, `BROWSER_USE_API_KEY`,
`FLY_API_TOKEN`, `ENVIRONMENT`) and the predeploy worker now runs at run.sh's
benchmark concurrency defaults. Single-task local runs never had them; the
pre-deploy floor passed post-fix.

Follow-ups (not fixed here): make the two import-time `load_config()` calls
lazy (`config.py` already forbids import-time side effects). agents/.env `BROWSER_PROVIDER=kernel` still
disagrees with back-end/.env and production on both devboxes (worker fallbacks
at `dom_service.py:190`, `download_persist.py:84`, `service.py:999` read it); a
local provider-contract preflight like cloudbench's is not added. On Kernel, the
teleport-click detection appeared in 3 of 4 Kernel sessions (listed in 2 verify
responses, implied by the exact 0.153164 score in 1, absent in the 0.0492 run) and
in 0 of 3 Tilion sessions; cause unproven; Kernel remains the Tilion kill-switch
fallback in production.

10k-agent behavior: launcher-only and import-time changes; one dotenv read per
stack start; no runtime path, channel or per-agent cost changes.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

When a benchmark result differs between local entrypoints, diff the live service processes' environment — a launcher that imports worker config hands its dotenv to every child service ahead of their own env files.
