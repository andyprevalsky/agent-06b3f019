#!/usr/bin/env python3
"""Run /deploy Group 3 and Group 4 lanes concurrently on one frozen source.

Every lane still executes through ``scripts/run-deploy-stage`` so stage
records, logs, ``--reuse-passed`` receipts and factory timing stay unchanged.
This supervisor only schedules lanes and writes one atomic receipt:

* ``plan`` prints the standard Group 3/4 lanes with worker budgets scaled to
  the host (CPU count, MemTotal, MemAvailable and the watchdog cap); deploy.md values are
  the 14-core ceiling and never grow. Every lane declares ``memory_mb``.
* ``run``  starts every lane whose ``after`` dependencies have exited, with
  previously failed lanes (from the prior receipt in the same state dir)
  admitted first. At most ``--max-parallel`` lanes run at once (default from
  the host's cores and memory); the declared ``memory_mb`` of the running
  lanes plus the candidate never exceeds the startup budget, and against the
  current whole-box headroom below the watchdog cap (2 GiB reserve) a phased
  lane is charged only the running lanes' still-unmaterialized declarations
  (see *Admission accounting* below). A lane that cannot fit alone is
  refused (``failed``, note ``refused: ...``) instead of being started into
  cgroup throttling or the memory watchdog. Lanes keep running after a
  sibling fails so one iteration collects every failure. When all lanes
  finish it re-hashes the source and marks the receipt ``stale`` if anything
  changed after the freeze, so an older snapshot can never be reported green.

Admission accounting (follow-up ah, measured on #1640, 2026-10-30). Two
checks admit a pending lane. The startup budget (``memory_budget_mb``, the
smaller of the plan's and the headroom at attempt start) caps the declared
total of the running lanes plus the candidate; it is a static ceiling that
does not contain the running lanes' usage. Since follow-up PR-11 (#1658 round
1, 2026-10-31) a phased candidate is charged, against that ceiling as well,
only the unmaterialized declaration of each freshly observed running lane
(``reserved_static_mb`` beside ``reserved_declared_mb`` in the waiting and
admission records): the plan had sized the coverage lanes' workers one by one
and their declarations with the smoke lane summed to 8758 MB against an 8755
MB budget, so agents-coverage (1536 MB) waited ~14 min on reason ``budget``
for backend-coverage to finish while live headroom had 157 MB to spare. An
unobserved, stale or unknown lane, a disabled credit and an unphased
candidate keep the whole declarations; the never-fits refusal is unchanged
and the live check remains the binding bound. The live check samples the host again and requires the
candidate to fit ``memory_budget_mb`` of that sample (MemAvailable and the
watchdog cap, less the 2 GiB reserve). That headroom already contains what
the running lanes use, so charging their whole declarations against it again
double-counted them: on #1640 attempt 1 the two coverage lanes (2560 + 1152 MB
declared) had taken MemAvailable to ~8300 MB (headroom ~4700 MB) and the 4096
MB smoke lane waited 16 min (18:15:06 -> 18:31:08) for ``3712 + 4096 <= 4700``
although the box held ~11.2 GB below the watchdog cap; on #1639 the same three
lanes started together only because no co-tenant held memory at 15:06:22.
``run`` therefore samples every running lane's process tree at 1 Hz (PSS of
every descendant of its stage wrapper; ``tree_anon_mb`` / ``tree_pss_mb`` /
``tree_sampled_at`` / ``tree_peak_anon_mb`` / ``tree_peak_pss_mb`` on the
lane; Linux /proc) and, for a phased lane (Group 3 or a declared
coverage-phase lane), reserves only ``sum(max(0, declared - observed))`` of
the running lanes: exactly the growth their declarations still allow.
Observed means anonymous PSS (``Pss_Anon`` from ``smaps_rollup``) only:
MemAvailable still counts a lane's file-backed resident pages as reclaimable,
so crediting total PSS would double-count them, and summed RSS would count
pages shared between the lane's processes once per process; total PSS is
recorded alongside for the receipt. A tree with any live process whose
rollup is unreadable or lacks ``Pss``/``Pss_Anon`` is unknown. Every
sampling pass re-marks every running lane, so a lane the pass could not fully
observe is unknown again rather than keeping an earlier value, and the credit
binds to a fresh observation: at most ``OBSERVATION_MAX_AGE_SECONDS`` (3 s)
old on the monotonic clock, measured from the stamp taken *before* the /proc
scan, so a scan that itself outlives the limit yields no credit when it
returns; the raw elapsed value is compared (rounding only the displayed age),
and a negative age (a stamp from the future) is ``invalid``, also no credit.
``tree_sampled_at`` keeps the wall-clock scan start for humans. The
classification and the resulting credit are computed per candidate at its
decision point, immediately after the live host probe, never ahead of the
candidate loop: a slow probe or a deschedule between the sampling pass and
the decision ages the sample, and the decision and its record use the same,
current classification. Each running lane's observation state
(``fresh``/``stale``/``invalid``/``unknown``), values and age are part of the
recorded admission inputs, and a deferred lane keeps its first and latest
deferral inputs. A lane whose usage is unknown, stale or
invalid (macOS, unreadable /proc, not yet sampled, a stalled or slow pass)
keeps its whole declaration, and the declarations themselves are unchanged.
``DEPLOY_ADMISSION_CREDIT=0`` (default on) disables the credit for a matched
control run on the identical plan and head: observations are still sampled
and recorded, every running lane classifies as ``disabled``, the whole
declarations are reserved (the pre-credit accounting) and the receipt and
every admission record carry ``credit: disabled``. An unphased lane
(``semantic-stack``) keeps the declared-peak accounting: no observed-usage
credit, so its declaration plus the running lanes' whole declarations must
fit live headroom. Every decision is kept on the lane for audit: ``admission``
(``admitted``/``refused`` with headroom, budget, declared and live
reservations, the running lanes with their observed usage, and the deferral
history) and ``waiting`` while deferred. The smoke lane reserves a pinned
1.25x margin over its largest recorded process-tree peak (3319.4 MB
``tree_peak_pss_mb`` on the 20261031-115354 attempt; ``SMOKE_RECORDED_TREE_PEAK_MB``,
re-pin when a receipt exceeds it): 4150 MB.

  With ``--follow-source`` the supervisor keeps hashing the source while lanes
  run. Once a change has settled (``--settle-seconds`` without further edits)
  it supersedes the attempt: running lanes are terminated, their results are
  discarded, and a new attempt starts on the new bytes with the superseded
  attempt's failed lanes first. Every attempt is bound to HEAD plus the source
  digest it ran on; ``verify`` refuses a receipt whose bytes are not the
  current worktree. Speculation never touches the bounded review ledger
  (``deploy_review_cycle.py``): it only starts gates earlier.

  ``--fix-loop-cap N`` (default 2, env ``DEPLOY_FIX_LOOP_CAP``) refuses a
  blind N+1th full round: after N completed failed rounds in this state dir
  the driver prints ``FIX_LOOP_CAP`` with the failure classes and exits 6.
  ``--after-rca REF`` records the RCA that justifies the next round and
  restarts the count.
* ``wait`` is the same event waiter as ``run-deploy-stage --wait``
  (``scripts/deploy_stage_wait.py``) over this pipeline's lanes: it watches
  the lanes' own stage receipts and adds only supervisor events (supervisor
  died, lane never started or refused, stale source, superseded attempt).
  ``--since`` (epoch captured before launching ``run``) is required so a
  previous iteration's receipt can never satisfy the wait. Exit codes match
  that waiter: 0 = all green, 1 = a lane failed, 2 = usage/receipt error, 3 = a lane
  runner or the supervisor died, 4 = stalled (``--stall-seconds``),
  124 = timeout, 5 = stale source, 6 = fix-loop cap.
* ``verify`` exits 0 only when the receipt passed on exactly the current
  HEAD and worktree bytes (never merge a HEAD whose gates ran on other bytes).

* ``simulate`` projects the Group 3 union wall of the phased schedule against
  the legacy all-at-once admission from the same recorded lane durations,
  naming every lane whose isolated duration is unrecorded as UNMEASURED.

* ``production`` is the post-merge Fly lane (deploy.md Step 13/13ab): when the
  merge (``merged_sha^1..merged_sha``) touches agent runtime files per
  ``scripts/classify-agent-runtime-changes.sh`` or ``deploy-agents.yml``, it
  waits for the exact ``deploy-agents.yml`` run whose headSha is the merged SHA
  to complete (any conclusion), recovers the durable job id from its log, and
  requires the Step 13ab proof that the Fly lane is live: the durable job
  (``worker-deployment-queue.ts read``) is ``SUCCEEDED`` and bound to the
  merged SHA and ``<run_id>-<attempt>``, and
  ``monitor-cooperative-cutover.ts --verify`` passes. Only then does it run the
  dispatch command after ``--`` (the Step 13b production semantic dispatch).
  The run's GitHub conclusion is recorded but is not the authority: a run that
  concluded failure and was resumed through the queue CLI keeps that
  conclusion. ``production.json`` in the state dir records the decision, run
  id/attempt/job id, job stage and every GitHub wait; a still-running run, a
  job that is not SUCCEEDED, an identity mismatch or a failed monitor exits 1
  with the operator's next action (the exact resume command) and never
  dispatches (the #1639 chain dispatched while Fly was still cutting over and
  4/5 production semantic jobs failed, 2026-10-30).
* ``production-render`` is the Step 13a Render wait: it polls the Render
  deploys API for the merged SHA. A deploy for that SHA is the authority
  (``live`` opens the gate, a failed status blocks it, otherwise keep
  polling). When a newer main merge replaced it (Render ``canceled`` or
  ``deactivated`` the merged deploy), the gate opens as
  ``verified-by-descendant`` only on a live deploy whose commit strictly
  descends from the merged SHA (``git merge-base --is-ancestor merged
  live``), waits while such a descendant is still deploying and otherwise
  blocks: an older, unrelated or failed rollout never passes, and an older
  SHA is never redeployed over newer live main. When Render created none
  (auto-deploy skips a commit with no
  change under its Root Directory; #1652 and #1655 spun to the bound,
  2026-10-31), the live deploy's commit opens the gate as
  ``source-equivalent`` only when ``git diff <live> <merged> -- back-end/
  render.yaml package.json package-lock.json`` is empty and the live commit
  is an ancestor of the merged SHA (Render skipped the merge) or a
  descendant of it (a later PR deployed the identical backend); this assumes
  the Render service's Root Directory is back-end with no build filters. A
  live descendant that changed those paths contains the merge and opens as
  ``verified-by-descendant`` (never source-equivalent); an ancestor that
  changed them or an unrelated live commit keeps the
  bounded wait. It records ``render`` (status, live_commit,
  observed_live_commit on every poll, merged_sha, backend_diff, equivalence
  evidence with a reason code, ``verified_by_descendant`` evidence) in
  ``production.json`` and prints ``RENDER_LIVE``, ``RENDER_SOURCE_EQUIVALENT
  live=<sha> merged=<sha> reason=<code>`` or ``RENDER_VERIFIED_BY_DESCENDANT
  live=<sha> merged=<sha> reason=<code>``. Credential, Render API and git
  failures exit 2 and never pass.
* ``production-semantic`` is the Step 13b dispatch itself. It requires the
  passed ``production`` receipt for the same merged SHA, dispatches
  ``chat-lifecycle-ratchet.yml`` on ``main`` with ``source_sha=<merged SHA>``
  (``workflow_dispatch`` refs must be branches or tags, so the exact commit
  travels as an input the workflow checks out and names in its run title),
  binds to the newest run created after the dispatch whose title names that
  SHA (an older run or another commit's run is never adopted, whatever its
  headSha), polls it every 30 s within a bounded total, prints
  ``SEMANTIC_RUN_ID=`` and ``SEMANTIC_LANE_END <ts>``, records run id, url,
  headSha, effective source_sha, created/completed, conclusion and per-job
  conclusions under ``semantic`` in ``production.json`` and exits 0 only when
  the run concluded ``success``. ``--retry-failed-once "<justification>"``
  reruns only the failed jobs (``gh run rerun <id> --failed``) exactly once,
  recording the justification; a second retry is refused. The #1646 deploy
  (2026-10-31) dispatched ``--ref main`` after a data-only commit had landed,
  so the run tested a later head and needed a separate equivalence proof.

Group 3 admission schedule (EXP-L). Lanes that ran concurrently on the
8-core/15 GB devbox thrashed each other (deploy-command-structural 1,555 s
beside the coverage lanes; frontend coverage 1,059 s beside them versus
260 s alone). ``run`` therefore phases Group 3 from recorded per-lane
durations (``.context/deploy-durations/pipeline-lanes.json``, written after
every attempt from the lanes' own wall clocks and seeded from the stage
receipts under ``.context/deploy-runs``): the quick lanes (recorded <= 90 s:
eslint, typescript, backend-structural, seed checks) start together, then
every ``exclusive`` lane (deploy-command-structural) runs alone at the full
host width the memory budget allows, then the coverage lanes start together
under the existing budgets, longest recorded first, so frontend and backend
overlap inside the agents window. Phases are implied ``after`` dependencies:
no lane is skipped, every lane remains a full sweep, failed lanes still run
first within their phase and Group 4 lanes are untouched unless they declare
a phase. ``"phase": "coverage"`` joins the coverage phase (after the quick
and exclusive phases) instead of starting at attempt start. ``"phase":
"stack"`` is admitted right after the quick phase, beside the exclusive lane
whenever both declarations fit the budget, and no later phase waits for it.
The 4150 MB local smoke lane declares ``stack`` (follow-up lane-memory-b,
2026-10-31): unphased and admitted first it had held the memory the
structural lane needed (6544 MB of a 7752 MB budget; #1638 attempt 5 ran
smoke alone for ~22 min), and in the coverage phase it waited the whole 9-10
min exclusive phase on every round although the structural lane's process
tree never exceeded 2575 MB (19 recorded attempts). With the lane declared at
its recorded peak x1.25 (3220 MB at three workers) the two fit the recorded
7979 MB budget together (7370 MB), the coverage lanes (2560 + 1152 MB) still
wait for the exclusive phase (7370 + 2560 > 7979), and beside
backend-coverage-blackbox the smoke lane fits the budget afterwards. A plan
with ``"schedule": {"policy": "legacy"}`` keeps the previous all-at-once
admission.

``plan --live-probes --semantic-stack --e2b-smoke`` (follow-up 12, 2026-10-31;
default off) versions the tails that only the private launcher plan carried.
``live-probes`` (Group 3, ``python3 scripts/run_deploy_live_probes.py``, 963 MB
= 1.25x its 769.7 MB recorded peak) waits for every other Group 3 lane as
deploy.md Step 4p orders. ``semantic-stack`` (Group 4, unphased,
``bash scripts/run-deploy-semantic-stack.sh``: its own ``run.sh --benchmark``
stack, Playwright UI semantics and the latency ratchet; 6108 MB = 1.25x the
4886.2 MB peak of its first split-lane receipt, follow-up 13) waits
for ``deploy-command-structural`` and for the agents/frontend coverage lanes
only: its non-isolated stack's startup and EXIT ``kill-services.sh`` sweeps
reap same-worktree worker.py/Playwright-driver/npm/vite children, which those
lanes spawn (``SEMANTIC_STACK_SWEEP_EDGES``), while backend coverage and the
live probes boot ``bootstrap.ts`` backends the sweep patterns never match and
the split lane no longer shares their ``victoria_<workspace>`` database. The
launcher lane's edges on backend coverage and live-probes are gone; the sweeps
still spare every process of a live isolated run (smoke, AgentCard) through
the run's owner record, manifest and ``BENCHMARK_RUN_ID``
(``scripts/tests/kill-services.test.sh``,
``scripts/tests/run-isolated-cloud-kill.test.sh``; ``STACK_KILLER_LANES`` is
empty since follow-up "an"). Memory still decides on this devbox: on the
recorded 7979 MB budget 6108 + 2560 (backend coverage) and 6108 + 4150
(smoke) exceed the budget, so admission defers semantic-stack until both
release their reservations, declarations unchanged; 6108 + 1152 (agents
coverage) would fit, which is why the sweep edge, not memory, holds it there.
On the launcher host's 8755 MB budget the same holds (6108 + 3072 > 8755;
6108 + 812 fits). ``e2b-smoke`` (Group 4, unphased,
``run-deploy-semantic-stack.sh --e2b-smoke-only``, 812 MB = 1.25x the 649.1
MB peak of its first receipt, follow-up 13) runs the Step 6c Claude Code E2B
blackbox smoke through the standalone runner after ``live-probes`` and
backend coverage, which drive the same runner against ``victoria_<workspace>``
(``E2B_SMOKE_DATABASE_EDGES``). 6108 + 812 = 6920 fits 7979, so the two
Group 4 tails may run side by side on this devbox as well as on 8755.

Plan file (JSON): {"lanes": [{"name", "command": [...], "cwd": "back-end",
"env": {...}, "after": ["lane"], "reuse_passed": true, "group": "3",
"memory_mb": 1024, "exclusive": false, "phase": ""}], "max_parallel": 4,
"memory_budget_mb": 9000, "schedule": {"policy": "phased"},
"lane_scoped_reuse": false}

``lane_scoped_reuse`` (default false; the plan is the only enabling surface,
``DEPLOY_LANE_SCOPED_REUSE=0`` is a kill switch) passes ``--lane-scoped-reuse``
to every lane: a lane listed in ``run_deploy_stage._SCOPED_REUSE_LANES`` that
runs its real command and whose exact-input lookup missed may reuse its most
recent PASSED result when every path changed since that pass is provably
inert for it (declared inert set AND no selected test in the change->test
graph, and no failed run on an inert-equivalent head). Its stage row and
receipt lane carry the distinct ``reused-scoped`` status with the passed
head, fingerprint, run id and the rule that judged every changed path; it is
a pass for the waiter and ``overall`` but never a fresh pass of the current
bytes. The candidate may come from an earlier timing run of the same run root
(same metadata ``branch``, same invocation, passed head an ancestor of HEAD,
record under 24 h, read in place and never copied): the row's ``reuse`` then
carries ``cross_run: true`` with ``passed_run_id``/``passed_run_dir`` and the
lane is also listed in ``reused_scoped_cross_run_lanes``.
The receipt lane is relabelled from its own stage row (matched by the
per-launch ``DEPLOY_PIPELINE_LANE_TOKEN`` the row echoes) whether or not this
plan enabled the feature, so a receipt can never call a reused lane passed.
"""

from __future__ import annotations

import argparse
import hashlib
from collections.abc import Mapping
import json
import math
import os
import re
import runpy
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import deploy_stage_wait  # scripts/ is sys.path[0]: one waiter for every /deploy gate
import factory_metadata

ROOT = Path(__file__).resolve().parents[1]
STAGE_WRAPPER = ROOT / "scripts" / "run-deploy-stage"
SOURCE_ROOT = ROOT
# boxes.dev's whole-machine memory watchdog records every TERM it sends here;
# a run copies the receipts inside its window so a killed lane is attributed.
WATCHDOG_LOG = Path(os.environ.get("DEPLOY_PIPELINE_WATCHDOG_LOG") or "/run/boxes-memory-terminations.jsonl")
HOST_SAMPLE_SECONDS = 1.0
# A running lane's process-tree observation credits its declaration only while
# it is this fresh; an older or failed sample keeps the whole declaration.
OBSERVATION_MAX_AGE_SECONDS = 3 * HOST_SAMPLE_SECONDS
# ``DEPLOY_ADMISSION_CREDIT=0`` disables the materialized-memory credit for a
# matched control run on the identical plan and head: observations are still
# sampled and recorded, every running lane classifies as ``disabled`` and the
# whole declarations are reserved (the pre-credit accounting).
ADMISSION_CREDIT_ENV = "DEPLOY_ADMISSION_CREDIT"
PROC_ROOT = Path("/proc")
RECEIPT_SCHEMA = 2
EXIT_STALE = 5
EXIT_FIX_LOOP_CAP = 6
DEFAULT_FIX_LOOP_CAP = 2
DEFAULT_SETTLE_SECONDS = 10.0
DEFAULT_POLL_SECONDS = 2.0
DEFAULT_MAX_ATTEMPTS = 20
TERMINAL_LANE = {"passed", "failed", "superseded", "reused-scoped"}
# Lane statuses that satisfy the run: a lane-scoped reuse executed nothing on
# the current bytes and keeps its own label everywhere it is reported.
PASSING_LANE = {"passed", "reused-scoped"}
LANE_SCOPED_REUSE_ENV = "DEPLOY_LANE_SCOPED_REUSE"


# One token per lane launch, stamped into the lane's environment and recorded
# on the receipt lane as ``lane_token``. run_deploy_stage.py excludes it from
# every fingerprint and echoes it as the stage row's ``detail.lane_token``
# (receipt lane <-> row matching); the lane teardown reads it from
# /proc/<pid>/environ to decide which processes the lane owns.
LANE_TOKEN_ENV = "DEPLOY_PIPELINE_LANE_TOKEN"
# A stage row must start within this many seconds before the receipt lane's
# own start to be its row when no token can be compared (older rows).
LANE_ROW_START_SLACK_SECONDS = 5.0


def lane_scoped_reuse_enabled(payload: dict | None) -> bool:
    """Plan field ``lane_scoped_reuse`` only (default off); the environment
    can disable (``DEPLOY_LANE_SCOPED_REUSE=0``) but never enable."""
    return bool((payload or {}).get("lane_scoped_reuse")) and os.environ.get(LANE_SCOPED_REUSE_ENV) != "0"


def lane_token(name: str, attempt: int) -> str:
    return f"{name}.{attempt}.{uuid.uuid4().hex}"


# Internal waiter event: the supervisor superseded the attempt being waited on.
_SUPERSEDED_EVENT = -1
# run-deploy-stage rejects any other stage name before it writes a row.
LANE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")
# deploy.md's worker budgets were sized for this host; smaller hosts scale down.
CEILING_CPUS = 14
CEILING_MEM_MB = 32768
MIN_WORKERS = 1
STRUCTURAL_RUNNER_MAX_WORKERS = 8  # scripts/run-deploy-structural-gates.py DEFAULT_MAX_WORKERS
STRUCTURAL_RUNNER_SCRIPT = "run-deploy-structural-gates.py"
# 20261028-174430 stage receipt: largest structural child 1471.98 MiB.
# Round its 1.25x margin up: the per-suite floor that sizes the lane's width
# (how many suites the budget can back if every active one hits that ceiling).
STRUCTURAL_WORKER_MEMORY_MB = 1840
STRUCTURAL_CHILD_PEAK_MB = 1471.98
# Whole-lane reservation (follow-up "lane-memory-b", 2026-10-31): the suites
# never all peak together. Across 19 passed attempts in the 2026-10-30/31
# devbox deploys (`.context/deploy-pipeline/history.jsonl`, lanes[].
# tree_peak_pss_mb) the lane's process tree peaked at 2427.8-2575.4 MB at
# three workers while the per-suite floor declared 6544 MB (2.5x), which kept
# the 4096 MB smoke lane waiting ~9 min behind it on a ~8 GB budget. The lane
# declares LANE_PEAK_MARGIN times the recorded tree peak scaled to its width,
# never below the margin over a single suite's recorded child peak.
STRUCTURAL_RECORDED_TREE_PEAK_MB = 2575.4
STRUCTURAL_RECORDED_WORKERS = 3
LANE_PEAK_MARGIN = 1.25
# Local smoke lane: largest recorded process-tree peak (3319.4 MB on the
# 20261031-115354 attempt, lanes[].tree_peak_pss_mb); re-pin when a receipt
# exceeds it. The AgentCard lifecycle lane (its own run-bench --local stack,
# no recorded peak yet) declares the same reservation.
SMOKE_RECORDED_TREE_PEAK_MB = 3319.4
# Step 4p live probes as a plan lane (``plan --live-probes``, follow-up 12,
# 2026-10-31): largest recorded process-tree peak over 13 receipts of the
# 2026-10-30/31 devbox deploys (lanes["live-probes"].tree_peak_pss_mb in
# .context/deploy-pipeline/history.jsonl: 708.5-769.7 MB); re-pin when a
# receipt exceeds it.
LIVE_PROBES_RECORDED_TREE_PEAK_MB = 769.7
# Group 4 semantic lane (``plan --semantic-stack``: its own run.sh --benchmark
# stack, the Playwright UI semantics and the latency ratchet): process-tree
# peak of the first receipt of the split lane (run 20261031-164809-1083486,
# head a334edca1, 2026-10-31; lanes["semantic-stack"].tree_peak_pss_mb). The
# 10 earlier launcher-lane receipts peaked at 4489.2-5205.2 MB while the lane
# still ended with the Step 6c E2B smoke, which is now its own lane; re-pin
# when a receipt exceeds it.
SEMANTIC_STACK_RECORDED_TREE_PEAK_MB = 4886.2
# Step 6c Claude Code E2B smoke as its own lane (``plan --e2b-smoke``, the
# standalone blackbox runner beside one isolated bootstrap.ts backend):
# process-tree peak of its first receipt (run 20261031-164809-1083486, head
# a334edca1, 2026-10-31; lanes["e2b-smoke"].tree_peak_pss_mb), replacing the
# 1536 MB estimate the lane carried before any receipt measured it alone;
# re-pin when a receipt exceeds it.
E2B_SMOKE_RECORDED_TREE_PEAK_MB = 649.1
# Kept free for the agent harness, the Docker DB and the 15 GB memory watchdog.
MEMORY_RESERVE_MB = 2048
DEFAULT_LANE_MEMORY_MB = 1024
# ── Group 3 admission schedule (EXP-L) ────────────────────────────────────────
# Recorded per-lane wall clocks, per worktree (next to the backend blackbox
# domain ledger the sharded coverage coordinator keeps).
LANE_DURATIONS = Path(".context") / "deploy-durations" / "pipeline-lanes.json"
LANE_DURATION_SAMPLES = 20
# A lane whose recorded duration is at most this many seconds is "quick": it
# finishes before any heavy lane would benefit from the freed cores.
QUICK_LANE_SECONDS = 90.0
SCHEDULE_PHASED = "phased"
SCHEDULE_LEGACY = "legacy"
# Phases a lane outside Group 3 may declare (``Lane.phase``): ``coverage``
# joins the coverage lanes after the quick and exclusive phases; ``stack`` is
# admitted right after the quick phase, beside the exclusive structural lane
# whenever both declarations fit, and nothing is ever held behind it.
PHASE_COVERAGE = "coverage"
PHASE_STACK = "stack"
LANE_PHASES = ("", PHASE_COVERAGE, PHASE_STACK)
# Safe default order when no duration has been recorded yet (seconds observed
# on the 2026-10-29 deploy-1627 runs; only their relative order matters).
DEFAULT_LANE_SECONDS = {
    "seed-cache-decision": 3.0,
    "canonical-seed-whatsapp-content": 2.5,
    "eslint": 24.0,
    "typescript": 27.0,
    "backend-structural": 37.0,
    "deploy-command-structural": 1555.0,
    "backend-coverage-blackbox": 1505.0,
    "frontend-coverage-blackbox": 1000.0,
    "agents-coverage-blackbox": 800.0,
    # Local smoke lane, 2026-10-30 #1638 (22.6 min alone); orders it within the
    # coverage phase and lets ``simulate`` project it on a fresh host.
    "smoke": 1358.0,
    # Versioned Group 4 tails (follow-up 12): medians of the 2026-10-30/31
    # stage receipts; semantic-stack without the ~45 s E2B step it used to end
    # with. Only their relative order and ``simulate`` projections use these.
    "live-probes": 40.0,
    "semantic-stack": 760.0,
    "e2b-smoke": 45.0,
}


def host_resources(cpus: int | None = None, mem_available_mb: int | None = None,
                   mem_total_mb: int | None = None, watchdog_cap_mb: int | None = None) -> dict:
    """Whole-box resources; explicit memory values describe a different host."""
    explicit_memory = mem_available_mb is not None or mem_total_mb is not None
    if cpus is None:
        cpus = os.cpu_count() or 1
    memory = _memory_info()
    if mem_available_mb is None:
        mem_available_mb = memory.get("MemAvailable")
    if mem_total_mb is None:
        mem_total_mb = mem_available_mb if explicit_memory else memory.get("MemTotal")
    if watchdog_cap_mb is None and not explicit_memory:
        watchdog_cap_mb = _watchdog_cap_mb()
    # Without a watchdog receipt retain ten percent of physical memory below
    # the machine limit. The separate reserve protects unrelated processes.
    if watchdog_cap_mb is None and mem_total_mb is not None:
        watchdog_cap_mb = int(mem_total_mb * 0.9)
    return {"cpus": max(1, int(cpus)), "mem_available_mb": mem_available_mb,
            "mem_total_mb": mem_total_mb, "watchdog_cap_mb": watchdog_cap_mb}


def runtime_host_resources() -> dict:
    """A failed live probe is unknown headroom, never cached admission capacity."""
    try:
        return host_resources()
    except ValueError as error:
        print(f"PIPELINE_HOST_SAMPLE: unavailable: {error}", file=sys.stderr, flush=True)
        return {"error": str(error)}


def _memory_info() -> dict[str, int]:
    if sys.platform == "darwin":
        return _macos_memory_info()
    try:
        memory = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, _, value = line.partition(":")
            if key in {"MemAvailable", "MemTotal"}:
                memory[key] = int(value.split()[0]) // 1024
        return memory
    except (OSError, IndexError, ValueError):
        # Physical memory alone is not evidence of *available* memory.
        return {}


def _macos_memory_info() -> dict[str, int]:
    """Native live estimate: free + inactive + speculative pages.

    vm_stat subtracts speculative pages from its printed "Pages free", so
    these three counts are disjoint. Purgeable/file-backed counters overlap
    page queues and are not added; compressed/active/wired pages stay used.
    """
    try:
        def read(command: list[str]) -> str:
            return subprocess.check_output(command, text=True, stderr=subprocess.PIPE,
                                           env={**os.environ, "LC_ALL": "C"}, timeout=5)

        total = int(read(["/usr/sbin/sysctl", "-n", "hw.memsize"]).strip())
        stats = read(["/usr/bin/vm_stat"])
        page_match = re.search(r"page size of (\d+) bytes", stats)
        pages = dict(re.findall(r"^(Pages free|Pages inactive|Pages speculative):\s+(\d+)\.\s*$",
                                stats, re.MULTILINE))
        if page_match is None or len(pages) != 3:
            raise ValueError("vm_stat omitted page size or free/inactive/speculative counts")
        page_size = int(page_match.group(1))
        available = sum(int(count) for count in pages.values()) * page_size
        if total <= 0 or page_size <= 0 or not 0 <= available <= total:
            raise ValueError("invalid native memory counters")
        return {"MemTotal": total // (1024 * 1024), "MemAvailable": available // (1024 * 1024)}
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise ValueError("cannot sample macOS memory: verify `/usr/sbin/sysctl -n hw.memsize` "
                         "and `/usr/bin/vm_stat` succeed and report native page counts") from error


def _watchdog_cap_mb() -> int | None:
    try:
        for line in reversed(WATCHDOG_LOG.read_text().splitlines()):
            try:
                row = json.loads(line)
                value = int(row.get("workloadMaxBytes", 0))
                if value > 0:
                    return value // (1024 * 1024)
            except (ValueError, TypeError, AttributeError):
                continue
    except OSError:
        pass
    return None


def host_scale(host: dict) -> float:
    """1.0 at the 14-core/32 GB ceiling, proportionally less on smaller hosts."""
    scale = min(1.0, host["cpus"] / CEILING_CPUS)
    if host.get("mem_total_mb") is not None:
        scale = min(scale, host["mem_total_mb"] / CEILING_MEM_MB)
    budget = memory_budget_mb(host)
    if budget is not None:
        scale = min(scale, budget / (CEILING_MEM_MB * 0.75))
    return max(scale, 0.0)


def scale_workers(ceiling: int, host: dict) -> int:
    """Scale a deploy.md worker budget to the host; never above the ceiling."""
    if ceiling < 1:
        raise ValueError("worker budgets must be positive")
    return max(min(MIN_WORKERS, ceiling), int(ceiling * host_scale(host)))


def default_max_parallel(host: dict) -> int:
    """Bound concurrency by cores and usable memory, at most seven lanes."""
    cap = max(1, min(CEILING_CPUS // 2, host["cpus"] // 2))
    budget = memory_budget_mb(host)
    return min(cap, max(1, budget // DEFAULT_LANE_MEMORY_MB)) if budget is not None else 1


def structural_runner_workers(host: dict) -> int:
    """scripts/run-deploy-structural-gates.py's host default (same formula)."""
    return scale_workers(STRUCTURAL_RUNNER_MAX_WORKERS, host)


def structural_lane_memory_mb(workers: int) -> int:
    """Declared reservation of the structural lane at ``workers`` suites: the
    recorded process-tree peak scaled to that width, never below one suite's
    recorded child peak, with LANE_PEAK_MARGIN (3 workers: 3220 MB)."""
    if workers < 1:
        raise ValueError("structural lane width must be positive")
    scaled = STRUCTURAL_RECORDED_TREE_PEAK_MB * workers / STRUCTURAL_RECORDED_WORKERS
    return int(math.ceil(LANE_PEAK_MARGIN * max(scaled, STRUCTURAL_CHILD_PEAK_MB)))


def smoke_lane_memory_mb() -> int:
    """Declared reservation of the local smoke stack: LANE_PEAK_MARGIN over its
    largest recorded process-tree peak (3319.4 MB recorded -> 4150 MB declared)."""
    return int(math.ceil(LANE_PEAK_MARGIN * SMOKE_RECORDED_TREE_PEAK_MB))


def live_probes_lane_memory_mb() -> int:
    """Declared reservation of the Step 4p live probes lane: LANE_PEAK_MARGIN
    over its largest recorded process-tree peak (769.7 MB recorded -> 963 MB declared)."""
    return int(math.ceil(LANE_PEAK_MARGIN * LIVE_PROBES_RECORDED_TREE_PEAK_MB))


def semantic_stack_lane_memory_mb() -> int:
    """Declared reservation of the Group 4 semantic stack lane: LANE_PEAK_MARGIN
    over its largest recorded process-tree peak (4886.2 MB recorded -> 6108 MB
    declared)."""
    return int(math.ceil(LANE_PEAK_MARGIN * SEMANTIC_STACK_RECORDED_TREE_PEAK_MB))


def e2b_smoke_lane_memory_mb() -> int:
    """Declared reservation of the Group 4 Step 6c E2B smoke lane:
    LANE_PEAK_MARGIN over its largest recorded process-tree peak (649.1 MB recorded
    -> 812 MB declared)."""
    return int(math.ceil(LANE_PEAK_MARGIN * E2B_SMOKE_RECORDED_TREE_PEAK_MB))


def structural_workers_within(available_mb: int, planned: int) -> int:
    """The widest structural lane, at most ``planned``, whose declared
    reservation fits ``available_mb``; 0 when not even one worker fits."""
    for workers in range(planned, 0, -1):
        if structural_lane_memory_mb(workers) <= available_mb:
            return workers
    return 0


def memory_budget_mb(host: dict) -> int | None:
    """Whole-box budget: MemAvailable counts every process on the host
    (Postgres, Docker, other agents), not only this unit's cgroup."""
    if host.get("mem_available_mb") is None:
        return None
    headroom = int(host["mem_available_mb"])
    if host.get("mem_total_mb") is not None and host.get("watchdog_cap_mb") is not None:
        used = host["mem_total_mb"] - headroom
        headroom = min(headroom, host["watchdog_cap_mb"] - used)
    return max(0, headroom - MEMORY_RESERVE_MB)


def _load1() -> float | None:
    try:
        return float(Path("/proc/loadavg").read_text().split()[0])
    except (OSError, IndexError, ValueError):
        try:
            return os.getloadavg()[0]
        except (OSError, AttributeError):
            return None


def sample_host_peak(peak: dict, host: dict) -> dict:
    """Fold the current whole-box MemAvailable/load1 into the running extremes."""
    available = host.get("mem_available_mb")
    load1 = _load1()
    peak["samples"] = peak.get("samples", 0) + 1
    if available is not None:
        if peak.get("mem_available_min_mb") is None or available < peak["mem_available_min_mb"]:
            peak["mem_available_min_mb"] = available
            peak["mem_available_min_at"] = _now()
    if load1 is not None and (peak.get("load1_peak") is None or load1 > peak["load1_peak"]):
        peak["load1_peak"] = load1
    return peak


def sample_lane_tree_memory(pids: set[int], proc: Path | None = None) -> dict[int, dict | None]:
    """Anonymous and total proportional resident memory (MB) of each lane's
    whole process tree (``{"anon_mb", "pss_mb"}``), or ``None`` for a lane
    whose tree could not be fully observed.

    Descendants are followed by parent links from the lane's stage wrapper, so
    the stage runner's command (started in its own session) and everything it
    forks are attributed to the lane; a process that daemonized away from the
    tree is missed, which only under-credits the lane. Only ``Pss_Anon`` from
    ``/proc/<pid>/smaps_rollup`` (kernel >= 4.14) is a materialized claim on
    MemAvailable: file-backed resident pages stay counted as reclaimable in
    MemAvailable, so crediting them would double-count them, and PSS counts
    pages shared between the lane's own processes once, where summed RSS
    would count them once per process. Total ``Pss`` is recorded alongside
    for the receipt. A rollup missing either line, or any live process whose
    rollup is unreadable, makes the tree unknown. A process that exited
    between the listing and the read is simply gone. Linux only: elsewhere, or
    when /proc cannot be listed, every lane is unknown and keeps its whole
    declaration reserved.
    """
    proc = PROC_ROOT if proc is None else proc
    if not pids:
        return {}
    if (sys.platform != "linux" and proc == PROC_ROOT):
        return {int(pid): None for pid in pids}
    try:
        entries = os.listdir(proc)
    except OSError:
        return {int(pid): None for pid in pids}
    parents: dict[int, int] = {}
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            stat = (proc / entry / "stat").read_text()
        except OSError:
            continue  # exited between listdir and read
        fields = stat[stat.rindex(")") + 2:].split()
        try:
            parents[int(entry)] = int(fields[1])
        except (IndexError, ValueError):
            continue
    children: dict[int, list[int]] = {}
    for pid, parent in parents.items():
        children.setdefault(parent, []).append(pid)

    def resident_mb(pid: int) -> tuple[float, float] | None:
        """(anonymous PSS, total PSS) in MB; None when the tree is unknown."""
        try:
            lines = (proc / str(pid) / "smaps_rollup").read_text().splitlines()
        except OSError:
            # Exited since the listing: nothing resident. Otherwise a live
            # process without a readable rollup, which makes the tree unknown.
            return (0.0, 0.0) if not (proc / str(pid)).exists() else None
        values: dict[str, float] = {}
        for line in lines:
            key, _, rest = line.partition(":")
            if key in ("Pss", "Pss_Anon"):
                try:
                    values[key] = int(rest.split()[0]) / 1024
                except (IndexError, ValueError):
                    return None
        if "Pss" not in values or "Pss_Anon" not in values:
            return None
        return values["Pss_Anon"], values["Pss"]

    totals: dict[int, dict | None] = {}
    for root in pids:
        anon_total: float | None = 0.0
        pss_total = 0.0
        seen: set[int] = set()
        stack = [int(root)]
        while stack and anon_total is not None:
            pid = stack.pop()
            if pid in seen or pid not in parents:
                continue
            seen.add(pid)
            value = resident_mb(pid)
            if value is None:
                anon_total = None
                break
            anon_total += value[0]
            pss_total += value[1]
            stack.extend(children.get(pid, []))
        totals[int(root)] = None if anon_total is None else {"anon_mb": round(anon_total, 1),
                                                              "pss_mb": round(pss_total, 1)}
    return totals


def fresh_tree_anon_mb(state: dict, now: float | None = None) -> tuple[float | None, dict]:
    """The lane's anonymous process-tree PSS when the latest sampling pass
    observed the whole tree and started within ``OBSERVATION_MAX_AGE_SECONDS``;
    otherwise ``None``. Age is measured on the monotonic clock from the stamp
    the pass took before its /proc scan (``tree_sampled_mono``); a negative
    age (a stamp from the future) or one beyond the limit is stale. The detail
    names the observation state (``fresh``, ``stale``, ``unknown``), the
    anonymous and total PSS and the age for the admission record."""
    now = time.monotonic() if now is None else now
    value, at = state.get("tree_anon_mb"), state.get("tree_sampled_mono")
    # Compare the raw elapsed value; round only what the record displays, or a
    # true age of 3.04 s would read 3.0 and pass, and -0.04 s would read -0.0.
    age = None if at is None else now - float(at)
    detail = {"tree_anon_mb": value, "tree_pss_mb": state.get("tree_pss_mb"),
              "observed_age_s": None if age is None else round(age, 2)}
    if value is None:
        return None, {**detail, "observation": "unknown"}
    if age is not None and age < 0:
        return None, {**detail, "observation": "invalid"}  # a stamp from the future
    if age is None or age > OBSERVATION_MAX_AGE_SECONDS:
        return None, {**detail, "observation": "stale"}
    return float(value), {**detail, "observation": "fresh"}


def admission_credit_enabled() -> bool:
    """Default on; ``DEPLOY_ADMISSION_CREDIT=0`` (or false/no/off) disables it."""
    return os.environ.get(ADMISSION_CREDIT_ENV, "1").strip().lower() not in {"0", "false", "no", "off"}


def classify_observations(running_states: dict[str, dict],
                          credit_enabled: bool = True) -> dict[str, tuple[float | None, dict]]:
    """Each running lane's creditable anonymous MB and observation detail at
    this decision. With the credit disabled every lane is ``disabled``: the
    sampled values stay in the record and nothing is credited."""
    observations = {name: fresh_tree_anon_mb(state) for name, state in running_states.items()}
    if credit_enabled:
        return observations
    return {name: (None, {**detail, "observation": "disabled"}) for name, (_, detail) in observations.items()}


def unmaterialized_mb(memory_mb: int, observed_mb: float | None) -> int:
    """The part of a running lane's declared reservation not yet visible in
    MemAvailable: its headroom for growth still to come. Unobserved usage
    keeps the whole declaration."""
    if observed_mb is None:
        return int(memory_mb)
    return max(0, int(memory_mb) - int(observed_mb))


def _admission_inputs(lane: Lane, headroom: int | None, budget_mb: int | None, reserved: int, live_reserved: int,
                      accounting: str, observations: dict[str, tuple[float | None, dict]],
                      by_name: dict[str, Lane], credit_enabled: bool = True) -> dict:
    """Every input of one admission decision, kept on the lane for audit."""
    return {"at": _now(), "headroom_mb": headroom, "budget_mb": budget_mb, "memory_mb": lane.memory_mb,
            "reserved_declared_mb": reserved, "reserved_live_mb": live_reserved, "accounting": accounting,
            "credit": "enabled" if credit_enabled else "disabled",
            "running": {name: {"memory_mb": by_name[name].memory_mb, **detail}
                        for name, (_, detail) in observations.items()}}


def _record_waiting(state: dict, inputs: dict, reason: str) -> None:
    """Deferral history on the lane: the first and the latest decision inputs
    and how many checks it has waited through."""
    waiting = state.setdefault("waiting", {"since": _now(), "checks": 0, "first": {**inputs, "reason": reason}})
    waiting["checks"] += 1
    waiting["reason"] = reason
    waiting["last"] = inputs


def _iso_epoch(value: object) -> float | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def _iso_epoch_interval(value: object) -> tuple[float, float] | None:
    """The instants a truncated ISO stamp can name: ``[start, start + resolution)``.
    The watchdog writes ``at`` to the millisecond ("…:41.333Z") and other
    producers to the second ("…:41Z"); the digits it keeps are a floor, so a
    TERM at 41.3337 is stamped 41.333 and one at 41.9 is stamped 41."""
    start = _iso_epoch(value)
    if start is None:
        return None
    fraction = re.search(r"\d{2}:\d{2}:\d{2}\.(\d+)", str(value))
    return start, start + 10 ** -(len(fraction.group(1)) if fraction else 0)


def watchdog_terminations(started_epoch: float, finished_epoch: float, log: Path = WATCHDOG_LOG) -> list[dict]:
    """Memory-watchdog TERM receipts whose ``at`` falls inside the run window.

    ``at`` is a floor at the stamp's own resolution while ``started_epoch`` is
    a full-precision float: a TERM 0.4 ms after the run started is stamped
    the millisecond before it, so comparing the bare stamp dropped every TERM
    in the run's first resolution unit. The stamp's whole interval must miss
    the window for the row to be outside it."""
    try:
        lines = log.read_text().splitlines()
    except OSError:
        return []
    found = []
    for line in lines:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        interval = _iso_epoch_interval(row.get("at"))
        if interval is not None and interval[1] > started_epoch and interval[0] <= finished_epoch:
            found.append(row)
    return found


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _source_label(source: Mapping[str, object] | None) -> str:
    """``head=<sha> digest=<12 hex>`` for log lines; a freeze without those keys
    (tests patch ``source_digest`` to ``{}``) renders ``-`` instead of raising."""
    source = source or {}
    head = source.get("head") or "-"
    digest = str(source.get("digest") or "")[:12] or "-"
    return f"head={head} digest={digest}"


def source_digest(root: Path | None = None) -> dict[str, str]:
    """HEAD plus every tracked/untracked non-ignored byte of the worktree."""
    root = SOURCE_ROOT if root is None else root

    def git(*arguments: str) -> bytes:
        return subprocess.run(
            ("git", *arguments), cwd=root, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=300,
        ).stdout

    digest = hashlib.sha256()
    head = git("rev-parse", "HEAD").strip()
    digest.update(head + b"\0")
    digest.update(git("diff", "--no-ext-diff", "--binary", "HEAD", "--", ".", ":(exclude)agents/benchmarks/history") + b"\0")
    untracked = git("ls-files", "--others", "--exclude-standard", "-z")
    for raw in sorted(path for path in untracked.split(b"\0") if path):
        if raw.startswith(b"agents/benchmarks/history/"):
            continue  # append-only ledger data written by the smoke lane
        path = root / os.fsdecode(raw)
        digest.update(raw + b"\0")
        try:
            digest.update(os.readlink(path).encode() if path.is_symlink() else path.read_bytes())
        except OSError as error:
            digest.update(f"unreadable:{type(error).__name__}".encode())
        digest.update(b"\0")
    return {"head": head.decode(), "digest": digest.hexdigest()}


@dataclass
class Lane:
    name: str
    command: list[str]
    cwd: str = "."
    env: dict[str, str] = field(default_factory=dict)
    after: list[str] = field(default_factory=list)
    reuse_passed: bool = True
    group: str = ""
    # Extra env applied only when this lane failed in the previous receipt
    # (e.g. the backend coverage lane's failed-first full sweep).
    retry_env: dict[str, str] = field(default_factory=dict)
    # Declared peak footprint; the supervisor admits lanes against the budget.
    memory_mb: int = DEFAULT_LANE_MEMORY_MB
    # Runs alone in its own phase at full host width (deploy-command-structural).
    exclusive: bool = False
    # Declared phase for a lane outside Group 3: "coverage" admits it with the
    # coverage lanes, after the quick and exclusive phases; "stack" admits it
    # right after the quick phase beside the exclusive structural lane when
    # both declarations fit, and no later phase waits for it (the local smoke
    # and AgentCard stacks). Empty keeps a Group 4 lane unphased; Group 3 lanes
    # are phased from their recorded durations regardless.
    phase: str = ""


def load_plan(path: Path) -> list[Lane]:
    return load_plan_payload(path)[0]


# Ownership boundary, not a memory question: a lane whose own stack startup or
# teardown sweeps would terminate another lane's stack must wait for every
# lane that owns one (the local smoke lane's per-run benchmark stack, the
# AgentCard lifecycle lane's ``run-bench --local`` stack); the loader adds
# that edge explicitly and declared edges are never removed. The deploy.md
# ``semantic-stack`` lane was listed here until follow-up "an" (2026-10-31):
# its ``run.sh --benchmark`` sweeps (``kill_stale_same_worktree_benchmark_stack``
# and ``scripts/kill-services.sh``) now spare every process of a live isolated
# run (owner record, live manifest or the ``BENCHMARK_RUN_ID`` its processes
# carry; regressions in scripts/tests/kill-services.test.sh and
# scripts/tests/run-isolated-cloud-kill.test.sh), so only memory admission
# decides whether it runs beside smoke. No current lane needs the edge.
STACK_KILLER_LANES: tuple[str, ...] = ()
STACK_OWNER_LANES = ("smoke", "agentcard-lifecycle")


def implied_stack_dependencies(lanes: list[Lane]) -> list[Lane]:
    """``after`` edges from every stack-killing lane to each stack-owning lane
    present in the plan, appended to the lane's declared edges."""
    names = {lane.name for lane in lanes}
    result: list[Lane] = []
    for lane in lanes:
        if lane.name in STACK_KILLER_LANES:
            owners = [owner for owner in STACK_OWNER_LANES
                      if owner in names and owner != lane.name and owner not in lane.after]
            if owners:
                lane = replace(lane, after=[*lane.after, *owners])
        result.append(lane)
    return result


def load_plan_payload(path: Path) -> tuple[list[Lane], dict]:
    payload = json.loads(path.read_text())
    lanes = implied_stack_dependencies([Lane(**lane) for lane in payload["lanes"]])
    names = [lane.name for lane in lanes]
    if len(set(names)) != len(names):
        raise ValueError(f"duplicate lane names: {names}")
    for lane in lanes:
        if not LANE_NAME.match(lane.name):
            raise ValueError(f"invalid lane name {lane.name!r}: run-deploy-stage accepts [A-Za-z0-9._-]+")
        if not lane.command:
            raise ValueError(f"{lane.name}: empty command")
        if int(lane.memory_mb) < 0:
            raise ValueError(f"{lane.name}: memory_mb must be >= 0")
        if lane.phase not in LANE_PHASES:
            raise ValueError(f"{lane.name}: unknown phase {lane.phase!r} (expected one of {LANE_PHASES})")
        for dependency in lane.after:
            if dependency not in names or dependency == lane.name:
                raise ValueError(f"{lane.name}: invalid dependency {dependency}")
    dependencies = {lane.name: lane.after for lane in lanes}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(name: str) -> None:
        if name in visiting:
            raise ValueError(f"cyclic lane dependency: {name}")
        if name in visited:
            return
        visiting.add(name)
        for dependency in dependencies[name]:
            visit(dependency)
        visiting.remove(name)
        visited.add(name)

    for name in names:
        visit(name)
    return lanes, payload


def _failed_lanes(receipt: dict | None) -> set[str]:
    if not receipt:
        return set()
    return {name for name, lane in receipt.get("lanes", {}).items() if lane.get("status") == "failed"}


def failed_first(lanes: list[Lane], previous: dict | None) -> list[Lane]:
    """Stable order with the prior receipt's failed lanes admitted first."""

    failed = _failed_lanes(previous)
    return sorted(lanes, key=lambda lane: 0 if lane.name in failed else 1)


def write_receipt(path: Path, receipt: dict) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def overall(lanes: dict[str, dict]) -> str:
    statuses = [lane["status"] for lane in lanes.values()]
    if any(status == "failed" for status in statuses):
        return "failed" if all(s in TERMINAL_LANE for s in statuses) else "failing"
    if all(status in PASSING_LANE for status in statuses):
        return "passed"
    return "running"


def lane_durations_path() -> Path:
    override = os.environ.get("DEPLOY_PIPELINE_LANE_DURATIONS")
    return Path(override) if override else ROOT / LANE_DURATIONS


def load_lane_durations(path: Path | None = None) -> dict[str, list[dict]]:
    """Recorded samples per lane: [{"wall_s", "status", "concurrent", "at", ...}]."""
    path = lane_durations_path() if path is None else path
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    lanes = payload.get("lanes") if isinstance(payload, dict) else None
    if not isinstance(lanes, dict):
        return {}
    clean: dict[str, list[dict]] = {}
    for name, samples in lanes.items():
        rows = []
        for sample in samples if isinstance(samples, list) else []:
            try:
                wall = float(sample["wall_s"])
            except (KeyError, TypeError, ValueError):
                continue
            if wall > 0 and sample.get("status") in {"passed", "failed"}:
                rows.append({**sample, "wall_s": wall})
        if rows:
            clean[str(name)] = rows
    return clean


def _lane_stage_row(receipt: dict, name: str) -> dict | None:
    """The run-deploy-stage row this receipt's lane wrote.

    Matched by the per-launch token the lane's row echoes in its detail when
    the receipt lane carries one. Without a token (older receipts) the row
    must start no earlier than ``LANE_ROW_START_SLACK_SECONDS`` before the
    lane's own start and no later than the lane's finish (plus the same
    slack, or any time while the lane is still running): a reuse decision
    under load can start well over 5 s after the lane was spawned, and an
    unmatched row would leave the receipt calling a reused lane passed.
    """
    lane = receipt.get("lanes", {}).get(name, {})
    run_dir = receipt.get("stage_run_dir")
    started = lane.get("started_epoch")
    if not run_dir or started is None:
        return None
    token = lane.get("lane_token")
    finished = lane.get("finished_epoch")
    upper = float(finished) + LANE_ROW_START_SLACK_SECONDS if finished is not None else float("inf")
    best: tuple[float, dict] | None = None
    for row in deploy_stage_wait._rows(Path(run_dir)):
        if row.get("stage") != name:
            continue
        try:
            row_started = float(row.get("started_epoch") or 0)
        except (TypeError, ValueError):
            continue
        if token:
            if (row.get("detail") or {}).get("lane_token") != token:
                continue
        elif not (float(started) - LANE_ROW_START_SLACK_SECONDS <= row_started <= upper):
            continue
        if best is None or row_started > best[0]:
            best = (row_started, row)
    return best[1] if best else None


def reconcile_reused_lane(receipt: dict, name: str, lane_state: dict, *, finished_epoch: float) -> str:
    """The receipt status of a lane that exited 0: ``reused-scoped`` with the
    row's provenance when its own stage row says so, else ``passed``.

    Independent of the plan's ``lane_scoped_reuse``: the stage decides, the
    receipt reports what the stage recorded.
    """
    probe = {**receipt, "lanes": {name: {**lane_state, "finished_epoch": finished_epoch}}}
    row = _lane_stage_row(probe, name)
    if row is None or row.get("status") != "reused-scoped":
        return "passed"
    reuse = (row.get("detail") or {}).get("reuse")
    lane_state["reuse"] = reuse
    receipt["reused_scoped_lanes"] = sorted({*receipt.get("reused_scoped_lanes", []), name})
    if isinstance(reuse, dict) and reuse.get("cross_run"):
        # The pass came from an earlier timing run, not this one: distinguished
        # so no reader mistakes it for a reuse of this run's own evidence.
        receipt["reused_scoped_cross_run_lanes"] = sorted({*receipt.get("reused_scoped_cross_run_lanes", []), name})
    return "reused-scoped"


def record_lane_durations(receipt: dict, path: Path | None = None) -> dict[str, list[dict]]:
    """Append every executed lane's own wall clock to the ledger.

    Exact-input ``--reuse-passed`` hits (stage status ``reused``) and
    superseded, refused or never-started lanes record nothing: only a lane
    that actually ran is evidence of its duration. ``concurrent`` counts the
    lanes of this attempt whose run overlapped the sample's.
    """
    path = lane_durations_path() if path is None else path
    ledger = load_lane_durations(path)
    lanes = receipt.get("lanes", {})
    for name, lane in lanes.items():
        if lane.get("status") not in {"passed", "failed"} or not lane.get("wall_s") or lane.get("started_epoch") is None:
            continue
        row = _lane_stage_row(receipt, name)
        if row is not None and row.get("status") in {"reused", "reused-scoped"}:
            continue
        overlap = 1
        for other, state in lanes.items():
            if other == name or state.get("started_epoch") is None or state.get("finished_epoch") is None:
                continue
            if state["started_epoch"] < lane["finished_epoch"] and state["finished_epoch"] > lane["started_epoch"]:
                overlap += 1
        sample = {"wall_s": round(float(lane["wall_s"]), 1), "status": lane["status"], "concurrent": overlap,
                  "at": receipt.get("started_at"), "head": (receipt.get("source") or {}).get("head"),
                  "attempt": receipt.get("attempt"), "source": "receipt",
                  # Footprint telemetry for right-sizing ``memory_mb``: the largest
                  # single child (wait4) and the lane's whole process tree (anonymous
                  # and total PSS peaks, sampled at 1 Hz).
                  "peak_rss_mb": lane.get("peak_rss_mb"), "tree_peak_anon_mb": lane.get("tree_peak_anon_mb"),
                  "tree_peak_pss_mb": lane.get("tree_peak_pss_mb")}
        ledger.setdefault(name, []).append(sample)
        ledger[name] = ledger[name][-LANE_DURATION_SAMPLES:]
    path.parent.mkdir(parents=True, exist_ok=True)
    write_receipt(path, {"schema_version": 1, "lanes": ledger})
    return ledger


def stage_receipt_samples(names: list[str], run_root: Path | None = None) -> dict[str, list[dict]]:
    """Seed estimates from the stage receipts of every deploy run in this
    worktree: a lane that ran before the ledger existed still has data."""
    if run_root is None:
        run_root = Path(os.environ.get("DEPLOY_RUN_ROOT") or ROOT / ".context" / "deploy-runs")
    wanted = set(names)
    found: dict[str, list[dict]] = {}
    try:
        stage_files = sorted(run_root.glob("*/stages.jsonl"))
    except OSError:
        return found
    for stage_file in stage_files:
        for row in deploy_stage_wait._rows(stage_file.parent):
            name = row.get("stage")
            if name not in wanted or row.get("status") not in {"passed", "failed"}:
                continue
            try:
                wall = float(row.get("duration_seconds") or 0)
            except (TypeError, ValueError):
                continue
            if wall <= 0:
                continue
            timing = ((row.get("detail") or {}).get("timing") or {})
            found.setdefault(name, []).append({
                "wall_s": wall, "status": row.get("status"), "concurrent": int(timing.get("concurrent_stages") or 1),
                "at": row.get("started_at"), "source": "stage-receipt"})
    return {name: rows[-LANE_DURATION_SAMPLES:] for name, rows in found.items()}


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2.0


def _passed(samples: list[dict] | None) -> list[dict]:
    return [sample for sample in samples or [] if sample.get("status") == "passed"]


def lane_estimates(lanes: list[Lane], ledger: dict[str, list[dict]] | None = None,
                   stage_samples: dict[str, list[dict]] | None = None) -> dict[str, dict]:
    """Per-lane duration estimate and where it came from.

    Passed ledger samples win, then passed stage receipts, then the safe
    default table; a lane known nowhere is ``unknown`` and scheduled as heavy
    (never quick). Only a pass measures a lane: a lane that FAILED in 2.5 s (a
    stale-Prisma refusal) was re-phased as quick ahead of the exclusive lane,
    and a 4.9 s failed live-probes sample deadlocked attempt 7 (2026-10-30).
    Failed samples stay in the ledger as telemetry only. ``isolated_s`` is the
    median of passed samples that ran with nothing else, when any exist;
    ``seconds`` is the median of every passed sample.
    """
    ledger = load_lane_durations() if ledger is None else ledger
    stage_samples = {} if stage_samples is None else stage_samples
    estimates: dict[str, dict] = {}
    for lane in lanes:
        passed_ledger = _passed(ledger.get(lane.name))
        samples = passed_ledger or _passed(stage_samples.get(lane.name))
        if samples:
            source = "ledger" if passed_ledger else "stage-receipts"
            walls = [float(sample["wall_s"]) for sample in samples]
            alone = [float(s["wall_s"]) for s in samples if int(s.get("concurrent") or 1) <= 1]
            estimates[lane.name] = {"seconds": round(_median(walls), 1), "samples": len(samples), "source": source,
                                    "isolated_s": round(_median(alone), 1) if alone else None}
        elif lane.name in DEFAULT_LANE_SECONDS:
            estimates[lane.name] = {"seconds": DEFAULT_LANE_SECONDS[lane.name], "samples": 0, "source": "default",
                                    "isolated_s": None}
        else:
            estimates[lane.name] = {"seconds": None, "samples": 0, "source": "unknown", "isolated_s": None}
    return estimates


def assert_acyclic(after: dict[str, list[str]]) -> None:
    """Fail loudly on a dependency that never starts: an unknown lane name or a
    cycle. The admission loop would otherwise idle forever with every lane
    pending (attempt 7, 2026-10-30)."""
    for name, dependencies in after.items():
        unknown = sorted(set(dependencies) - set(after))
        if unknown:
            raise ValueError(f"lane {name!r} waits for unknown lane(s) {', '.join(unknown)}")
    state: dict[str, int] = {}  # 1 visiting, 2 done
    stack: list[str] = []

    def visit(name: str) -> None:
        if state.get(name) == 2:
            return
        if state.get(name) == 1:
            cycle = stack[stack.index(name):] + [name]
            raise ValueError(f"dependency cycle: {' -> '.join(cycle)}")
        state[name] = 1
        stack.append(name)
        for dependency in after[name]:
            visit(dependency)
        stack.pop()
        state[name] = 2

    for name in after:
        visit(name)


def _closed_subset(candidates: list[Lane], explicit: dict[str, list[str]], placed: set[str]) -> list[Lane]:
    """The candidates whose explicit dependencies all lie in earlier phases or
    in the same phase (an edge inside a phase is honoured by admission; an
    edge to a later phase would be a cycle with the implied phase edges)."""
    chosen = {lane.name for lane in candidates}
    while True:
        dropped = {name for name in chosen
                   if any(d not in placed and d not in chosen for d in explicit[name])}
        if not dropped:
            return [lane for lane in candidates if lane.name in chosen]
        chosen -= dropped


def phased_lanes(lanes: list[Lane]) -> list[Lane]:
    """Group 3 plus every lane that declares a phase (the local smoke lane)."""
    return [lane for lane in lanes if lane.group == "3" or lane.phase in (PHASE_COVERAGE, PHASE_STACK)]


def phased_dependencies(lanes: list[Lane]) -> dict[str, list[str]]:
    """For every phased lane, the phased lanes it waits for: its direct
    ``after`` edges plus every edge reached through a chain of unphased lanes.
    A quick lane ``q`` that waits for the unphased ``u``, which waits for the
    coverage lane ``p``, must wait for ``p``'s phase as well; dropping ``u``
    placed ``q`` in the quick phase and the implied edge p -> q closed the
    cycle p -> u -> q -> p (CodeRabbit on #1639, 2026-10-30). Order follows
    the lane's own ``after`` list, depth first; unknown names are left to
    ``assert_acyclic`` on the full plan."""
    by_name = {lane.name: lane for lane in lanes}
    names = {lane.name for lane in phased_lanes(lanes)}
    dependencies: dict[str, list[str]] = {}
    for lane in phased_lanes(lanes):
        found: list[str] = []
        seen: set[str] = set()
        stack = list(reversed(lane.after))
        while stack:
            dependency = stack.pop()
            if dependency in seen:
                continue
            seen.add(dependency)
            if dependency in names:
                found.append(dependency)
            elif dependency in by_name:
                stack.extend(reversed(by_name[dependency].after))
        dependencies[lane.name] = found
    return dependencies


def schedule_phases(lanes: list[Lane], estimates: dict[str, dict]) -> list[dict]:
    """Ordered Group 3 phases: quick lanes, each exclusive lane alone, then the
    rest (longest recorded first). Other groups are not phased unless a lane
    declares ``phase: "coverage"``, which places it in the coverage phase.

    Phases are layered over the plan's own ``after`` DAG: a lane joins a phase
    only once every explicit dependency (direct, or reached through unphased
    lanes; ``phased_dependencies``) is in an earlier phase or in that same
    phase, so the implied edges (phase k waits for phases < k) can never form
    a cycle with an explicit edge. A quick lane that waits for the exclusive
    lane therefore runs with the coverage lanes instead of deadlocking it.
    Pass every plan lane, not only the phased ones: the unphased lanes carry
    the chains.
    """
    phased = phased_lanes(lanes)
    explicit = phased_dependencies(lanes)
    assert_acyclic(explicit)

    def seconds(lane: Lane) -> float:
        value = (estimates.get(lane.name) or {}).get("seconds")
        return float("inf") if value is None else float(value)

    phases: list[dict] = []
    placed: set[str] = set()
    remaining = list(phased)
    while remaining:
        emitted: list[Lane] = []
        if not phases:
            quick = [l for l in remaining if not l.exclusive and not l.phase and seconds(l) <= QUICK_LANE_SECONDS]
            emitted = sorted(_closed_subset(quick, explicit, placed), key=seconds)
            if emitted:
                phases.append({"phase": "quick", "lanes": [l.name for l in emitted]})
        if not emitted and not any(p["phase"] == PHASE_STACK for p in phases):
            # Stack lanes start as soon as the quick lanes are done: beside the
            # exclusive lane when memory allows, else as soon as it releases.
            stack = [l for l in remaining if not l.exclusive and l.phase == PHASE_STACK]
            emitted = sorted(_closed_subset(stack, explicit, placed), key=seconds, reverse=True)
            if emitted:
                phases.append({"phase": PHASE_STACK, "lanes": [l.name for l in emitted]})
        if not emitted:
            ready_exclusive = sorted((l for l in remaining if l.exclusive and all(d in placed for d in explicit[l.name])),
                                     key=seconds, reverse=True)
            if ready_exclusive:
                emitted = [ready_exclusive[0]]
                phases.append({"phase": "exclusive", "lanes": [emitted[0].name]})
        if not emitted:
            heavy = [l for l in remaining if not l.exclusive]
            emitted = sorted(_closed_subset(heavy, explicit, placed), key=seconds, reverse=True)
            if emitted:
                phases.append({"phase": "coverage", "lanes": [l.name for l in emitted]})
        if not emitted:  # unreachable after assert_acyclic; never idle silently
            raise ValueError(f"no schedulable phased lane among {', '.join(sorted(l.name for l in remaining))}")
        placed.update(lane.name for lane in emitted)
        remaining = [lane for lane in remaining if lane.name not in placed]
    return phases


def implied_dependencies(phases: list[dict]) -> dict[str, list[str]]:
    """Every lane of phase k waits for every lane of phases < k, except that
    no lane waits for a ``stack`` phase: its lanes wait for the quick phase
    and run beside whatever memory admits after it."""
    implied: dict[str, list[str]] = {}
    earlier: list[str] = []
    for phase in phases:
        for name in phase["lanes"]:
            implied[name] = list(earlier)
        if phase["phase"] != PHASE_STACK:
            earlier.extend(phase["lanes"])
    return implied


def apply_schedule(lanes: list[Lane], payload: dict) -> dict:
    """Add the phase-implied ``after`` edges to ``lanes``; return the receipt record."""
    policy = str((payload.get("schedule") or {}).get("policy") or SCHEDULE_PHASED)
    # The plan's own edges must be satisfiable before any lane starts.
    assert_acyclic({lane.name: list(lane.after) for lane in lanes})
    if policy == SCHEDULE_LEGACY:
        return {"policy": SCHEDULE_LEGACY, "phases": [], "estimates": {}, "implied_after": {}}
    if policy != SCHEDULE_PHASED:
        raise ValueError(f"unknown schedule policy {policy!r} (expected {SCHEDULE_PHASED} or {SCHEDULE_LEGACY})")
    ledger = load_lane_durations()
    stage_samples = stage_receipt_samples([lane.name for lane in lanes])
    estimates = lane_estimates(lanes, ledger, stage_samples)
    phases = schedule_phases(lanes, estimates)
    implied = implied_dependencies(phases)
    for lane in lanes:
        for dependency in implied.get(lane.name, []):
            if dependency != lane.name and dependency not in lane.after:
                lane.after.append(dependency)
    # Explicit plus implied edges together: a cycle here would idle the attempt.
    assert_acyclic({lane.name: list(lane.after) for lane in lanes})
    return {"policy": SCHEDULE_PHASED, "phases": phases, "estimates": estimates, "implied_after": implied}


def exclusive_structural_workers(host: dict) -> int:
    """Width of the structural runner when it runs alone: every core the
    whole-box memory budget can back at the measured per-worker floor."""
    budget = memory_budget_mb(host)
    by_memory = STRUCTURAL_RUNNER_MAX_WORKERS if budget is None else (budget - 1024) // STRUCTURAL_WORKER_MEMORY_MB
    return max(MIN_WORKERS, min(STRUCTURAL_RUNNER_MAX_WORKERS, host["cpus"], int(by_memory)))


def _lane_workers(lane: Lane) -> int | None:
    """The ``--max-workers N`` a lane's command declares, or None."""
    try:
        return int(lane.command[lane.command.index("--max-workers") + 1])
    except (ValueError, IndexError):
        return None


def fit_exclusive_lane(lane: Lane, available_mb: int) -> Lane | None:
    """The exclusive structural lane at the width ``available_mb`` backs at the
    per-worker floor, never wider than planned.

    The plan sizes that lane to the whole budget measured when ``plan`` ran;
    MemAvailable drifts by about 1 GB before its phase starts (page cache held
    by tsc/eslint, Postgres, other agents on the box), and a lane reserved to
    the last MB was refused at admission without running a single gate
    (PR1634 coordinator, 2026-10-29). Narrowing it keeps every gate running at
    the width the box can actually back; None when not even MIN_WORKERS fit,
    which stays a refusal. Only the structural runner's own command is sized by
    the structural formula: any other exclusive lane (a custom ``--plan`` lane
    with its own ``--max-workers``) keeps its declared ``memory_mb``.
    """
    planned = _lane_workers(lane)
    if not lane.exclusive or planned is None or not _runs_structural_gates(lane):
        return None
    workers = structural_workers_within(int(available_mb), planned)
    if workers < MIN_WORKERS:
        return None
    index = lane.command.index("--max-workers") + 1
    command = [*lane.command[:index], str(workers), *lane.command[index + 1:]]
    return replace(lane, command=command, memory_mb=structural_lane_memory_mb(workers))


def _runs_structural_gates(lane: Lane) -> bool:
    """Whether the lane's command executes scripts/run-deploy-structural-gates.py."""
    return any(Path(part).name == STRUCTURAL_RUNNER_SCRIPT for part in lane.command)


def _list_schedule(order: list[Lane], seconds: dict[str, float], after: dict[str, list[str]],
                   max_parallel: int, budget_mb: int | None) -> float:
    """Makespan of a list schedule under the driver's admission rules."""
    return _wall(_list_schedule_finish(order, seconds, after, max_parallel, budget_mb))


def _wall(finished: dict[str, float], names: set[str] | None = None) -> float:
    values = [end for name, end in finished.items() if names is None or name in names]
    return round(max(values), 1) if values else 0.0


def _list_schedule_finish(order: list[Lane], seconds: dict[str, float], after: dict[str, list[str]],
                          max_parallel: int, budget_mb: int | None) -> dict[str, float]:
    """Finish time of every lane in a list schedule under the driver's admission rules."""
    finished: dict[str, float] = {}
    running: list[tuple[float, str, int]] = []  # (end, name, memory_mb)
    pending = list(order)
    clock = 0.0
    while pending or running:
        reserved = sum(memory for _, _, memory in running)
        for lane in list(pending):
            if max_parallel and len(running) >= max_parallel:
                break
            if any(dependency not in finished for dependency in after.get(lane.name, [])):
                continue
            if budget_mb is not None and running and reserved + lane.memory_mb > budget_mb:
                continue
            pending.remove(lane)
            running.append((clock + seconds[lane.name], lane.name, lane.memory_mb))
            reserved += lane.memory_mb
        if running:
            running.sort()
            end, name, _ = running.pop(0)
            clock = max(clock, end)
            finished[name] = clock
        elif pending:  # unsatisfiable dependency: force progress rather than spin
            lane = pending.pop(0)
            running.append((clock + seconds[lane.name], lane.name, lane.memory_mb))
    return finished


def simulate(lanes: list[Lane], estimates: dict[str, dict], max_parallel: int, budget_mb: int | None) -> dict:
    """Projected union wall of the phased lanes (Group 3 plus declared-phase
    lanes such as the local smoke lane), phased versus legacy admission, from
    recorded durations only (no contention model). ``group3`` reports the same
    two walls over the Group 3 lanes alone, so the smoke lane's own length
    never hides how long the Group 3 gates took.

    Legacy uses every lane's recorded median, measured with the lanes running
    together. Phased uses ``isolated_s`` where a lane has run alone and the
    same loaded median otherwise, naming those lanes UNMEASURED: the phased
    wall is then an upper bound, not a measurement.
    """
    simulated = phased_lanes(lanes)
    group3 = {lane.name for lane in simulated if lane.group == "3"}
    loaded = {lane.name: float((estimates.get(lane.name) or {}).get("seconds") or 0.0) for lane in simulated}
    # Edges to other phased lanes, including those reached through unphased
    # lanes (whose own durations the projection does not model).
    legacy_after = phased_dependencies(lanes)
    legacy_finish = _list_schedule_finish(sorted(simulated, key=lambda l: -loaded[l.name]), loaded, legacy_after,
                                          max_parallel, budget_mb)
    phases = schedule_phases(lanes, estimates)
    implied = implied_dependencies(phases)
    phased: dict[str, float] = {}
    unmeasured: list[str] = []
    for lane in simulated:
        isolated = (estimates.get(lane.name) or {}).get("isolated_s")
        if isolated is None:
            unmeasured.append(lane.name)
        phased[lane.name] = loaded[lane.name] if isolated is None else float(isolated)
    phased_after = {lane.name: sorted(set(legacy_after[lane.name]) | set(implied.get(lane.name, [])))
                    for lane in simulated}
    phased_finish = _list_schedule_finish(sorted(simulated, key=lambda l: -phased[l.name]), phased, phased_after,
                                          max_parallel, budget_mb)
    legacy_wall, phased_wall = _wall(legacy_finish), _wall(phased_finish)
    legacy_group3, phased_group3 = _wall(legacy_finish, group3), _wall(phased_finish, group3)
    lanes_out: dict[str, dict] = {}
    for lane in simulated:
        entry = {"loaded_s": loaded[lane.name], "phased_s": phased[lane.name],
                 "source": (estimates.get(lane.name) or {}).get("source")}
        if lane.phase:
            entry["phase"] = lane.phase
        lanes_out[lane.name] = entry
    return {"legacy_union_wall_s": legacy_wall, "phased_union_wall_s": phased_wall,
            "delta_s": round(legacy_wall - phased_wall, 1), "phases": phases,
            "group3": {"legacy_union_wall_s": legacy_group3, "phased_union_wall_s": phased_group3,
                       "delta_s": round(legacy_group3 - phased_group3, 1)},
            "lanes": lanes_out,
            "unmeasured_isolated": unmeasured,
            "note": "phased uses recorded isolated durations only where a lane has run alone; UNMEASURED lanes "
                    "keep their loaded median as an upper bound, so the phased wall is a bound, not a measurement"}


def _history(state_dir: Path) -> list[dict]:
    """Every archived receipt of this state dir, oldest first."""
    receipts: list[dict] = []
    try:
        lines = (state_dir / "history.jsonl").read_text().splitlines()
    except OSError:
        return receipts
    for line in lines:
        try:
            receipt = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(receipt, dict):
            receipts.append(receipt)
    return receipts


def _archive(state_dir: Path, receipt: dict) -> None:
    with (state_dir / "history.jsonl").open("a") as handle:
        handle.write(json.dumps(receipt, sort_keys=True) + "\n")


def _lane_failure_class(receipt: dict, name: str) -> str:
    """The run-deploy-stage failure class recorded for a failed lane."""
    lane = receipt.get("lanes", {}).get(name, {})
    fallback = f"exit-{lane.get('exit')}" if lane.get("exit") is not None else "unknown"
    run_dir = receipt.get("stage_run_dir")
    started = lane.get("started_epoch")
    if not run_dir or started is None:
        return fallback
    best: dict | None = None
    for row in deploy_stage_wait._rows(Path(run_dir)):
        if row.get("stage") != name:
            continue
        try:
            row_started = float(row.get("started_epoch") or 0)
        except (TypeError, ValueError):
            continue
        if abs(row_started - float(started)) <= 5.0 and (best is None or row_started > best["_t"]):
            best = {"_t": row_started, "row": row}
    if best is None:
        return fallback
    detail = best["row"].get("detail") or {}
    outcome = detail.get("outcome") or {}
    return str(outcome.get("failure_class") or fallback)


def fix_loop_state(receipts: list[dict], cap: int) -> dict:
    """Consecutive completed failed rounds, with their failure classes.

    Superseded, stale and capped receipts never count as a round: nothing
    ran to completion on those bytes. A passed round or an ``after_rca``
    acknowledgement restarts the count.
    """
    rounds = 0
    classes: dict[str, list[str]] = {}
    rca_ref: str | None = None
    for receipt in receipts:
        loop = receipt.get("fix_loop") or {}
        if loop.get("rca_ack"):
            # Only the run started with --after-rca restarts the count; later
            # receipts carry the reference for telemetry without resetting.
            rounds = 0
            classes = {}
            rca_ref = str(loop.get("rca_ref"))
        if receipt.get("status") == "passed":
            rounds = 0
            classes = {}
            continue
        if receipt.get("status") != "failed" or receipt.get("interrupted") or receipt.get("refused"):
            continue  # a signalled run, or a launch refused by the owner-run preflight, never completed a round
        rounds += 1
        for name in sorted(_failed_lanes(receipt)):
            classes.setdefault(name, []).append(_lane_failure_class(receipt, name))
    return {"cap": cap, "failed_rounds": rounds, "classes": classes, "rca_ref": rca_ref,
            "rca_ack": False, "capped": bool(cap) and rounds >= cap}


def _terminate_lanes(processes: dict[str, subprocess.Popen[bytes]], signum: int) -> list[str]:
    """Signal every running lane's process group; return the lanes signalled."""
    signalled: list[str] = []
    for name, process in processes.items():
        if process.returncode is None:
            try:
                os.killpg(process.pid, signum)
            except ProcessLookupError:
                continue
            signalled.append(name)
    return signalled


# ── Lane teardown ─────────────────────────────────────────────────────────────
# A lane runs in its own session and is signalled as a process group, but the
# smoke lane's chain (run-predeploy-local → run-bench --local →
# benchmarks/local.py → ``run.sh --benchmark``) starts the isolated stack and
# the benchmark runner in sessions of their own, so a group TERM never reaches
# them. Twice on 2026-10-30 (#1640 attempts 1 and 4) a superseded smoke lane
# left ``run.sh --benchmark`` and its live owner records
# (``.context/benchmarks/<run>/local-stack-owner.json`` and
# ``local-benchmark-owner.json``) behind; the semantic-latency gate then blocked
# in wait_for_isolated_benchmarks (3600 s) until a human TERMed them.
#
# Every lane therefore carries a unique token in its environment (the same
# ``LANE_TOKEN_ENV`` the stage row echoes as ``detail.lane_token``). A process is
# lane-owned when its environment carries the token or a live parent chain
# leads to one that does; nothing else (no name pattern, no port, no cwd) makes
# a process a target. After a terminated lane's wrapper exits, the supervisor:
#
# 1. waits (bounded, ``wait``) for the lane-owned pid of every owner record
#    under the benchmark context root to exit on its own;
# 2. TERMs once the benchmarks/local.py controller of each surviving run (the
#    pid its generated run id embeds) while it lives — it owns the cleanup —
#    and only a run without a live controller gets the TERM on the exact owner
#    pid itself (a run.sh already tearing down ignores the repeated signal, one
#    that never got a signal starts its cleanup). Bash wrappers above the
#    controller are never targets: TERMing them would only orphan it;
# 3. then waits at least the controller's own published shutdown budget
#    (``local_worker_supervisor.py --shutdown-timeout``, the same producer
#    local.py uses for its stack cleanup: WORKER_SHUTDOWN_GRACE_PERIOD + the
#    recording finalize timeout + 30 s, 2175 s by default, plus a margin), and
#    SIGKILLs the surviving lane-owned processes as the documented last resort
#    only when the run shows no progress for a whole ``wait`` bound: no owned
#    process exited and no owner record or ``local-stack-cleanup.status``
#    receipt changed. A draining stack that keeps publishing progress is left
#    to finish up to a hard ceiling of twice that budget.
#
# A record whose pid is alive but not lane-owned is foreign (another deploy,
# another run-bench task, a reused pid): it is reported in the receipt and
# never signalled. A lane-owned process the supervisor may not signal (a root
# child reached through the parent chain) is recorded as ``eperm`` and left.
OWNER_RECORD_NAMES = ("local-stack-owner.json", "local-benchmark-owner.json")
STACK_MANIFEST_NAME = "services.json"
STACK_CLEANUP_STATUS_NAME = "local-stack-cleanup.status"
# A generated run id embeds its benchmarks/local.py controller pid (see
# scripts/lib/isolated-benchmarks.sh), which covers the bootstrap before any
# owner record exists and names the process that owns the run's cleanup.
GENERATED_RUN_ID = re.compile(r"\d+-(\d+)-\d+")
CONTROLLER_RECORD_KIND = "run-id-controller"
TEARDOWN_WAIT_ENV = "DEPLOY_PIPELINE_TEARDOWN_WAIT_SECONDS"
DEFAULT_TEARDOWN_WAIT_SECONDS = 120.0
TEARDOWN_KILL_AFTER_ENV = "DEPLOY_PIPELINE_TEARDOWN_KILL_AFTER_SECONDS"
# agents/scripts/local_worker_supervisor.py --shutdown-timeout with its defaults
# (2100 + 45 + 30); used only when that producer cannot be asked.
DEFAULT_CONTROLLER_SHUTDOWN_SECONDS = 2175.0
TEARDOWN_KILL_AFTER_MARGIN_SECONDS = 120.0
SHUTDOWN_BUDGET_SCRIPT = ROOT / "agents" / "scripts" / "local_worker_supervisor.py"
TEARDOWN_KILL_WAIT_SECONDS = 10.0
TEARDOWN_POLL_SECONDS = 0.5
# Owner records older than this before the lane started cannot be its own.
TEARDOWN_RECORD_SLACK_SECONDS = 1.0
TEARDOWN_LAST_RESORT_NOTE = (
    "last resort: SIGKILL every surviving lane-owned process after the controller's shutdown budget "
    "passed with no progress; a run-owned database or Docker container may remain, reconcile with "
    "`scripts/run-bench --local --run-id <run> --reconcile-cleanup`"
)


def benchmark_context_root() -> Path:
    """Where benchmarks/local.py writes a run's owner records for this checkout."""
    return ROOT / ".context" / "benchmarks"


def _seconds_env(name: str, default: float | None) -> float | None:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be a number of seconds: {raw!r}") from error
    if value < 0:
        raise ValueError(f"{name} must not be negative: {raw!r}")
    return value


def teardown_wait_seconds() -> float:
    value = _seconds_env(TEARDOWN_WAIT_ENV, DEFAULT_TEARDOWN_WAIT_SECONDS)
    assert value is not None
    return value


def controller_shutdown_budget_seconds() -> tuple[float, str]:
    """(seconds, source): the stack controller's published cleanup budget, read
    from the same producer benchmarks/local.py uses; the documented default
    when that producer cannot be asked."""
    try:
        result = subprocess.run(
            [sys.executable, str(SHUTDOWN_BUDGET_SCRIPT), "--shutdown-timeout"],
            cwd=SHUTDOWN_BUDGET_SCRIPT.parent.parent, capture_output=True, text=True, timeout=5, check=True,
        )
        seconds = float(int(result.stdout.strip()))
    except (OSError, ValueError, subprocess.SubprocessError):
        return DEFAULT_CONTROLLER_SHUTDOWN_SECONDS, "default"
    if seconds <= 0:
        return DEFAULT_CONTROLLER_SHUTDOWN_SECONDS, "default"
    return seconds, "local_worker_supervisor.py --shutdown-timeout"


def teardown_kill_after_override() -> tuple[float, str] | None:
    """The explicit ``DEPLOY_PIPELINE_TEARDOWN_KILL_AFTER_SECONDS`` bound, validated."""
    override = _seconds_env(TEARDOWN_KILL_AFTER_ENV, None)
    return None if override is None else (override, TEARDOWN_KILL_AFTER_ENV)


def teardown_kill_after_seconds() -> tuple[float, str]:
    """(seconds after the TERM before the last resort may run, source). The
    producer is asked only when a teardown actually has survivors."""
    override = teardown_kill_after_override()
    if override is not None:
        return override
    budget, source = controller_shutdown_budget_seconds()
    return budget + TEARDOWN_KILL_AFTER_MARGIN_SECONDS, f"{source} + {TEARDOWN_KILL_AFTER_MARGIN_SECONDS:.0f}s margin"


def _proc_processes(proc: Path) -> dict[int, dict]:
    """``{pid: {"ppid", "comm", "start"}}`` for every live process /proc lists now."""
    processes: dict[int, dict] = {}
    try:
        entries = os.listdir(proc)
    except OSError:
        return processes
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            stat = (proc / entry / "stat").read_text()
        except OSError:
            continue  # exited between listdir and read
        try:
            close = stat.rindex(")")
            comm = stat[stat.index("(") + 1:close]
            fields = stat[close + 2:].split()
            if fields[0] in ("Z", "X"):
                continue  # a zombie or dead process holds nothing and never exits further
            # fields[0] is the state; ppid and starttime are /proc stat fields 4 and 22.
            processes[int(entry)] = {"ppid": int(fields[1]), "comm": comm, "start": int(fields[19])}
        except (IndexError, ValueError):
            continue
    return processes


def _carries_lane_token(proc: Path, pid: int, token: str) -> bool:
    try:
        environ = (proc / str(pid) / "environ").read_bytes()
    except OSError:
        return False  # exited, or a process whose environment we may not read
    return f"{LANE_TOKEN_ENV}={token}".encode() in environ.split(b"\0")


def lane_owned_processes(token: str, proc: Path | None = None,
                         cache: dict[tuple[int, int], bool] | None = None) -> tuple[dict[int, dict], dict[int, dict]]:
    """(lane-owned live processes, every live process), both ``{pid: info}``.

    A process is lane-owned when its environment carries the lane token or a
    live parent chain leads to one that does (a child whose environment was
    scrubbed or cannot be read). ``cache`` remembers the token check per
    (pid, start time) so a poll loop reads each process's environment once; a
    reused pid has a new start time and is checked again.
    """
    proc = PROC_ROOT if proc is None else proc
    cache = {} if cache is None else cache
    processes = _proc_processes(proc)
    owned: dict[int, dict] = {}
    for pid, info in processes.items():
        key = (pid, info["start"])
        if key not in cache:
            cache[key] = _carries_lane_token(proc, pid, token)
        if cache[key]:
            owned[pid] = {**info, "token": True}
    children: dict[int, list[int]] = {}
    for pid, info in processes.items():
        children.setdefault(info["ppid"], []).append(pid)
    stack = list(owned)
    while stack:
        for child in children.get(stack.pop(), []):
            if child not in owned:
                owned[child] = {**processes[child], "token": False}
                stack.append(child)
    return owned, processes


def _record_pid(payload: object, field: str) -> int | None:
    if not isinstance(payload, dict):
        return None
    pid = payload.get(field)
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    return pid


def _cleanup_status_state(path: Path) -> str | None:
    for line in path.read_text().splitlines():
        key, separator, value = line.partition("=")
        if separator and key == "state":
            return value.strip()
    return None


def lane_owner_records(context_root: Path, since_epoch: float) -> tuple[list[dict], int]:
    """Owner records (stack, benchmark, manifest, cleanup status, generated
    run-id controller) under ``context_root`` modified since ``since_epoch``,
    and the count of older run directories left out: a record written before
    the lane started cannot be the lane's own. Ownership itself is decided by
    the lane token."""
    records: list[dict] = []
    older = 0
    if not context_root.is_dir():
        return records, older
    for run_dir in sorted(context_root.iterdir()):
        if run_dir.is_symlink() or not run_dir.is_dir():
            continue
        found: list[dict] = []
        for name in (*OWNER_RECORD_NAMES, STACK_MANIFEST_NAME, STACK_CLEANUP_STATUS_NAME):
            path = run_dir / name
            if path.is_symlink() or not path.is_file():
                continue
            try:
                modified = path.stat().st_mtime
                if name == STACK_CLEANUP_STATUS_NAME:
                    found.append({"path": str(path), "run_id": run_dir.name, "kind": name, "pid": None,
                                  "modified_epoch": modified, "state": _cleanup_status_state(path)})
                    continue
                payload = json.loads(path.read_text())
            except (OSError, ValueError):
                found.append({"path": str(path), "run_id": run_dir.name, "kind": name, "pid": None,
                              "modified_epoch": None, "note": "unreadable"})
                continue
            record = {"path": str(path), "run_id": run_dir.name, "kind": name,
                      "pid": _record_pid(payload, "run_sh_pid" if name == STACK_MANIFEST_NAME else "pid"),
                      "modified_epoch": modified}
            if name == STACK_MANIFEST_NAME and isinstance(payload, dict):
                record["manifest_status"] = payload.get("status")
            if name == "local-benchmark-owner.json" and isinstance(payload, dict):
                record["state"] = payload.get("state")
            found.append(record)
        generated = GENERATED_RUN_ID.fullmatch(run_dir.name)
        try:
            dir_modified = run_dir.stat().st_mtime
        except OSError:
            continue
        if generated:
            found.append({"path": str(run_dir), "run_id": run_dir.name, "kind": CONTROLLER_RECORD_KIND,
                          "pid": int(generated.group(1)), "modified_epoch": dir_modified})
        recent = [r for r in found if r["modified_epoch"] is None
                  or r["modified_epoch"] >= since_epoch - TEARDOWN_RECORD_SLACK_SECONDS]
        if found and not recent:
            older += 1
        records.extend(recent)
    return records, older


def _classify_records(records: list[dict], owned: dict[int, dict], processes: dict[int, dict]) -> None:
    for record in records:
        pid = record["pid"]
        if record["kind"] == STACK_CLEANUP_STATUS_NAME:
            record["status"] = "receipt"
        elif pid is None:
            record["status"] = "unreadable"
        elif pid in owned:
            record["status"] = "owned"
            record["comm"] = owned[pid]["comm"]
        elif pid in processes:
            record["status"] = "foreign"
            record["comm"] = processes[pid]["comm"]
        else:
            record["status"] = "exited"


def _escalation_targets(records: list[dict], alive: list[int]) -> list[int]:
    """One TERM target per surviving owner: its run's live lane-owned controller
    (the pid the generated run id embeds) while it lives, because it owns the
    cleanup; the exact owner pid only when no controller is left. Never a bash
    wrapper above the controller."""
    controllers = {r["run_id"]: r["pid"] for r in records
                   if r["kind"] == CONTROLLER_RECORD_KIND and r["status"] == "owned"}
    targets: list[int] = []
    for pid in alive:
        runs = {r["run_id"] for r in records if r["pid"] == pid and r["status"] == "owned"}
        target = next((controllers[run] for run in sorted(runs) if run in controllers), pid)
        if target not in targets:
            targets.append(target)
    return targets


def _signal_pids(pids: list[int], owned: dict[int, dict], signum: int) -> list[dict]:
    signalled: list[dict] = []
    for pid in pids:
        entry = {"pid": pid, "comm": owned.get(pid, {}).get("comm"), "signal": signal.Signals(signum).name}
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            continue
        except PermissionError:
            # Lane-owned through the parent chain but not ours to signal (a
            # root child of setup-db.sh): recorded, left alone, never fatal.
            entry["error"] = "eperm"
        signalled.append(entry)
    return signalled


def _teardown_progress(records: list[dict], owned: dict[int, dict]) -> tuple:
    """What a draining run changes while it makes progress: the set of live
    lane-owned processes and every owner/cleanup receipt's modification time
    and state."""
    return (tuple(sorted(owned)),
            tuple((r["path"], r["modified_epoch"], r.get("state")) for r in records))


def teardown_lane(name: str, *, attempt: int, token: str, started_epoch: float, state_dir: Path,
                  wait_seconds: float | None = None, kill_after: tuple[float, str] | None = None,
                  context_root: Path | None = None, proc: Path | None = None,
                  kill_wait_seconds: float = TEARDOWN_KILL_WAIT_SECONDS,
                  poll_seconds: float = TEARDOWN_POLL_SECONDS, reconcile_runs: bool = True) -> dict:
    """Wait for, then reap, every stack/benchmark owner the terminated lane left
    behind (see the section comment) and write the receipt to
    ``<state_dir>/teardown/attempt-<attempt>-<lane>.json``.

    ``reconcile_runs=False`` leaves the lane's run directories in place for a
    caller with its own sealed recovery protocol (the staged deploy cycle's
    interrupted-worker recovery binds them by path); signalling is unchanged."""
    wait_seconds = teardown_wait_seconds() if wait_seconds is None else wait_seconds
    context_root = benchmark_context_root() if context_root is None else context_root
    started = time.monotonic()
    cache: dict[tuple[int, int], bool] = {}
    receipt: dict = {
        "schema_version": 2, "lane": name, "attempt": attempt, "token": token, "started_at": _now(),
        "lane_started_epoch": started_epoch, "context_root": str(context_root), "wait_seconds": wait_seconds,
        "kill_after_seconds": None, "kill_after_source": "not needed",
        "phases": [], "records": [], "older_run_dirs": 0, "owned": [], "foreign": [], "lingering": [],
    }
    # Classifications accumulate: the final observation sees a reaped owner as
    # exited, but the receipt must still say which records were the lane's own.
    owned_seen: dict[int, dict] = {}
    foreign_seen: dict[int, dict] = {}

    def observe() -> tuple[list[dict], list[int], dict[int, dict]]:
        # Liveness first, records second: a controller that publishes its
        # clean receipt and exits between the two reads is then reported with
        # that receipt, never with the stale pending one read before it exited.
        owned, processes = lane_owned_processes(token, proc, cache)
        records, older = lane_owner_records(context_root, started_epoch)
        _classify_records(records, owned, processes)
        receipt["records"], receipt["older_run_dirs"] = records, older
        for record in records:
            seen = {"owned": owned_seen, "foreign": foreign_seen}.get(record["status"])
            if seen is not None and record["pid"] not in seen:
                seen[record["pid"]] = {key: record[key] for key in ("pid", "comm", "path", "run_id", "kind")}
        receipt["owned"] = [owned_seen[pid] for pid in sorted(owned_seen)]
        receipt["foreign"] = [foreign_seen[pid] for pid in sorted(foreign_seen)]
        alive = sorted({record["pid"] for record in records if record["status"] == "owned"})
        return records, alive, owned

    def wait_until(deadline: float) -> tuple[list[dict], list[int], dict[int, dict]]:
        while True:
            records, alive, owned = observe()
            if not alive or time.monotonic() >= deadline:
                return records, alive, owned
            time.sleep(poll_seconds)

    def phase(label: str, alive: list[int], since: float, **extra: object) -> None:
        receipt["phases"].append({"phase": label, "seconds": round(time.monotonic() - since, 2),
                                  "survivors": alive, **extra})

    since = time.monotonic()
    first_alive = observe()[1]
    records, alive, owned = wait_until(since + wait_seconds)
    phase("wait", alive, since)
    outcome = "exited" if first_alive else "clean"
    if alive:
        kill_after_seconds, kill_after_source = teardown_kill_after_seconds() if kill_after is None else kill_after
        receipt.update(kill_after_seconds=kill_after_seconds, kill_after_source=kill_after_source)
        since = time.monotonic()
        signalled = _signal_pids(_escalation_targets(records, alive), owned, signal.SIGTERM)
        fingerprint, last_progress = _teardown_progress(records, owned), since
        stall: str | None = None
        while True:
            records, alive, owned = observe()
            if not alive:
                break
            now = time.monotonic()
            current = _teardown_progress(records, owned)
            if current != fingerprint:
                fingerprint, last_progress = current, now
            if now - since >= kill_after_seconds and now - last_progress >= wait_seconds:
                stall = "no progress for a whole wait bound after the controller's shutdown budget"
                break
            if now - since >= 2 * kill_after_seconds:
                stall = "hard ceiling: twice the controller's shutdown budget"
                break
            time.sleep(poll_seconds)
        phase("term", alive, since, signalled=signalled,
              last_progress_age_s=round(time.monotonic() - last_progress, 2), stall=stall)
        outcome = "terminated"
        if alive:
            since = time.monotonic()
            killed = _signal_pids(sorted(owned), owned, signal.SIGKILL)
            records, alive, owned = wait_until(since + kill_wait_seconds)
            phase("kill", alive, since, signalled=killed, note=TEARDOWN_LAST_RESORT_NOTE)
            outcome = "killed" if not alive else "failed"
    receipt["lingering"] = [{"pid": pid, "comm": info["comm"]} for pid, info in sorted(owned.items())]
    # The lane's own run directories (records written since it started): an
    # aborted one (stopped before its controller bound a pid) is set aside now
    # so no later launch preflight trips over its pid-less record; a run still
    # inside the bootstrap grace is left for the next attempt's preflight.
    receipt["owner_runs"] = reconcile_owner_runs(
        context_root, state_dir, stage=f"attempt-{attempt}-teardown-{name}", proc=proc,
        run_ids={record["run_id"] for record in records}) if reconcile_runs else {
        "skipped": "caller owns run-directory reconciliation"}
    receipt.update(outcome=outcome, survivors=alive, finished_at=_now(),
                   wall_s=round(time.monotonic() - started, 2))
    path = state_dir / "teardown" / f"attempt-{attempt}-{name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    write_receipt(path, receipt)
    receipt["receipt"] = str(path)
    return receipt


def _teardown_summary(receipt: dict) -> dict:
    signalled = [s for p in receipt["phases"] for s in p.get("signalled", [])]
    return {
        "outcome": receipt["outcome"], "receipt": receipt["receipt"], "wall_s": receipt["wall_s"],
        "owned_pids": sorted({r["pid"] for r in receipt["owned"]} | {s["pid"] for s in signalled}),
        "foreign_pids": sorted({r["pid"] for r in receipt["foreign"]}),
        "survivors": receipt["survivors"],
        "escalated": [s["pid"] for p in receipt["phases"] if p["phase"] == "term" for s in p["signalled"]],
        "killed": [s["pid"] for p in receipt["phases"] if p["phase"] == "kill" for s in p["signalled"]],
        "eperm": sorted({s["pid"] for s in signalled if s.get("error") == "eperm"}),
        "set_aside": [run["run_id"] for run in receipt.get("owner_runs", {}).get("set_aside", [])],
        "owner_runs": {run["run_id"]: run["classification"]
                       for run in receipt.get("owner_runs", {}).get("runs", [])},
    }


def _teardown_log_line(attempt: int, name: str, summary: dict) -> str:
    def pids(values: list[int]) -> str:
        return ",".join(str(v) for v in values) or "-"

    return (f"PIPELINE_LANE_TEARDOWN attempt={attempt} lane={name} outcome={summary['outcome']} "
            f"owned={pids(summary['owned_pids'])} foreign={pids(summary['foreign_pids'])} "
            f"escalated={pids(summary['escalated'])} killed={pids(summary['killed'])} "
            f"eperm={pids(summary['eperm'])} survivors={pids(summary['survivors'])} "
            f"set_aside={','.join(summary.get('set_aside', [])) or '-'} "
            f"wall_s={summary['wall_s']} receipt={summary['receipt']}")

# ── Owner-run classification ──────────────────────────────────────────────────
# An isolated benchmark run that was stopped before its controller started
# leaves a pid-less owner record behind: ``local-benchmark-owner.json`` with
# ``"state": "not_started", "pid": null`` (benchmarks/local.py writes it before
# the benchmark child binds) and/or a ``local-stack-owner.json`` without a
# positive pid. Twice on 2026-10-31 (deploy-5 round 1, PR #1655 round 2) a
# launch preflight refused the whole deploy on such a record ("no positive
# integer pid in …") until a human moved the directory to
# ``.context/benchmarks/_aborted/``. Every reader of these records now shares
# one classification, per run directory:
#
#   live           an owner pid alive with its recorded native identity (or an
#                  identity that cannot be read), the run id's controller
#                  (``benchmarks/local.py``) or a starting/running manifest's
#                  ``run.sh``, or any process carrying the run id: a
#                  ``BENCHMARK_RUN_ID`` environment entry, a ``--run-id`` on
#                  its command line (a custom id cannot embed the controller
#                  pid), or, when its environment cannot be read, a command
#                  line naming the run
#   finished       owners were recorded with pids and none lives (reused pids
#                  with another identity count as exited)
#   bootstrapping  no owner pid yet, the newest file under the run is younger
#                  than the bootstrap grace (``BENCHMARK_STARTUP_GRACE_SECONDS``,
#                  the same window run.sh and kill-services.sh protect, 90 s by
#                  default) and nothing shows the bootstrap ended: protected
#   aborted        no owner pid, no process carries the run id, the run is
#                  older than the grace (or its manifest shows the bootstrap is
#                  over) and it left no manifest at all or a ``clean`` cleanup
#                  receipt: nothing remains to reconcile
#   stranded       like aborted, but a manifest exists without a clean cleanup
#                  receipt (run.sh killed mid-bootstrap or mid-EXIT trap, the
#                  teardown's own SIGKILL): reported and left in place so
#                  ``scripts/run-bench --local --run-id <id> --reconcile-cleanup``
#                  still finds its owner record where the teardown note says
#   unknown        a record cannot be read, the context root is a symlink, or
#                  the process table is unavailable (non-Linux, /proc cannot be
#                  listed): fail closed, never signal, never set aside
#
# The launch preflight (every attempt, before any lane starts) and the lane
# teardown set ``aborted`` runs aside under ``_aborted/`` (renamed after a
# fresh re-classification, never deleted, with the classification written
# beside the evidence) and append a line to ``<state-dir>/owner-runs.jsonl``.
# The preflight acts only on this deploy's own runs (those its earlier lane
# teardowns named); another session's run-bench --local under this checkout
# is classified and reported, never renamed and never waited on. A
# ``bootstrapping`` own run makes the preflight wait for the grace to pass;
# any ``unknown`` run refuses the launch. Only this checkout's
# ``.context/benchmarks`` is ever read or renamed. The shell readers
# (kill-services.sh ``load_live_isolated_runs``, run.sh
# ``pid_belongs_to_active_isolated_benchmark``, isolated-benchmarks.sh
# ``live_isolated_benchmark_runs``) already treat pid-less records as not live
# and protect the same grace window; they keep their own narrower sweeps.
OWNER_RUN_LIVE = "live"
OWNER_RUN_FINISHED = "finished"
OWNER_RUN_ABORTED = "aborted"
OWNER_RUN_STRANDED = "stranded"
OWNER_RUN_BOOTSTRAPPING = "bootstrapping"
OWNER_RUN_UNKNOWN = "unknown"
OWNER_RUN_CLASSES = (OWNER_RUN_LIVE, OWNER_RUN_FINISHED, OWNER_RUN_ABORTED, OWNER_RUN_STRANDED,
                     OWNER_RUN_BOOTSTRAPPING, OWNER_RUN_UNKNOWN)
STACK_OWNER_NAME = "local-stack-owner.json"
BENCHMARK_OWNER_NAME = "local-benchmark-owner.json"
ABORTED_RUNS_DIR = "_aborted"
ABORTED_RUN_MARK_NAME = "aborted-by-deploy-pipeline.json"
OWNER_RUNS_RECEIPT_NAME = "owner-runs.jsonl"
BENCHMARK_RUN_ID_ENV = "BENCHMARK_RUN_ID"
BOOTSTRAP_GRACE_ENV = "BENCHMARK_STARTUP_GRACE_SECONDS"
DEFAULT_BOOTSTRAP_GRACE_SECONDS = 90.0
OWNER_RUNS_POLL_SECONDS = 1.0
OWNER_RUN_SCAN_LIMIT = 20000
PROCESS_IDENTITY_SCRIPT = ROOT / "scripts" / "process-identity.py"
LIVE_MANIFEST_STATUSES = {"starting", "running"}


def bootstrap_grace_seconds() -> float:
    """The isolated-stack startup grace (same variable and validation as
    kill-services.sh / run.sh): a run without a manifest is protected this long."""
    raw = os.environ.get(BOOTSTRAP_GRACE_ENV, "")
    if re.fullmatch(r"0|[1-9][0-9]{0,4}", raw):
        return float(raw)
    return DEFAULT_BOOTSTRAP_GRACE_SECONDS


class OwnerRunVanished(Exception):
    """The run directory disappeared while it was being classified: a
    concurrent cleanup removed it after ``is_dir()`` succeeded."""


def _raise_if_run_vanished(run_dir: Path, error: OSError) -> None:
    """A ``FileNotFoundError`` while reading a run means the run vanished only
    when the run directory itself is confirmed gone (``lstat`` -> ENOENT).
    Any other error (EACCES, ...) or a missing file under a directory that
    still exists keeps the caller's fail-closed ``unknown`` path."""
    if not isinstance(error, FileNotFoundError):
        return
    try:
        os.lstat(run_dir)
    except FileNotFoundError:
        raise OwnerRunVanished(str(run_dir)) from error
    except OSError:
        return


def _read_json_record(path: Path, *, run_dir: Path | None = None) -> tuple[dict | None, str | None]:
    """(payload, error): (None, None) when absent; an error names why it is
    unreadable. With ``run_dir``, a read that fails because that run directory
    vanished raises ``OwnerRunVanished`` instead."""
    if path.is_symlink():
        return None, "symlink"
    if not path.is_file():
        return None, None
    try:
        payload = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        if run_dir is not None and isinstance(error, OSError):
            _raise_if_run_vanished(run_dir, error)
        return None, f"unreadable ({type(error).__name__})"
    if not isinstance(payload, dict):
        return None, "not a JSON object"
    return payload, None


def _newest_mtime(run_dir: Path) -> float:
    """The newest modification time of the run directory or anything under it
    (bounded walk, symlinks not followed): a bootstrap still writing logs is
    young even when its owner records are not."""
    newest = run_dir.stat().st_mtime
    pending = [run_dir]
    seen = 0
    while pending and seen < OWNER_RUN_SCAN_LIMIT:
        current = pending.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            seen += 1
            try:
                newest = max(newest, entry.stat(follow_symlinks=False).st_mtime)
                if entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))
            except OSError:
                continue
    return newest


def _proc_cmdline(proc: Path, pid: int) -> str:
    try:
        raw = (proc / str(pid) / "cmdline").read_bytes()
    except OSError:
        return ""
    return raw.replace(b"\0", b" ").decode("utf-8", "replace").strip()


def _owner_run_process_table(proc: Path) -> dict[int, dict] | None:
    """Every live process, or ``None`` when the table cannot be read (another
    platform's real /proc, or a /proc that cannot be listed): like the memory
    sampler, an unreadable table makes every run unknown, never finished."""
    if sys.platform != "linux" and proc == PROC_ROOT:
        return None
    try:
        os.listdir(proc)
    except OSError:
        return None
    return _proc_processes(proc)


def benchmark_run_id_carriers(proc: Path, processes: dict[int, dict], run_ids) -> dict[str, list[int]]:
    """``{run_id: [pids]}`` for every live process that carries one of
    ``run_ids``: a ``BENCHMARK_RUN_ID`` environment entry (local.py exports it
    to run.sh and to every child it starts after writing the owner record), a
    ``--run-id <run_id>`` on the command line (a benchmarks/local.py controller
    with a custom id cannot embed its pid in the id, and a runtime
    ``os.environ`` write never reaches /proc/<pid>/environ), or, when the
    environment cannot be read (EACCES), a world-readable command line naming
    the run id (its context directory, a log path)."""
    needle = f"{BENCHMARK_RUN_ID_ENV}=".encode()
    wanted = set(run_ids)
    carriers: dict[str, list[int]] = {}
    for pid in sorted(processes):
        found: set[str] = set()
        try:
            environ: bytes | None = (proc / str(pid) / "environ").read_bytes()
        except OSError:
            environ = None
        if environ is not None:
            for entry in environ.split(b"\0"):
                if entry.startswith(needle):
                    found.add(entry[len(needle):].decode("utf-8", "replace"))
        cmdline = _proc_cmdline(proc, pid)
        if cmdline:
            for run_id in wanted:
                if f"--run-id {run_id}" in cmdline or f"--run-id={run_id}" in cmdline:
                    found.add(run_id)
                elif environ is None and run_id in cmdline:
                    found.add(run_id)
        for run_id in found & wanted:
            carriers.setdefault(run_id, []).append(pid)
    return carriers


def native_process_identity(pid: int) -> str:
    """scripts/process-identity.py's birth identity of a live pid; "" when it
    cannot be read (exited, unreadable, or no helper beside this driver)."""
    try:
        tools = runpy.run_path(str(PROCESS_IDENTITY_SCRIPT))
        identity = tools["current_identity"](pid)
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, SyntaxError):
        return ""
    return identity if isinstance(identity, str) else ""


VANISHED_RUN_REASON = ("run directory vanished during classification (removed concurrently): "
                       "nothing left to set aside")


def classify_owner_run(run_dir: Path, *, proc: Path, processes: dict[int, dict] | None,
                       carriers: dict[str, list[int]], identity_of, now: float, grace_seconds: float) -> dict | None:
    """One isolated run directory -> ``{"run_id", "path", "classification",
    "reason", "pids", "age_s", "records"}``; ``None`` for a directory that is
    not a run (no owner record, no manifest, no generated run id).
    ``processes is None`` (unavailable table) makes every run unknown. A run
    directory that vanishes while it is being read (a concurrent cleanup
    removed it after ``is_dir()`` succeeded) is ``finished``: reported, never
    ``unknown``, so one concurrent cleanup cannot refuse a launch."""
    try:
        return _classify_present_owner_run(run_dir, proc=proc, processes=processes, carriers=carriers,
                                           identity_of=identity_of, now=now, grace_seconds=grace_seconds)
    except OwnerRunVanished:
        return {"run_id": run_dir.name, "path": str(run_dir), "classification": OWNER_RUN_FINISHED,
                "reason": VANISHED_RUN_REASON, "pids": [], "age_s": None, "records": []}


def _classify_present_owner_run(run_dir: Path, *, proc: Path, processes: dict[int, dict] | None,
                                carriers: dict[str, list[int]], identity_of, now: float,
                                grace_seconds: float) -> dict | None:
    """``classify_owner_run`` for a run directory that is present; raises
    ``OwnerRunVanished`` when the directory disappears mid-classification."""
    run_id = run_dir.name
    result: dict = {"run_id": run_id, "path": str(run_dir), "classification": OWNER_RUN_UNKNOWN,
                    "reason": "", "pids": [], "age_s": None, "records": []}
    if run_dir.is_symlink() or not run_dir.is_dir():
        return None
    generated = GENERATED_RUN_ID.fullmatch(run_id)
    try:
        newest = _newest_mtime(run_dir)
    except OSError as error:
        _raise_if_run_vanished(run_dir, error)
        result["reason"] = f"run dir unreadable ({type(error).__name__})"
        return result
    payloads: dict[str, dict | None] = {}
    errors: list[str] = []
    for name in (STACK_OWNER_NAME, BENCHMARK_OWNER_NAME, STACK_MANIFEST_NAME):
        payload, error = _read_json_record(run_dir / name, run_dir=run_dir)
        payloads[name] = payload
        if error:
            errors.append(f"{name}: {error}")
        elif payload is not None:
            result["records"].append(name)
    cleanup_state: str | None = None
    cleanup_path = run_dir / STACK_CLEANUP_STATUS_NAME
    if cleanup_path.is_symlink():
        errors.append(f"{STACK_CLEANUP_STATUS_NAME}: symlink")
    elif cleanup_path.is_file():
        try:
            cleanup_state = _cleanup_status_state(cleanup_path)
            result["records"].append(STACK_CLEANUP_STATUS_NAME)
        except OSError as error:
            _raise_if_run_vanished(run_dir, error)
            errors.append(f"{STACK_CLEANUP_STATUS_NAME}: unreadable ({type(error).__name__})")
    if not result["records"] and not errors and not generated:
        return None
    result["age_s"] = round(max(0.0, now - newest), 1)
    if errors:
        result["reason"] = "; ".join(errors)
        return result
    if processes is None:
        result["reason"] = "process table unavailable (not Linux, or /proc cannot be listed): fail closed"
        return result
    stack, bench, manifest = payloads[STACK_OWNER_NAME], payloads[BENCHMARK_OWNER_NAME], payloads[STACK_MANIFEST_NAME]
    manifest_status = str(manifest.get("status", "")).strip().lower() if manifest else ""
    manifest_pid = _record_pid(manifest, "run_sh_pid") if manifest else None

    def live(reason: str, pids: list[int]) -> dict:
        result.update(classification=OWNER_RUN_LIVE, reason=reason, pids=sorted(pids))
        return result

    carried = carriers.get(run_id) or []
    if carried:
        return live(f"run id {run_id} carried by live process(es)", carried)
    for name, payload in ((STACK_OWNER_NAME, stack), (BENCHMARK_OWNER_NAME, bench)):
        pid = _record_pid(payload, "pid") if payload else None
        if pid is None or pid not in processes:
            continue
        recorded = payload.get("native_identity") if payload else None
        current = identity_of(pid) if isinstance(recorded, str) and recorded else ""
        if current and current != recorded:
            continue  # the pid was reused by another process instance
        return live(f"{name} pid alive" + (" with matching identity" if current else " (identity unverified)"), [pid])
    if generated:
        controller = int(generated.group(1))
        if controller in processes and "benchmarks/local.py" in _proc_cmdline(proc, controller):
            return live("run-id controller (benchmarks/local.py) alive", [controller])
    if manifest_status in LIVE_MANIFEST_STATUSES and manifest_pid in processes \
            and "run.sh" in _proc_cmdline(proc, manifest_pid):
        return live(f"manifest {manifest_status} with run.sh alive", [manifest_pid])
    bench_state = bench.get("state") if bench else None
    never_started = (
        (bench is not None and (bench_state == "not_started" or _record_pid(bench, "pid") is None))
        or (stack is not None and _record_pid(stack, "pid") is None)
        or (bench is None and stack is None and generated is not None)
    )
    evidence = []
    if bench_state:
        evidence.append(f"benchmark owner state={bench_state}")
    if manifest_status:
        evidence.append(f"manifest status={manifest_status}")
    if cleanup_state:
        evidence.append(f"cleanup state={cleanup_state}")
    if not never_started:
        result.update(classification=OWNER_RUN_FINISHED,
                      reason="recorded owner pids exited" + (f" ({', '.join(evidence)})" if evidence else ""))
        return result
    bootstrap_over = (manifest is not None and (manifest_pid is None or manifest_status == "stopped")) \
        or cleanup_state == "clean"
    detail = f"no owner pid, no process carries the run id, newest file {result['age_s']}s old"
    if result["age_s"] < grace_seconds and not bootstrap_over:
        result.update(classification=OWNER_RUN_BOOTSTRAPPING,
                      reason=f"{detail}, within the {grace_seconds:.0f}s bootstrap grace")
        return result
    why = "bootstrap ended: " + ", ".join(evidence) if bootstrap_over else f"older than the {grace_seconds:.0f}s bootstrap grace"
    if manifest is None or cleanup_state == "clean":
        result.update(classification=OWNER_RUN_ABORTED, reason=f"{detail}, {why}")
        return result
    receipt = "missing" if cleanup_state is None else f"state={cleanup_state}"
    result.update(classification=OWNER_RUN_STRANDED,
                  reason=f"{detail}, {why}; manifest status={manifest_status or '?'} with cleanup receipt {receipt}: "
                         f"left for `scripts/run-bench --local --run-id {run_id} --reconcile-cleanup`")
    return result


def _unknown_root(context_root: Path, reason: str) -> dict:
    return {"run_id": context_root.name, "path": str(context_root), "classification": OWNER_RUN_UNKNOWN,
            "reason": reason, "pids": [], "age_s": None, "records": []}


def classify_owner_runs(context_root: Path, *, proc: Path | None = None, identity_of=None,
                        now: float | None = None, grace_seconds: float | None = None,
                        run_ids: set[str] | None = None) -> list[dict]:
    """Classify every isolated run directory under ``context_root`` (only the
    given ``run_ids`` when set); ``_aborted/`` itself is never a run. A
    symlinked root is one unknown entry (fail closed)."""
    proc = PROC_ROOT if proc is None else proc
    identity_of = native_process_identity if identity_of is None else identity_of
    now = time.time() if now is None else now
    grace_seconds = bootstrap_grace_seconds() if grace_seconds is None else grace_seconds
    if context_root.is_symlink():
        return [_unknown_root(context_root, "context root is a symlink: fail closed")]
    results: list[dict] = []
    if not context_root.is_dir():
        return results
    processes = _owner_run_process_table(proc)
    candidates = [run_dir for run_dir in sorted(context_root.iterdir())
                  if run_dir.name != ABORTED_RUNS_DIR and (run_ids is None or run_dir.name in run_ids)]
    carriers = {} if processes is None else benchmark_run_id_carriers(proc, processes, [d.name for d in candidates])
    for run_dir in candidates:
        result = classify_owner_run(run_dir, proc=proc, processes=processes, carriers=carriers,
                                    identity_of=identity_of, now=now, grace_seconds=grace_seconds)
        if result is not None:
            results.append(result)
    return results


def set_aside_aborted_run(run_dir: Path, context_root: Path, classification: dict) -> Path:
    """Rename an aborted run directory under ``<context_root>/_aborted/`` (same
    filesystem, evidence intact) and write the classification beside it."""
    aside = context_root / ABORTED_RUNS_DIR
    # Keep ``_aborted/`` as old as anything it holds: run.sh and
    # kill-services.sh read any young manifest-less directory under
    # .context/benchmarks as an in-flight bootstrap, and a rename would stamp
    # it with the current time.
    aside_mtime = run_dir.stat().st_mtime
    if aside.is_dir():
        aside_mtime = min(aside_mtime, aside.stat().st_mtime)
    aside.mkdir(exist_ok=True)
    destination = aside / run_dir.name
    if destination.exists() or destination.is_symlink():
        destination = aside / f"{run_dir.name}.{int(time.time())}-{os.getpid()}"
    os.rename(run_dir, destination)
    mark = {**classification, "set_aside_at": _now(), "set_aside_by": f"run_deploy_pipeline pid {os.getpid()}",
            "original_path": str(run_dir)}
    (destination / ABORTED_RUN_MARK_NAME).write_text(json.dumps(mark, indent=1, sort_keys=True) + "\n")
    os.utime(aside, (aside_mtime, aside_mtime))
    return destination


def own_run_ids_from_state(state_dir: Path) -> set[str]:
    """The run ids this state dir's earlier lane teardowns named (their
    receipts' records and classifications, and the teardown rows of
    ``owner-runs.jsonl``): the runs this deploy's own lanes started. Anything
    else under the context root belongs to another session."""
    own: set[str] = set()
    teardown_dir = state_dir / "teardown"
    receipts = sorted(teardown_dir.glob("attempt-*.json")) if teardown_dir.is_dir() else []
    for path in receipts:
        try:
            receipt = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(receipt, dict):
            continue
        rows = list(receipt.get("records") or []) + list((receipt.get("owner_runs") or {}).get("runs") or [])
        own.update(row["run_id"] for row in rows if isinstance(row, dict) and isinstance(row.get("run_id"), str))
    ledger = state_dir / OWNER_RUNS_RECEIPT_NAME
    if ledger.is_file():
        for line in ledger.read_text().splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict) and "-teardown-" in str(row.get("stage")) and isinstance(row.get("run_id"), str):
                own.add(row["run_id"])
    return own


def reconcile_owner_runs(context_root: Path, state_dir: Path, *, stage: str, wait_seconds: float = 0.0,
                         poll_seconds: float = OWNER_RUNS_POLL_SECONDS, run_ids: set[str] | None = None,
                         own_run_ids: set[str] | None = None, proc: Path | None = None, identity_of=None,
                         grace_seconds: float | None = None) -> dict:
    """Classify the runs under ``context_root``, wait (bounded by
    ``wait_seconds``) for this deploy's own ``bootstrapping`` runs to resolve,
    set its own ``aborted`` runs aside (each re-classified immediately before
    the rename) and append every classification to ``<state_dir>/owner-runs.jsonl``.

    ``own_run_ids`` names the runs this deploy may act on; ``None`` means every
    classified run (the lane teardown already restricts ``run_ids`` to the
    lane's own). Returns ``{"stage", "counts", "runs", "set_aside", "foreign",
    "waited_s", "refused"}``: ``refused`` names every ``unknown`` run (fail
    closed) and the own runs still ``bootstrapping`` after the wait; ``live``,
    ``finished``, ``stranded`` and another session's runs are reported and left.
    ``waited_s`` is the time spent waiting on own bootstrapping runs: 0.0 when
    no wait happened, however long a single classification pass took."""
    grace_seconds = bootstrap_grace_seconds() if grace_seconds is None else grace_seconds

    def own(run: dict) -> bool:
        return own_run_ids is None or run["run_id"] in own_run_ids

    def classify(only: set[str] | None) -> list[dict]:
        return classify_owner_runs(context_root, proc=proc, identity_of=identity_of, grace_seconds=grace_seconds,
                                   run_ids=only)

    started = time.monotonic()
    waited = False
    while True:
        runs = classify(run_ids)
        bootstrapping = [run for run in runs if run["classification"] == OWNER_RUN_BOOTSTRAPPING and own(run)]
        if not bootstrapping or time.monotonic() - started >= wait_seconds:
            break
        waited = True
        time.sleep(poll_seconds)
    set_aside: list[dict] = []
    foreign: list[str] = []
    for run in runs:
        run["own"] = own(run)
        run["action"] = "left"
        if not run["own"]:
            foreign.append(run["run_id"])
            run["action"] = "left (not this deploy's run)"
            continue
        if run["classification"] != OWNER_RUN_ABORTED:
            continue
        fresh = classify({run["run_id"]})
        if not fresh or fresh[0]["classification"] != OWNER_RUN_ABORTED:
            run.update(fresh[0] if fresh else {}, action="left (reclassified before rename)")
            continue
        try:
            destination = set_aside_aborted_run(Path(run["path"]), context_root, run)
        except OSError as error:
            run.update(action="set-aside-failed", error=f"{type(error).__name__}: {error}")
            continue
        run.update(action="set-aside", set_aside=str(destination))
        set_aside.append({"run_id": run["run_id"], "set_aside": str(destination)})
    refused = [{"run_id": run["run_id"], "classification": run["classification"], "reason": run["reason"]}
               for run in runs
               if run["classification"] == OWNER_RUN_UNKNOWN
               or (run["own"] and (run["classification"] == OWNER_RUN_BOOTSTRAPPING or run["action"] == "set-aside-failed"))]
    counts = {name: sum(1 for run in runs if run["classification"] == name) for name in OWNER_RUN_CLASSES}
    summary = {"stage": stage, "context_root": str(context_root), "grace_seconds": grace_seconds,
               "waited_s": round(time.monotonic() - started, 2) if waited else 0.0, "counts": counts, "runs": runs,
               "set_aside": set_aside, "foreign": foreign, "refused": refused}
    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / OWNER_RUNS_RECEIPT_NAME).open("a") as handle:
        for run in runs:
            handle.write(json.dumps({"at": _now(), "stage": stage, **run}, sort_keys=True) + "\n")
    return summary


def _owner_runs_log_line(attempt: int, summary: dict) -> str:
    def names(values: list[dict], key: str = "run_id") -> str:
        return ",".join(str(value[key]) for value in values) or "-"

    counts = " ".join(f"{name}={summary['counts'][name]}" for name in OWNER_RUN_CLASSES)
    return (f"PIPELINE_OWNER_RUNS attempt={attempt} stage={summary['stage']} {counts} "
            f"foreign={len(summary['foreign'])} set_aside={names(summary['set_aside'])} "
            f"refused={names(summary['refused'])} waited_s={summary['waited_s']}")


def _probe_source() -> dict[str, str] | None:
    """Current source digest, or None while git is busy (index.lock, commit in flight)."""
    try:
        return source_digest()
    except (subprocess.CalledProcessError, OSError):
        return None


def _settled_source(frozen: dict, settle_seconds: float, poll_seconds: float) -> dict[str, str]:
    """Block until the changed source has stopped changing for settle_seconds."""
    current = _probe_source() or frozen
    since = time.monotonic()
    while True:
        time.sleep(min(poll_seconds, max(0.05, settle_seconds)))
        probe = _probe_source()
        if probe is not None and probe != current:
            current, since = probe, time.monotonic()
        elif time.monotonic() - since >= settle_seconds:
            return current


def run(
    plan: Path,
    state_dir: Path,
    max_parallel: int | None = None,
    budget_mb: int | None = None,
    *,
    follow_source: bool = False,
    settle_seconds: float = DEFAULT_SETTLE_SECONDS,
    poll_seconds: float = DEFAULT_POLL_SECONDS,
    fix_loop_cap: int = DEFAULT_FIX_LOOP_CAP,
    after_rca: str | None = None,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
) -> int:
    lanes, payload = load_plan_payload(plan)
    host = host_resources()
    live_budget = memory_budget_mb(host)
    if live_budget is None:
        raise ValueError("cannot establish whole-box memory headroom")
    if max_parallel is None:
        max_parallel = int(payload.get("max_parallel") or default_max_parallel(host))
    if max_parallel < 0 or (budget_mb is not None and budget_mb < 0):
        raise ValueError("resource limits must be nonnegative")
    if budget_mb is None:
        planned_budget = payload.get("memory_budget_mb")
        budget_mb = min(live_budget, planned_budget) if planned_budget is not None else live_budget
    budget_mb = min(budget_mb, live_budget)
    state_dir.mkdir(parents=True, exist_ok=True)
    try:
        teardown_wait = teardown_wait_seconds()
        teardown_kill_after = teardown_kill_after_override()
    except ValueError as error:
        print(f"PIPELINE_TEARDOWN: {error}", file=sys.stderr, flush=True)
        return 2
    receipt_path = state_dir / "receipt.json"
    previous = None
    if receipt_path.exists():
        try:
            previous = json.loads(receipt_path.read_text())
        except json.JSONDecodeError:
            previous = None
        if previous:
            _archive(state_dir, previous)
    receipts = _history(state_dir)
    loop = fix_loop_state(receipts, fix_loop_cap)
    if after_rca:
        loop.update(failed_rounds=0, classes={}, rca_ref=after_rca, rca_ack=True, capped=False)
    if loop["capped"]:
        summary = "; ".join(f"{lane}={','.join(kinds)}" for lane, kinds in sorted(loop["classes"].items())) or "-"
        receipt = {
            "schema_version": RECEIPT_SCHEMA,
            "plan": str(plan),
            "supervisor_pid": os.getpid(),
            "started_at": _now(),
            "started_epoch": time.time(),
            "finished_at": _now(),
            "attempt": 1,
            "source": _probe_source(),
            "lanes": {lane.name: {"status": "not-run", "group": lane.group} for lane in lanes},
            "status": "capped",
            "fix_loop": loop,
            "stage_run_dir": _stage_run_dir(),
        }
        write_receipt(receipt_path, receipt)
        print(
            f"FIX_LOOP_CAP: {loop['failed_rounds']} full gate round(s) failed on this deploy "
            f"(cap {fix_loop_cap}); failure classes: {summary}. Route every class to /RCA "
            "(local repro + fix) instead of a blind rerun; then run again with --after-rca <ref>.",
            flush=True,
        )
        return EXIT_FIX_LOOP_CAP
    attempt = 1
    supersedes: dict | None = None
    while True:
        receipt, outcome = _run_attempt(
            lanes, plan, state_dir, receipt_path, max_parallel, previous,
            host=host, live_budget=live_budget, budget_mb=budget_mb,
            attempt=attempt, supersedes=supersedes, loop=loop,
            follow_source=follow_source, settle_seconds=settle_seconds, poll_seconds=poll_seconds,
            teardown_wait=teardown_wait, teardown_kill_after=teardown_kill_after,
            payload=payload,
        )
        if outcome != "superseded":
            break
        if attempt >= max_attempts:
            receipt["status"] = "stale"
            receipt["note"] = f"max attempts ({max_attempts}) reached while the source kept changing"
            write_receipt(receipt_path, receipt)
            break
        _archive(state_dir, receipt)
        previous = receipt
        supersedes = {"attempt": attempt, **receipt["source"]}
        attempt += 1
    return {"passed": 0, "failed": 1, "stale": EXIT_STALE}.get(receipt["status"], 1)


def _run_attempt(
    lanes: list[Lane],
    plan: Path,
    state_dir: Path,
    receipt_path: Path,
    max_parallel: int,
    previous: dict | None,
    *,
    host: dict,
    live_budget: int,
    budget_mb: int,
    attempt: int,
    supersedes: dict | None,
    loop: dict,
    follow_source: bool,
    settle_seconds: float,
    poll_seconds: float,
    payload: dict | None = None,
    teardown_wait: float | None = None,
    teardown_kill_after: tuple[float, str] | None = None,
) -> tuple[dict, str]:
    """One attempt on one frozen source; returns (receipt, "done" | "superseded")."""
    lane_scoped_reuse = lane_scoped_reuse_enabled(payload)
    # The kill switch for a matched control run (DEPLOY_ADMISSION_CREDIT=0) is
    # read per attempt and recorded on the receipt and every admission.
    credit_enabled = admission_credit_enabled()
    # Phase-implied dependencies are recomputed per attempt from the ledger as
    # it stands now; the plan's own ``after`` edges are always kept.
    lanes = [Lane(**{**lane.__dict__, "after": list(lane.after)}) for lane in lanes]
    schedule = apply_schedule(lanes, payload or {})
    order = failed_first(lanes, previous)
    previously_failed = _failed_lanes(previous)
    frozen = source_digest()
    # The telemetry snapshot describes the head this attempt runs on: re-stamp
    # it with the frozen head, so the stage rows of a superseding attempt carry
    # the new head, and freeze again when it was rewritten so a snapshot inside
    # the digested bytes never differs from the frozen source. The stage runner
    # rejects an invalid file itself before any lane command runs; the line
    # here only names the cause earlier. A snapshot that cannot be read or
    # rewritten (status "error") is reported and the attempt continues on the
    # snapshot as found.
    try:
        refresh = factory_metadata.refresh_selected_snapshot(
            str(frozen.get("head") or ""), producer=f"run_deploy_pipeline attempt {attempt}", checkout=SOURCE_ROOT)
    except ValueError as error:
        print(f"PIPELINE_TELEMETRY factory metadata: rejected, {error}", file=sys.stderr, flush=True)
    else:
        if refresh["status"] == "error":
            print(f"PIPELINE_TELEMETRY {refresh['message']}", file=sys.stderr, flush=True)
        elif refresh["status"] != "unset":
            print(f"PIPELINE_TELEMETRY {refresh['message']}", flush=True)
        if refresh["status"] == "refreshed":
            frozen = source_digest()
    receipt: dict = {
        "schema_version": RECEIPT_SCHEMA,
        "plan": str(plan),
        "supervisor_pid": os.getpid(),
        "started_at": _now(),
        "started_epoch": time.time(),
        "attempt": attempt,
        "follow_source": follow_source,
        "settle_seconds": settle_seconds if follow_source else None,
        "source": frozen,
        "order": [lane.name for lane in order],
        "lanes": {
            lane.name: {"status": "pending", "group": lane.group, "memory_mb": lane.memory_mb} for lane in order
        },
        "status": "running",
        "fix_loop": loop,
        "stage_run_dir": _stage_run_dir(),
        "source_root": str(SOURCE_ROOT),
        "lane_scoped_reuse": lane_scoped_reuse,
        "reused_scoped_lanes": [],
        "reused_scoped_cross_run_lanes": [],
        "host": host,
        "host_peak": sample_host_peak({}, host),
        "host_samples": [{"at": _now(), **host, "headroom_mb": live_budget}],
        "max_parallel": max_parallel,
        "memory_budget_mb": budget_mb,
        "admission_credit": "enabled" if credit_enabled else "disabled",
        "schedule": schedule,
        "after": {lane.name: list(lane.after) for lane in order},
    }
    if supersedes:
        receipt["supersedes"] = supersedes
    write_receipt(receipt_path, receipt)
    log_dir = state_dir / "logs"
    log_dir.mkdir(exist_ok=True)
    print(f"PIPELINE_ATTEMPT attempt={attempt} {_source_label(frozen)}", flush=True)

    # Launch preflight: every isolated run directory of this checkout is
    # classified before a lane starts. This deploy's own aborted runs (named by
    # its earlier lane teardowns) are set aside and its own bootstrapping run
    # is waited out (the grace, at most); another session's runs are reported
    # and left; an unreadable record refuses the launch (fail closed; nothing
    # is ever signalled here).
    grace = bootstrap_grace_seconds()
    owner_runs = reconcile_owner_runs(benchmark_context_root(), state_dir, stage=f"attempt-{attempt}-preflight",
                                      wait_seconds=grace + OWNER_RUNS_POLL_SECONDS, grace_seconds=grace,
                                      own_run_ids=own_run_ids_from_state(state_dir))
    receipt["owner_runs"] = {key: owner_runs[key]
                             for key in ("stage", "counts", "set_aside", "foreign", "refused", "waited_s")}
    print(_owner_runs_log_line(attempt, owner_runs), flush=True)
    if owner_runs["refused"]:
        reasons = "; ".join(f"{run['run_id']}: {run['classification']} ({run['reason']})"
                            for run in owner_runs["refused"])
        note = f"refused: owner-run preflight {reasons}"
        for lane_state in receipt["lanes"].values():
            lane_state.update(status="failed", exit=None, finished_epoch=time.time(), note=note)
        receipt.update(status="failed", refused=owner_runs["refused"], note=note, finished_at=_now(),
                       finished_epoch=time.time(), wall_s=round(time.time() - receipt["started_epoch"], 1))
        write_receipt(receipt_path, receipt)
        print(f"PIPELINE_OWNER_RUNS_REFUSED attempt={attempt} {reasons} "
              f"(move the run to {ABORTED_RUNS_DIR}/ only after confirming nothing carries its run id; "
              f"receipt {state_dir / OWNER_RUNS_RECEIPT_NAME})", file=sys.stderr, flush=True)
        return receipt, "done"

    processes: dict[str, subprocess.Popen[bytes]] = {}
    signalled_lanes: set[str] = set()  # lanes terminated by a signal or a supersede
    stopping = 0

    def terminate(signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = signum
        signalled_lanes.update(_terminate_lanes(processes, signal.SIGTERM))

    for forwarded in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(forwarded, terminate)

    by_name = {lane.name: lane for lane in lanes}
    # Phased lanes are designed to run together: admitting one charges only the
    # running lanes' unmaterialized declarations against live headroom. Unphased
    # lanes keep the declared-peak accounting (semantic-stack beside the smoke
    # stack: both whole declarations must fit, no observed-usage credit).
    credit_lanes = {lane.name for lane in phased_lanes(lanes)}
    pending = list(order)
    superseding: dict | None = None  # the settled new source once detected
    changed_source: dict | None = None
    changed_since = 0.0
    last_probe = time.monotonic()
    last_sample = time.monotonic()
    while True:
        if time.monotonic() - last_sample >= HOST_SAMPLE_SECONDS:
            sample = runtime_host_resources()
            sample_host_peak(receipt["host_peak"], sample)
            receipt["host_samples"].append({"at": _now(), **sample,
                                            "headroom_mb": memory_budget_mb(sample)})
            # The observation is as old as the scan's start: a slow scan must not
            # relabel an early reading as fresh when it finally returns.
            scan_started, scan_wall = time.monotonic(), _now()
            observed = sample_lane_tree_memory({p.pid for p in processes.values() if p.returncode is None})
            for name, process in processes.items():
                if process.returncode is not None:
                    continue
                # Every pass re-marks every running lane: a lane this pass could
                # not fully observe is unknown again, never its previous value.
                # Anonymous PSS is the credit basis; total PSS is recorded only.
                tree_state = receipt["lanes"][name]
                value = observed.get(process.pid)
                tree_state.update(tree_anon_mb=None if value is None else value["anon_mb"],
                                  tree_pss_mb=None if value is None else value["pss_mb"],
                                  tree_sampled_mono=scan_started, tree_sampled_at=scan_wall)
                if value is not None:
                    tree_state["tree_peak_anon_mb"] = max(float(tree_state.get("tree_peak_anon_mb") or 0.0),
                                                          value["anon_mb"])
                    tree_state["tree_peak_pss_mb"] = max(float(tree_state.get("tree_peak_pss_mb") or 0.0),
                                                         value["pss_mb"])
            last_sample = time.monotonic()
        # Reap exits before admitting successors, so a lane's finished_epoch
        # always precedes the started_epoch of a lane admitted into its share.
        changed = False
        for name, process in processes.items():
            lane_state = receipt["lanes"][name]
            if lane_state["status"] != "running":
                continue
            # wait4 returns this child's getrusage statistics, unlike the
            # process-wide RUSAGE_CHILDREN maximum shared by concurrent lanes.
            pid, status, usage = os.wait4(process.pid, os.WNOHANG)
            if pid:
                process.returncode = os.waitstatus_to_exitcode(status)
                if superseding is not None:
                    status = "superseded"
                else:
                    status = "passed" if process.returncode == 0 else "failed"
                if status == "passed":
                    # A lane-scoped reuse exits 0 like a pass; its stage row
                    # carries the distinct status and provenance, which the
                    # receipt lane must keep whatever this plan enabled
                    # (never shown as a fresh pass).
                    status = reconcile_reused_lane(receipt, name, lane_state, finished_epoch=time.time())
                lane_state.update(
                    status=status,
                    exit=process.returncode,
                    finished_epoch=time.time(),
                    wall_s=round(time.time() - lane_state["started_epoch"], 1),
                    peak_rss_mb=round(usage.ru_maxrss / (1024 * 1024 if sys.platform == "darwin" else 1024), 3),
                    rusage_source="wait4",
                )
                changed = True
        if changed:
            receipt["status"] = "superseded" if superseding is not None else overall(receipt["lanes"])
            write_receipt(receipt_path, receipt)
        if not stopping and superseding is None:
            running_states = {name: receipt["lanes"][name] for name, p in processes.items() if p.returncode is None}
            running = len(running_states)
            reserved = sum(by_name[name].memory_mb for name in running_states)
            # Live headroom already contains what the running lanes use; only
            # the part of their declarations not yet materialized is still owed,
            # and only a fresh, fully observed sample says how much that is. The
            # classification is computed per candidate at its decision point
            # (after the host probe), never ahead of the loop.
            pass_sample = None
            for lane in list(pending):
                if max_parallel and running >= max_parallel:
                    break
                if any(receipt["lanes"][d]["status"] not in TERMINAL_LANE for d in lane.after):
                    continue
                if lane.exclusive and not running:
                    # Alone in its phase: fit its width to what is free right now
                    # (the plan-time budget and live headroom both drift) instead
                    # of refusing it or waiting for memory no other lane holds.
                    if pass_sample is None:
                        pass_sample = runtime_host_resources()
                        sample_host_peak(receipt["host_peak"], pass_sample)
                    free = [value for value in (budget_mb, memory_budget_mb(pass_sample)) if value is not None]
                    fitted = fit_exclusive_lane(lane, min(free) - reserved) if free else None
                    if fitted is not None and fitted.memory_mb < lane.memory_mb:
                        note = (f"resized: {_lane_workers(lane)} -> {_lane_workers(fitted)} workers "
                                f"(planned {lane.memory_mb} MB, {min(free)} MB available)")
                        receipt["lanes"][lane.name].update(note=note, memory_mb=fitted.memory_mb)
                        print(f"PIPELINE_LANE_RESIZED lane={lane.name} {note}", flush=True)
                        pending[pending.index(lane)] = fitted
                        by_name[lane.name] = fitted
                        lane = fitted
                static_reserved = reserved  # the static ceiling's charge for the running lanes
                if budget_mb is not None:
                    if lane.memory_mb > budget_mb and running and fit_exclusive_lane(lane, budget_mb) is not None:
                        # An exclusive lane planned wider than this attempt's budget
                        # while a stack lane holds memory (CodeRabbit on #1658): it
                        # is resized once the running lanes release their share,
                        # so defer instead of refusing a lane that can still fit.
                        _record_waiting(receipt["lanes"][lane.name], {
                            "at": _now(), "budget_mb": budget_mb, "memory_mb": lane.memory_mb,
                            "reserved_declared_mb": reserved}, "budget")
                        continue
                    if lane.memory_mb > budget_mb:
                        # It can never fit: fail loudly now instead of starting it
                        # into cgroup throttling or the host memory watchdog.
                        pending.remove(lane)
                        receipt["lanes"][lane.name].update(
                            status="failed",
                            exit=None,
                            finished_epoch=time.time(),
                            note=f"refused: needs {lane.memory_mb} MB, memory budget {budget_mb} MB",
                        )
                        continue
                    # Follow-up PR-11 (#1658 round 1, 2026-10-31): the plan's
                    # declarations may over-subscribe the start budget by a few
                    # MB (smoke 4150 + backend 3072 + agents 1536 = 8758 vs 8755)
                    # while the live check has room to spare; a phased candidate
                    # therefore charges a freshly observed running lane only its
                    # unmaterialized declaration here too. Unobserved lanes, a
                    # disabled credit and unphased candidates keep whole
                    # declarations; the live check below stays the binding bound.
                    static_running: dict = {}
                    if lane.name in credit_lanes and running_states:
                        static_observations = classify_observations(running_states, credit_enabled)
                        static_reserved = sum(unmaterialized_mb(by_name[name].memory_mb, static_observations[name][0])
                                              for name in running_states)
                        static_running = {name: {"memory_mb": by_name[name].memory_mb, **detail}
                                          for name, (_, detail) in static_observations.items()}
                    if static_reserved + lane.memory_mb > budget_mb:
                        # Admitted when running lanes release their declared share.
                        _record_waiting(receipt["lanes"][lane.name], {
                            "at": _now(), "budget_mb": budget_mb, "memory_mb": lane.memory_mb,
                            "reserved_declared_mb": reserved, "reserved_static_mb": static_reserved,
                            "running": static_running}, "budget")
                        continue
                if pass_sample is None:
                    pass_sample = runtime_host_resources()
                    sample_host_peak(receipt["host_peak"], pass_sample)
                sample = pass_sample
                headroom = memory_budget_mb(sample)
                # Classify the running lanes' observations now, after the host
                # probe: a slow probe or a deschedule may have aged a sample that
                # was fresh when this pass began past the limit. The decision
                # and its record use the same, current classification.
                observations = classify_observations(running_states, credit_enabled)
                unmaterialized = sum(unmaterialized_mb(by_name[name].memory_mb, observations[name][0])
                                     for name in running_states)
                accounting = "unmaterialized" if lane.name in credit_lanes else "declared"
                live_reserved = unmaterialized if accounting == "unmaterialized" else reserved
                inputs = {**_admission_inputs(lane, headroom, budget_mb, reserved, live_reserved, accounting,
                                              observations, by_name, credit_enabled),
                          "reserved_static_mb": static_reserved}
                if headroom is None or live_reserved + lane.memory_mb > headroom:
                    if headroom is None and receipt["host_samples"][-1].get("error") != sample.get("error"):
                        receipt["host_samples"].append({"at": _now(), **sample, "headroom_mb": headroom})
                    if running:
                        _record_waiting(receipt["lanes"][lane.name], inputs, "headroom")
                        continue  # this run can still release reservations
                    receipt["host_samples"].append({"at": _now(), **sample, "headroom_mb": headroom})
                    pending.remove(lane)
                    receipt["lanes"][lane.name].update(
                        status="failed", exit=None, finished_epoch=time.time(),
                        note=f"refused: needs {lane.memory_mb} MB, live headroom {headroom} MB",
                        admission={**inputs, "decision": "refused"},
                    )
                    continue
                receipt["host_samples"].append({"at": _now(), **sample, "headroom_mb": headroom})
                pending.remove(lane)
                deferred = receipt["lanes"][lane.name].pop("waiting", None)
                receipt["lanes"][lane.name]["admission"] = {**inputs, "decision": "admitted", "deferred": deferred}
                if deferred:
                    print(f"PIPELINE_LANE_ADMITTED lane={lane.name} after {deferred['checks']} deferred check(s) "
                          f"since {deferred['since']}: headroom={headroom} reserved_live={live_reserved} "
                          f"reserved_declared={reserved} memory={lane.memory_mb} accounting={accounting} "
                          f"credit={'enabled' if credit_enabled else 'disabled'}",
                          flush=True)
                token = lane_token(lane.name, attempt)
                argv = ["bash", str(STAGE_WRAPPER), lane.name]
                if lane.reuse_passed:
                    argv.append("--reuse-passed")
                if lane_scoped_reuse:
                    argv.append("--lane-scoped-reuse")
                argv += ["--", *lane.command]
                log_path = log_dir / f"{lane.name}.log"
                try:
                    with log_path.open("ab") as log_handle:
                        processes[lane.name] = subprocess.Popen(
                            argv,
                            cwd=ROOT / lane.cwd,
                            env={
                                **os.environ,
                                **lane.env,
                                **(lane.retry_env if lane.name in previously_failed else {}),
                                LANE_TOKEN_ENV: token,
                            },
                            stdout=log_handle,
                            stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL,
                            start_new_session=True,
                        )
                except OSError as error:
                    # No stage row will ever exist for this lane; the receipt
                    # is its only record (wait reports it from here).
                    receipt["lanes"][lane.name].update(
                        status="failed",
                        exit=None,
                        finished_epoch=time.time(),
                        log=str(log_path),
                        note=f"spawn failed: {error}",
                        admission={**inputs, "decision": "spawn-failed", "deferred": deferred},
                    )
                    continue
                pass_sample = None  # a successful spawn changes live headroom
                receipt["lanes"][lane.name].update(
                    status="running", started_epoch=time.time(), log=str(log_path), lane_token=token
                )
                # The next candidate reclassifies the running lanes, including
                # this one (unknown until a sampling pass observes it).
                running_states[lane.name] = receipt["lanes"][lane.name]
                running += 1
                reserved += lane.memory_mb
            write_receipt(receipt_path, receipt)
        elif pending:
            for lane in pending:
                if superseding is not None:
                    receipt["lanes"][lane.name].update(status="superseded", note="superseded")
                else:
                    receipt["lanes"][lane.name].update(status="failed", exit=128 + stopping, note="not started")
            if stopping:
                receipt["interrupted"] = signal.Signals(stopping).name
            pending = []
        if not pending and all(state["status"] in TERMINAL_LANE for state in receipt["lanes"].values()):
            break
        now = time.monotonic()
        if follow_source and not stopping and superseding is None and now - last_probe >= poll_seconds:
            last_probe = now
            probe = _probe_source()
            if probe is None or probe == frozen:
                changed_source, changed_since = None, 0.0
            else:
                if probe != changed_source:
                    changed_source, changed_since = probe, now
                    print(
                        f"PIPELINE_SOURCE_CHANGED attempt={attempt} {_source_label(probe)} "
                        f"settling={settle_seconds:.0f}s",
                        flush=True,
                    )
                elif now - changed_since >= settle_seconds:
                    superseding = probe
                    receipt["status"] = "superseded"
                    receipt["superseded_at"] = _now()
                    receipt["superseded_by"] = probe
                    receipt["superseded_lanes"] = sorted(
                        name for name, state in receipt["lanes"].items() if state["status"] == "running"
                    )
                    write_receipt(receipt_path, receipt)
                    print(
                        f"PIPELINE_SUPERSEDED attempt={attempt} old_head={frozen.get('head')} "
                        f"new_head={probe.get('head')} terminating={','.join(receipt['superseded_lanes']) or '-'}",
                        flush=True,
                    )
                    signalled_lanes.update(_terminate_lanes(processes, signal.SIGTERM))
        time.sleep(0.2)

    # Every signalled lane's wrapper has exited; reap what its chain left
    # behind before this attempt is recorded finished and a successor starts.
    for name in sorted(signalled_lanes):
        lane_state = receipt["lanes"][name]
        teardown = teardown_lane(name, attempt=attempt, token=lane_state["lane_token"],
                                 started_epoch=lane_state["started_epoch"], state_dir=state_dir,
                                 wait_seconds=teardown_wait, kill_after=teardown_kill_after)
        lane_state["teardown"] = _teardown_summary(teardown)
        print(_teardown_log_line(attempt, name, lane_state["teardown"]), flush=True)
    if signalled_lanes:
        write_receipt(receipt_path, receipt)

    receipt["finished_at"] = _now()
    receipt["wall_s"] = round(time.time() - receipt["started_epoch"], 1)
    sample = runtime_host_resources()
    sample_host_peak(receipt["host_peak"], sample)
    receipt["host_samples"].append({"at": _now(), **sample, "headroom_mb": memory_budget_mb(sample)})
    receipt["finished_epoch"] = time.time()
    receipt["watchdog_terminations"] = watchdog_terminations(receipt["started_epoch"], receipt["finished_epoch"])
    if receipt["watchdog_terminations"]:
        print(
            f"PIPELINE_WATCHDOG: {len(receipt['watchdog_terminations'])} memory-watchdog TERM(s) during this run: "
            + ", ".join(f"{r.get('comm')} pid={r.get('pid')} at={r.get('at')}" for r in receipt["watchdog_terminations"]),
            file=sys.stderr,
        )
    if superseding is not None:
        receipt["status"] = "superseded"
        write_receipt(receipt_path, receipt)
        return receipt, "superseded"
    final_source = source_digest()
    receipt["final_source"] = final_source
    receipt["status"] = overall(receipt["lanes"])
    try:
        record_lane_durations(receipt)
    except OSError as error:
        print(f"PIPELINE_LEDGER: could not record lane durations: {error}", file=sys.stderr, flush=True)
    if final_source != frozen:
        if follow_source and not stopping:
            settled = _settled_source(frozen, settle_seconds, poll_seconds)
            receipt["status"] = "superseded"
            receipt["superseded_at"] = _now()
            receipt["superseded_by"] = settled
            receipt["superseded_lanes"] = []
            write_receipt(receipt_path, receipt)
            print(
                f"PIPELINE_SUPERSEDED attempt={attempt} old_head={frozen.get('head')} "
                f"new_head={settled.get('head')} terminating=- (source changed after the lanes finished)",
                flush=True,
            )
            return receipt, "superseded"
        receipt["status"] = "stale"
    write_receipt(receipt_path, receipt)
    return receipt, "done"


def _stage_run_dir() -> str | None:
    """The run-deploy-stage timing run every lane records into."""
    run_root = Path(os.environ.get("DEPLOY_RUN_ROOT") or ROOT / ".context" / "deploy-runs")
    try:
        run_id = (run_root / "current").read_text().splitlines()[0].strip()
    except (OSError, IndexError):
        return None
    return str(run_root / run_id) if run_id else None


def _read_receipt(path: Path) -> dict | None:
    try:
        receipt = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return receipt if isinstance(receipt, dict) else None


def _supervisor_alive(receipt: dict) -> bool:
    pid = receipt.get("supervisor_pid")
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _pending_source_change(receipt: dict) -> bool:
    """Whether the worktree bytes already differ from the attempt's frozen source."""
    probe = _probe_source()
    return probe is not None and probe != (receipt.get("source") or {})


def _supervisor_event(receipt: dict, attempt: int | None = None) -> tuple[int, dict] | None:
    """Events only the supervisor knows; lane events come from stage receipts.

    ``attempt`` is the attempt the waiter armed on; a receipt from another
    attempt (or one marked superseded) is the supersede event. Without it the
    receipt's own attempt is used, so a single receipt is judged on its own.
    """
    if attempt is None:
        attempt = int(receipt.get("attempt", 1))
    if receipt.get("status") == "stale":
        return EXIT_STALE, {"event": "stale"}
    if receipt.get("status") == "capped":
        return EXIT_FIX_LOOP_CAP, {"event": "fix-loop-cap", "fix_loop": receipt.get("fix_loop")}
    if receipt.get("status") == "superseded" or int(receipt.get("attempt", 1)) != attempt:
        return _SUPERSEDED_EVENT, {"event": "superseded", "attempt": attempt}
    unstarted = [
        name
        for name, lane in receipt["lanes"].items()
        if lane.get("status") == "failed" and lane.get("note") == "not started"
    ]
    if unstarted:
        return 1, {"event": "failed", "failed": unstarted}
    # A lane can fail before run-deploy-stage writes its row (refused by the
    # memory budget, spawn error, wrapper usage/admission error); the receipt
    # is then the only record, so the waiter must not hang on it.
    failed = sorted(name for name, lane in receipt["lanes"].items() if lane.get("status") == "failed")
    if failed:
        return 1, {"event": "failed", "failed": failed}
    if receipt.get("status") == "running" and not _supervisor_alive(receipt):
        return 3, {"event": "supervisor-died", "pid": receipt.get("supervisor_pid")}
    return None


def wait(state_dir: Path, timeout: float, stall_seconds: float = 0.0, since: float = 0.0) -> int:
    """One waiter for every /deploy gate: delegate lanes to deploy_stage_wait.

    ``since`` is the epoch captured before launching ``run``: a receipt
    started earlier belongs to a previous iteration and never satisfies the
    wait (it could report that older snapshot green while new lanes run).
    """
    receipt_path = state_dir / "receipt.json"
    limit = timeout if timeout else float("inf")
    started = time.monotonic()

    def fresh() -> dict | None:
        found = _read_receipt(receipt_path)
        if found is None or float(found.get("started_epoch") or 0) < since:
            return None  # absent, or the previous iteration's receipt
        return found

    receipt = fresh()
    while receipt is None:
        if time.monotonic() - started > min(limit, 30.0):
            print(f"PIPELINE_WAKE status=no-receipt exit=2 (no run started at or after since={since})")
            return 2
        time.sleep(0.2)
        receipt = fresh()
    if receipt.get("status") == "capped":
        loop = receipt.get("fix_loop") or {}
        print(f"PIPELINE_WAKE status=fix-loop-cap exit={EXIT_FIX_LOOP_CAP} failed_rounds={loop.get('failed_rounds')}")
        print(json.dumps({"event": "fix-loop-cap", "exit": EXIT_FIX_LOOP_CAP, "fix_loop": loop}, sort_keys=True))
        return EXIT_FIX_LOOP_CAP
    if not receipt.get("stage_run_dir"):
        print("PIPELINE_WAKE status=no-stage-run exit=2 (start one with run-deploy-stage --start)")
        return 2
    latest = {"receipt": receipt}

    def refresh() -> dict:
        latest["receipt"] = _read_receipt(receipt_path) or latest["receipt"]
        return latest["receipt"]

    while True:
        current = latest["receipt"]
        attempt = int(current.get("attempt", 1))
        lanes = list(current["lanes"])
        stage_run_dir = Path(current["stage_run_dir"])
        code, payload = deploy_stage_wait.wait_for_stages(
            stage_run_dir,
            lanes,
            since=float(current["started_epoch"]),
            timeout=max(0.0, limit - (time.monotonic() - started)),
            stall_seconds=stall_seconds,
            extra_event=lambda armed=attempt: _supervisor_event(refresh(), armed),
        )
        if code == deploy_stage_wait.EXIT_FAILED:
            # A stage failure is reported before extra_event runs: the attempt
            # may already have been superseded, in which case the failure
            # belongs to discarded bytes and the next attempt is what to follow.
            current = refresh()
            if int(current.get("attempt", 1)) != attempt or current.get("status") == "superseded":
                code, payload = _SUPERSEDED_EVENT, {"event": "superseded", "attempt": attempt}
        while code == 0:
            if time.monotonic() - started >= limit:
                code, payload = deploy_stage_wait.EXIT_TIMEOUT, {"event": "timeout"}
                break
            # Every lane passed; the supervisor still re-hashes the frozen source.
            current = refresh()
            status = current.get("status")
            if int(current.get("attempt", 1)) != attempt or status == "superseded":
                code, payload = _SUPERSEDED_EVENT, {"event": "superseded", "attempt": attempt}
                break
            if status in {"passed", "failed", "stale"}:
                code = {"passed": 0, "failed": 1, "stale": EXIT_STALE}[status]
                payload = {"event": status}
                break
            if not _supervisor_alive(current):
                code, payload = 3, {"event": "supervisor-died", "pid": current.get("supervisor_pid")}
                break
            time.sleep(0.2)
        if (
            code == deploy_stage_wait.EXIT_FAILED
            and current.get("follow_source")
            and current.get("status") in ("running", "failing")  # attempt not terminal
            and _supervisor_alive(current)
            and _pending_source_change(current)
        ):
            # The failure belongs to bytes that are no longer current: a fix is
            # landing and the supervisor will supersede this attempt once it
            # settles. Report the next attempt instead of the stale failure.
            if time.monotonic() - started >= limit:
                code, payload = deploy_stage_wait.EXIT_TIMEOUT, {"event": "timeout", "pending_supersede": attempt}
                break
            time.sleep(0.5)
            continue
        if code != _SUPERSEDED_EVENT:
            break
        # Superseded: wait for the next attempt's receipt (or a terminal state) and start over.
        print(f"PIPELINE_SUPERSEDED attempt={attempt} (results on the old bytes discarded)", flush=True)
        while True:
            current = refresh()
            if int(current.get("attempt", 1)) != attempt and current.get("status") != "superseded":
                break
            if current.get("status") == "stale":
                code, payload = EXIT_STALE, {"event": "stale"}
                break
            if not _supervisor_alive(current):
                code, payload = 3, {"event": "supervisor-died", "pid": current.get("supervisor_pid")}
                break
            if time.monotonic() - started >= limit:
                code, payload = deploy_stage_wait.EXIT_TIMEOUT, {"event": "timeout", "superseded": attempt}
                break
            time.sleep(0.2)
        if code != _SUPERSEDED_EVENT:
            break
    final = latest["receipt"]
    lanes = list(final["lanes"])
    stage_run_dir = Path(final["stage_run_dir"])
    rows = {
        row.get("stage"): row
        for row in deploy_stage_wait._rows(stage_run_dir)
        if row.get("stage") in lanes and float(row.get("started_epoch") or 0) >= final["started_epoch"]
    }
    failed = list(payload.get("failed", []))
    for name in failed:
        lane = final["lanes"].get(name, {})
        note = f" note={lane['note']!r}" if lane.get("note") else ""
        print(f"FAILED {name} exit={rows.get(name, {}).get('exit_code', lane.get('exit'))} log={lane.get('log')}{note}")
    running = sorted(set(lanes) - set(rows) - set(failed))
    source = final.get("source") or {}
    print(
        f"PIPELINE_WAKE status={payload.get('event')} exit={code} head={source.get('head')} "
        f"digest={str(source.get('digest'))[:12]} attempt={final.get('attempt', 1)} "
        f"still_running={','.join(running) or '-'}"
    )
    payload["exit"] = code
    payload["attempt"] = final.get("attempt", 1)
    payload["source"] = source
    print(json.dumps(payload, sort_keys=True, default=str))
    return code


def verify(state_dir: Path, expect_head: str | None = None, require_staged: bool = False) -> int:
    """Exit 0 only for a passed receipt bound to the current HEAD and bytes."""
    if require_staged and not (state_dir / "cycle.json").is_file():
        print("PIPELINE_VERIFY status=no-staged-cycle exit=2")
        return 2
    if (state_dir / "cycle.json").exists():
        from deploy_test_cycle import verify_saved
        code = verify_saved(state_dir, SOURCE_ROOT, expect_head)
        print(f"PIPELINE_VERIFY status={'bound-staged' if code == 0 else 'staged-not-ready'} exit={code} "
              "reused_scoped=- cross_run=- staged=true")
        return code
    receipt = _read_receipt(state_dir / "receipt.json")
    if receipt is None:
        print("PIPELINE_VERIFY status=no-receipt exit=2")
        return 2
    status = receipt.get("status")
    source = receipt.get("source") or {}
    if status != "passed":
        print(f"PIPELINE_VERIFY status={status} exit=1 head={source.get('head')} (receipt is not green)")
        return 1
    current = source_digest()
    if expect_head and source.get("head") != expect_head:
        print(f"PIPELINE_VERIFY status=head-mismatch exit={EXIT_STALE} receipt={source.get('head')} expected={expect_head}")
        return EXIT_STALE
    if current != source:
        print(
            f"PIPELINE_VERIFY status=source-mismatch exit={EXIT_STALE} receipt_head={source.get('head')} "
            f"receipt_digest={str(source.get('digest'))[:12]} current_head={current['head']} "
            f"current_digest={current['digest'][:12]} (gates ran on different bytes; rerun)"
        )
        return EXIT_STALE
    reused_scoped = receipt.get("reused_scoped_lanes") or []
    cross_run = receipt.get("reused_scoped_cross_run_lanes") or []
    print(
        f"PIPELINE_VERIFY status=bound exit=0 head={current['head']} digest={current['digest'][:12]} "
        f"attempt={receipt.get('attempt', 1)} reused_scoped={','.join(reused_scoped) or '-'} "
        f"cross_run={','.join(cross_run) or '-'}"
    )
    return 0


AGENTCARD_TASKS = (
    "agent-payment-test-shop",
    "agent-payment-setup-resume",
    "agent-payment-idempotent-abandonment",
    "agent-payment-abandonment",
)
# Persisted per worktree (.context is per checkout): tsc re-checks only files
# whose content hash changed and re-reports the cached diagnostics for the
# rest, so the error set equals a full --noEmit run.
TSBUILDINFO = "../.context/tsbuildinfo/back-end.tsbuildinfo"
TYPESCRIPT_COMMAND = [
    "bash", "-c",
    f"mkdir -p ../.context/tsbuildinfo && npx tsc --noEmit --incremental --tsBuildInfoFile {TSBUILDINFO}",
]
# Versioned Group 4 tails (follow-up 12, 2026-10-31). Until then only the
# private launcher plan carried the Step 4p live probes and the Step 5/6b/6c
# semantic stack; ``plan --live-probes --semantic-stack --e2b-smoke`` emits
# them (default off, so existing callers' plans are unchanged).
LIVE_PROBES_COMMAND = ["python3", "scripts/run_deploy_live_probes.py"]
SEMANTIC_STACK_SCRIPT = "scripts/run-deploy-semantic-stack.sh"
SEMANTIC_STACK_COMMAND = ["bash", SEMANTIC_STACK_SCRIPT]
E2B_SMOKE_COMMAND = ["bash", SEMANTIC_STACK_SCRIPT, "--e2b-smoke-only"]
# semantic-stack's non-isolated ``run.sh --benchmark`` sweeps the worktree
# with scripts/kill-services.sh at startup and exit (run.sh lines "Cleaning
# stale services for this worktree before startup" and its EXIT trap). Those
# sweeps reap every same-worktree process shaped like a service: anything
# under agents/ running worker.py or a Playwright driver, anything under
# front-end/ running npm/npx/vite (``service_like_process`` and the
# ``<worktree>/agents.*worker\.py`` / ``<worktree>/front-end.*vite`` argv
# patterns). The agents and frontend coverage lanes spawn exactly those
# children, so the lane waits for them: an ownership edge, not a memory one.
# Backend coverage and the live probes boot ``tsx src/bootstrap.ts`` backends
# on CONDUCTOR_PORT+100.., which no sweep pattern matches, and the split lane
# no longer touches their victoria_<workspace> database, so it does not wait
# for them (the launcher plan did, which held it behind backend coverage).
SEMANTIC_STACK_SWEEP_EDGES = ("frontend-coverage-blackbox", "agents-coverage-blackbox")
# The E2B smoke, the live probes and backend coverage's trailing
# blackbox-backend-teardown test all drive run-blackbox-tests.sh against the
# same victoria_<workspace> database (prisma db push + runtime SQL hooks):
# two at once deadlocked chat-router-failover-live on 2026-10-12. Serial.
E2B_SMOKE_DATABASE_EDGES = ("backend-coverage-blackbox", "live-probes")


def standard_plan(args: argparse.Namespace) -> dict:
    """Group 3 + Group 4 lanes exactly as deploy.md writes them, sized to the host.

    The worker flags carry deploy.md's values, which were tuned for the 14-core
    deploy host; they are a ceiling. Each lane declares ``memory_mb``, a
    whole-lane reservation grounded on the largest single-child peak RSS the
    stage runner recorded across every deploy run on the 2026-10-28 devbox
    (eslint 1928 MB, full-tree eslint-fix 2974, frontend vitest 1775, tsc
    1479, one structural suite 1472, AgentCard stack 1602, backend coverage
    shard 1021) with >= 1.25x margin plus a per-worker term for lanes that
    fork workers. The run that motivated this started twelve lanes with 28
    workers at once (unit MemoryPeak 12.9 GB, load1 39.8, MemAvailable 906
    MB, memory-watchdog TERMs) and tripped subprocess timeouts that
    pass in isolation.
    """

    host = host_resources(args.host_cpus, args.host_mem_mb, args.host_total_mem_mb, args.host_watchdog_mb)
    workers = {
        "backend_blackbox": scale_workers(min(4, args.backend_blackbox_workers), host),
        "backend_unit": scale_workers(min(6, args.backend_unit_workers), host),
        "frontend": scale_workers(min(4, args.frontend_workers), host),
        "agents": scale_workers(min(6, args.agents_workers), host),
        "structural": structural_runner_workers(host),
    }
    lanes: list[dict] = []

    def lane(name: str, command: list[str], cwd: str = ".", group: str = "3", *, memory_mb: int,
             **extra: object) -> None:
        lanes.append({"name": name, "command": command, "cwd": cwd, "group": group,
                      "memory_mb": int(memory_mb), **extra})

    if args.group in {"3", "all"}:
        lane("eslint", ["bash", "-c", "xargs node scripts/lint-affected.mjs < ../.context/deploy-lint-ts.txt"],
             "back-end", memory_mb=3072)
        lane("typescript", list(TYPESCRIPT_COMMAND), "back-end", memory_mb=2048)
        lane("backend-structural", ["npm", "run", "test:structural"], "back-end", memory_mb=512)
        if args.schedule == SCHEDULE_PHASED:
            # Alone in its phase: every core the whole-box budget can back at
            # the measured per-worker floor, not the shared host_scale share.
            workers["structural"] = exclusive_structural_workers(host)
        lane("deploy-command-structural", ["python3", "scripts/run-deploy-structural-gates.py",
             "--max-workers", str(workers["structural"])],
             memory_mb=structural_lane_memory_mb(workers["structural"]),
             exclusive=args.schedule == SCHEDULE_PHASED)
        lane("seed-cache-decision", ["bash", "scripts/tests/seed-cache-decision.test.sh"], memory_mb=256)
        lane("canonical-seed-whatsapp-content", ["bash", "scripts/tests/canonical-seed-whatsapp-content.test.sh"],
             memory_mb=256)
        if args.backend:
            lane("backend-coverage-blackbox", ["npm", "run", "test:coverage:sharded"], "back-end", env={
                "BLACKBOX_TEST_CONCURRENCY": str(workers["backend_blackbox"]),
                "CONTRACT_TEST_CONCURRENCY": str(workers["backend_blackbox"]),
                "BACKEND_UNIT_CONCURRENCY": str(workers["backend_unit"]),
            }, retry_env={"BACKEND_COVERAGE_FAILED_FIRST": "1"},
                memory_mb=1536 + 512 * (workers["backend_blackbox"] + workers["backend_unit"]))
        if args.frontend:
            lane("frontend-coverage-blackbox",
                 ["npm", "run", "test:coverage", "--", f"--maxWorkers={workers['frontend']}"], "front-end",
                 memory_mb=2048 + 512 * workers["frontend"])
        if args.agents:
            lane("agents-coverage-blackbox", ["bash", "scripts/run-coverage.sh"], "agents",
                 env={"AGENTS_COVERAGE_CONCURRENCY": str(workers["agents"])},
                 memory_mb=768 + 384 * workers["agents"])
        if args.live_probes:
            # Step 4p: after every Group 3 lane, as deploy.md orders it (two
            # run-blackbox-tests.sh setups on victoria_<workspace> deadlock its
            # schema sync; 2026-10-12). Phased into the coverage phase by its
            # edges; its 963 MB is the pinned 1.25x margin over the recorded peak.
            lane("live-probes", list(LIVE_PROBES_COMMAND),
                 memory_mb=live_probes_lane_memory_mb(),
                 after=[entry["name"] for entry in lanes if entry["group"] == "3"], reuse_passed=True)
    if args.group in {"4", "all"}:
        if args.smoke == "cloud":
            lane("smoke", ["bash", "scripts/run-predeploy-cloud"], group="4", memory_mb=1024)
        elif args.smoke == "local":
            # Stack phase: starts after the quick lanes beside the exclusive
            # structural lane (3220 + 4150 MB fit a ~8 GB budget; admitted
            # first and unphased, this stack (then 4096 MB) once held the memory the
            # 6544 MB lane needed, #1638: smoke-only for 13-23 min). The
            # coverage lanes never wait for it; beside backend-coverage-
            # blackbox (2560 MB) it fits the budget afterwards.
            lane("smoke", ["bash", "scripts/run-predeploy-local"], group="4", memory_mb=smoke_lane_memory_mb(),
                 phase=PHASE_STACK)
        if args.agentcard:
            # Alongside smoke, never after it: its own isolated local stack in
            # the same declared phase (no edge between the two).
            lane("agentcard-lifecycle",
                 ["bash", "scripts/run-bench", "--local", *AGENTCARD_TASKS, "--bootstrap",
                  "--max-concurrency", "1", "--no-dashboard"], group="4", env={
                     "BENCHMARK_SKIP_WMH_BUILD": "1",
                     "BENCHMARK_ATTEMPT_SUITE": "predeploy",
                     "BENCHMARK_COUNTS_FOR_DEPLOY_ELIGIBILITY": "0",
                     "BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL": "1",
                 }, reuse_passed=False, memory_mb=smoke_lane_memory_mb(), phase=PHASE_STACK)
        present = {entry["name"] for entry in lanes}
        if args.semantic_stack:
            # Steps 5 + 6b as one unphased Group 4 lane: its own run.sh
            # --benchmark stack, UI semantics, latency ratchet. 6108 MB is the
            # pinned 1.25x margin over the recorded 4886.2 MB peak; on the
            # recorded 7979 MB budget that defers it behind backend coverage
            # (6108 + 2560 > 7979) and smoke (+ 4150) by memory alone, and the
            # sweep edges hold it behind agents/frontend coverage. It never
            # waits for backend coverage or the live probes by edge.
            lane("semantic-stack", list(SEMANTIC_STACK_COMMAND), group="4",
                 memory_mb=semantic_stack_lane_memory_mb(),
                 after=[name for name in ("deploy-command-structural", *SEMANTIC_STACK_SWEEP_EDGES)
                        if name in present], reuse_passed=True)
        if args.e2b_smoke:
            # Step 6c alone: the standalone blackbox runner, no stack. Serial on
            # victoria_<workspace> behind the lanes that drive the same runner.
            lane("e2b-smoke", list(E2B_SMOKE_COMMAND), group="4", memory_mb=e2b_smoke_lane_memory_mb(),
                 after=[name for name in E2B_SMOKE_DATABASE_EDGES if name in present], reuse_passed=True)
    for entry in lanes:
        if entry["group"] == "4":
            entry.setdefault("reuse_passed", False)
    plan_lanes = [Lane(**{k: v for k, v in entry.items() if k in Lane.__dataclass_fields__}) for entry in lanes]
    estimates = lane_estimates(plan_lanes, load_lane_durations(), stage_receipt_samples([l.name for l in plan_lanes]))
    phases = schedule_phases(plan_lanes, estimates) if args.schedule == SCHEDULE_PHASED else []
    return {
        "lanes": lanes,
        "host": host,
        "workers": workers,
        "max_parallel": default_max_parallel(host),
        "memory_budget_mb": memory_budget_mb(host),
        # ``run`` recomputes the phases from the ledger at attempt time; this
        # preview shows the order the current ledger implies.
        "schedule": {"policy": args.schedule, "phases": phases, "estimates": estimates},
    }


def simulate_plan(path: Path, max_parallel: int | None, budget_mb: int | None,
                  legacy_plan: Path | None = None) -> dict:
    """``legacy_plan`` (``plan --schedule legacy``) supplies the legacy lanes'
    own reservations/worker flags; without it the same plan is compared. With
    it, both the top-level and the ``group3`` legacy walls (and deltas)
    describe that plan, never the phased plan compared against itself."""
    lanes, payload = load_plan_payload(path)
    estimates = lane_estimates(lanes, load_lane_durations(), stage_receipt_samples([l.name for l in lanes]))
    if max_parallel is None:
        max_parallel = int(payload.get("max_parallel") or 0)
    if budget_mb is None:
        budget_mb = payload.get("memory_budget_mb")
    result = simulate(lanes, estimates, max_parallel, budget_mb)
    if legacy_plan is not None:
        legacy_lanes, _ = load_plan_payload(legacy_plan)
        legacy = simulate(legacy_lanes, lane_estimates(legacy_lanes, load_lane_durations(),
                                                       stage_receipt_samples([l.name for l in legacy_lanes])),
                          max_parallel, budget_mb)
        for block, legacy_block in ((result, legacy), (result["group3"], legacy["group3"])):
            block["legacy_union_wall_s"] = legacy_block["legacy_union_wall_s"]
            block["delta_s"] = round(block["legacy_union_wall_s"] - block["phased_union_wall_s"], 1)
        result["legacy_plan"] = str(legacy_plan)
    return result


# ── Post-merge production gate: the Fly lane (deploy.md Step 13 / 13ab) ───────
# ``production`` gates the Step 13b production semantic dispatch on the exact
# deploy-agents.yml run of the merged SHA. The #1639 chain (2026-10-30)
# dispatched the production semantic workflow as soon as Render was live while
# the Fly cooperative cutover was still running; 4/5 jobs failed (route
# timeouts, temporal_workflow_id never persisted) and only the rerun after Fly
# was live passed. Every GitHub wait is recorded in the production receipt.
PRODUCTION_RECEIPT = "production.json"
PRODUCTION_SCHEMA = 1
AGENTS_WORKFLOW = "deploy-agents.yml"
AGENTS_WORKFLOW_PATH = ".github/workflows/deploy-agents.yml"
CLASSIFY_AGENT_RUNTIME = Path("scripts") / "classify-agent-runtime-changes.sh"
SURFACE_HASH_SCRIPT = Path("scripts") / "agent_workflow_surface_hash.py"
# deploy-agents.yml logs the durable job it enqueued; the cutover monitor and
# the queue identity check (Step 13ab) are bound to that exact job.
JOB_ID_PATTERN = re.compile(r"Queued production worker deployment ([a-f0-9]{64})")
# deploy.md Step 13: 120 x 5 s for the exact run to appear, 540 x 10 s for it
# to complete (the workflow's own cutover step allows 90 minutes).
DEFAULT_FLY_START_TIMEOUT = 600.0
DEFAULT_FLY_TIMEOUT = 5400.0
DEFAULT_FLY_POLL_SECONDS = 10.0
GH_TIMEOUT_SECONDS = 120.0


class ProductionGateError(RuntimeError):
    """A blocked production gate: the message is the operator's next action."""


def merged_changes(merged_sha: str, root: Path | None = None) -> list[str]:
    """Paths changed by the merge commit itself (``merged_sha^1..merged_sha``),
    never the latest ``main``, which may already belong to a later PR."""
    root = SOURCE_ROOT if root is None else root
    output = subprocess.run(
        ["git", "diff", "--name-only", f"{merged_sha}^1", merged_sha], cwd=root, check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=300,
    ).stdout
    return [line for line in output.splitlines() if line]


def agent_cutover_required(changed: list[str], root: Path | None = None) -> dict:
    """deploy.md Step 13's rule: runtime files selected by
    ``scripts/classify-agent-runtime-changes.sh`` or the workflow file itself
    require the exact deploy-agents.yml run; tests, benchmarks, docs and
    coverage harnesses under agents/ never do."""
    root = SOURCE_ROOT if root is None else root
    classified = subprocess.run(
        ["bash", str(root / CLASSIFY_AGENT_RUNTIME)], input="".join(f"{path}\n" for path in changed),
        cwd=root, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60,
    ).stdout
    runtime = [line for line in classified.splitlines() if line]
    workflow = AGENTS_WORKFLOW_PATH in changed
    return {"required": bool(runtime or workflow), "runtime_files": runtime, "workflow_changed": workflow}


def _gh_executable() -> str:
    """``DEPLOY_GH_BIN`` names the GitHub CLI binary to run. On boxes.dev the
    ``gh`` wrapper on PATH replaces GH_TOKEN with an App token that cannot
    dispatch workflows (HTTP 403); deploy.md Step 13b exports the real binary
    with the repo's workflow-scoped token. Every gh call here goes through
    this one resolver so a test can stub gh on PATH."""
    return os.environ.get("DEPLOY_GH_BIN") or "gh"


def _gh_text(arguments: list[str], root: Path, *, timeout: float = GH_TIMEOUT_SECONDS) -> str:
    """``gh ...`` stdout; a failed call raises with gh's own message."""
    completed = subprocess.run([_gh_executable(), *arguments], cwd=root, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, timeout=timeout)
    if completed.returncode != 0:
        raise ProductionGateError(f"gh {' '.join(arguments[:3])} failed: {completed.stderr.strip() or completed.stdout.strip()}")
    return completed.stdout


def _gh_json(arguments: list[str], root: Path) -> object:
    """``gh ... --json`` parsed; a failed call raises with gh's own message."""
    output = _gh_text(arguments, root)
    try:
        return json.loads(output or "null")
    except json.JSONDecodeError as error:
        raise ProductionGateError(f"gh {' '.join(arguments[:3])} returned invalid JSON: {error}") from error


def _gh_run_log(run_id: str, root: Path) -> str:
    return _gh_text(["run", "view", run_id, "--log"], root, timeout=GH_TIMEOUT_SECONDS * 5)


def recover_job_id(log: str, run_id: str) -> str:
    """The one durable job the run enqueued (deploy.md: ``sort -u`` of the log
    line, exactly one 64-hex id)."""
    found = sorted(set(JOB_ID_PATTERN.findall(log)))
    if len(found) != 1:
        raise ProductionGateError(
            f"exact deployment job was not recovered from run {run_id}'s log "
            f"({len(found)} 'Queued production worker deployment <id>' lines); do not dispatch "
            "production semantics: inspect `gh run view " + run_id + " --log` and resume the saved job per "
            "deploy.md Step 13"
        )
    return found[0]


def fly_wait(merged_sha: str, *, root: Path, waits: list[dict], state: dict | None = None,
             timeout: float = DEFAULT_FLY_TIMEOUT, start_timeout: float = DEFAULT_FLY_START_TIMEOUT,
             poll_seconds: float = DEFAULT_FLY_POLL_SECONDS, sleep=time.sleep) -> dict:
    """Block until the exact deploy-agents.yml run whose headSha is the merged
    SHA has completed; every GitHub wait lands in ``waits`` and the run's
    identity, conclusion and durable job id land in ``state`` as they are
    learned (so a blocked gate's receipt still names the run). Returns
    ``state``."""
    result = {"required": True} if state is None else state
    result.update(required=True, run_id=None, attempt=None, url=None, status=None, conclusion=None,
                  deployment_token=None, job_id=None, job_stage=None)
    started = time.monotonic()
    run_row: dict | None = None
    polls = 0
    while run_row is None:
        polls += 1
        rows = _gh_json(["run", "list", "--workflow", AGENTS_WORKFLOW, "--branch", "main", "--limit", "30",
                         "--json", "databaseId,headSha,status,conclusion,attempt,url"], root)
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict) and row.get("headSha") == merged_sha:
                run_row = row
                break
        if run_row is None:
            if time.monotonic() - started >= start_timeout:
                waits.append({"workflow": AGENTS_WORKFLOW, "kind": "run-start", "head": merged_sha, "run_id": None,
                              "polls": polls, "waited_s": round(time.monotonic() - started, 1), "outcome": "timeout"})
                raise ProductionGateError(
                    f"exact {AGENTS_WORKFLOW} run for {merged_sha} did not start within {start_timeout:.0f}s; "
                    "do not dispatch production semantics: check GitHub Actions for the merge commit or start it with "
                    f"`gh workflow run {AGENTS_WORKFLOW} --ref main -f expected_sha={merged_sha}`"
                )
            sleep(min(5.0, poll_seconds))
    run_id = str(run_row.get("databaseId"))
    result.update(run_id=run_id, url=run_row.get("url"), status=run_row.get("status"))
    waits.append({"workflow": AGENTS_WORKFLOW, "kind": "run-start", "head": merged_sha, "run_id": run_id,
                  "polls": polls, "waited_s": round(time.monotonic() - started, 1), "outcome": "found"})
    complete_started = time.monotonic()
    polls = 0
    view: dict = {}
    while True:
        polls += 1
        payload = _gh_json(["run", "view", run_id, "--json", "status,conclusion,attempt,url,headSha"], root)
        view = payload if isinstance(payload, dict) else {}
        result.update(status=view.get("status"), url=view.get("url") or result["url"],
                      attempt=str(view.get("attempt") or "") or None)
        if view.get("status") == "completed":
            break
        if time.monotonic() - complete_started >= timeout:
            waits.append({"workflow": AGENTS_WORKFLOW, "kind": "run-complete", "run_id": run_id, "polls": polls,
                          "waited_s": round(time.monotonic() - complete_started, 1), "status": view.get("status"),
                          "outcome": "timeout"})
            raise ProductionGateError(
                f"{AGENTS_WORKFLOW} run {run_id} ({view.get('url') or 'no url'}) is still {view.get('status')} after "
                f"{timeout:.0f}s; CI is still active: retain its job, clocks and Machines and keep observing "
                "(deploy.md Step 13) instead of dispatching production semantics"
            )
        sleep(poll_seconds)
    conclusion = str(view.get("conclusion") or "none")
    attempt = str(view.get("attempt") or "")
    waits.append({"workflow": AGENTS_WORKFLOW, "kind": "run-complete", "run_id": run_id, "attempt": attempt,
                  "polls": polls, "waited_s": round(time.monotonic() - complete_started, 1),
                  "status": "completed", "conclusion": conclusion, "outcome": "completed"})
    result.update(attempt=attempt, url=view.get("url"), status="completed", conclusion=conclusion,
                  deployment_token=f"{run_id}-{attempt}" if attempt else None)
    # The GitHub conclusion is telemetry: a run that concluded failure and was
    # resumed through the queue CLI keeps that conclusion forever (deploy.md
    # Step 13), and `gh run rerun` would mint an attempt whose token the job
    # identity rejects. The durable job recovered from this run's log is the
    # authority for "live" (Step 13ab: stage SUCCEEDED + monitor --verify).
    result["job_id"] = recover_job_id(log=_gh_run_log(run_id, root), run_id=run_id)
    return result


def _dotenv_values(path: Path) -> dict[str, str]:
    """``KEY=VALUE`` lines of an env file (what ``source .env`` exports); values
    are returned, never printed."""
    values: dict[str, str] = {}
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return values
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def surface_hash(root: Path) -> str:
    completed = subprocess.run([sys.executable, str(root / SURFACE_HASH_SCRIPT)], cwd=root, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, timeout=300)
    if completed.returncode != 0 or not completed.stdout.strip():
        raise ProductionGateError(f"could not compute the agent workflow surface hash: {completed.stderr.strip()}")
    return completed.stdout.strip()


def resume_command(job_id: str) -> str:
    """deploy.md Step 13: an interrupted or failed CI cutover resumes the SAME
    durable job from back-end/; never enqueue a replacement or rerun CI."""
    return (f"node --import tsx scripts/worker-deployment-queue.ts run --job-id {job_id} -- "
            "python3 ../scripts/worker_pool_cutover.py")


MAX_SUPERSEDED_CHAIN = 64


def _queue_read(job_id: str, *, backend: Path, env: dict) -> dict:
    read = subprocess.run(["node", "--import", "tsx", "scripts/worker-deployment-queue.ts", "read", "--job-id", job_id],
                          cwd=backend, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=600)
    return _parse_queue_read(read, job_id)


def _parse_queue_read(read: subprocess.CompletedProcess, job_id: str) -> dict:
    if read.returncode != 0:
        raise ProductionGateError(f"worker-deployment-queue.ts read --job-id {job_id} failed: {read.stderr.strip()}")
    try:
        job = json.loads(read.stdout)
        str(job["stage"]), job["identity"]["sourceCommit"], job["identity"]["attempt"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise ProductionGateError(
            f"worker-deployment-queue.ts read --job-id {job_id} returned no job stage/identity: {error}") from error
    return job


def _descendant_cutover(job: dict, merged_sha: str, *, backend: Path, env: dict, root: Path) -> dict:
    """A SUPERSEDED job never cut over itself: a queued git descendant's cutover
    carries its code (worker-deployment-queue.ts coalescing). Follow the durable
    ``evidence.SUPERSEDED.supersededBy`` chain to that job and require it
    SUCCEEDED in the same app, with the merged SHA a real ancestor of its commit."""
    job_id = job["jobId"] if isinstance(job.get("jobId"), str) else ""
    current, chain = job, [job_id]
    while str(current["stage"]) == "SUPERSEDED":
        link = ((current.get("evidence") or {}).get("SUPERSEDED") or {}).get("supersededBy")
        if not isinstance(link, str) or link in chain or len(chain) > MAX_SUPERSEDED_CHAIN:
            raise ProductionGateError(f"superseded job {chain[-1]} has no valid supersededBy link: {link!r}")
        current = _queue_read(link, backend=backend, env=env)
        chain.append(link)
        if current["identity"].get("app") != job["identity"].get("app"):
            raise ProductionGateError(f"superseding job {link} belongs to another app queue")
    descendant_id, descendant_commit = chain[-1], current["identity"]["sourceCommit"]
    if str(current["stage"]) != "SUCCEEDED":
        raise ProductionGateError(
            f"durable job {job_id} is SUPERSEDED by {descendant_id}, which is {current['stage']}, not SUCCEEDED; the Fly "
            f"worker cutover carrying {merged_sha} is NOT live. Do not dispatch production semantics: resume the saved "
            f"deployment from back-end/ with `{resume_command(job_id)}` (it follows the descendant) and rerun this gate")
    ancestry = subprocess.run(["git", "-C", str(root), "merge-base", "--is-ancestor", merged_sha, descendant_commit],
                              env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"}, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, timeout=120)
    if ancestry.returncode != 0:
        verdict = "is not" if ancestry.returncode == 1 else "could not be proven (missing history)"
        raise ProductionGateError(
            f"descendant job {descendant_id} commit {descendant_commit} {verdict} a descendant of {merged_sha}; a "
            "superseding cutover cannot verify this merge")
    return {"descendant_job_id": descendant_id, "descendant_source_commit": descendant_commit,
            "descendant_surface_hash": current["identity"].get("surfaceHash"), "chain": chain}


def cutover_verify(fly: dict, merged_sha: str, expected_hash: str, *, root: Path) -> dict:
    """deploy.md Step 13ab for the cooperative route: the saved job must be
    ``SUCCEEDED`` (CI cut over only when its durable job is; a green build or
    the run's conclusion is insufficient) and carry this merged SHA and
    workflow attempt, then the managed monitor ``--verify`` is authoritative
    for the job, its pointer and retained bank evidence. ``fly['job_stage']``
    records the stage read, separately from the run's conclusion. A
    ``SUPERSEDED`` job is verified by its descendant's cutover instead
    (``verified_by: descendant-cutover``), never reported as its own."""
    backend = root / "back-end"
    env = {**os.environ, **_dotenv_values(backend / ".env")}
    job_id = fly["job_id"]
    read = subprocess.run(["node", "--import", "tsx", "scripts/worker-deployment-queue.ts", "read", "--job-id", job_id],
                          cwd=backend, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=600)
    job = _parse_queue_read(read, job_id)
    stage, identity = str(job["stage"]), job["identity"]
    source_commit, attempt = identity["sourceCommit"], identity["attempt"]
    fly["job_stage"] = stage
    refusal = ((job.get("evidence") or {}).get("ABORTED") or {}) if stage == "ABORTED" else {}
    if refusal.get("reason") == "ROLLBACK_REFUSED":
        raise ProductionGateError(
            f"durable job {job_id} was refused before cutover: {refusal.get('message')} (live job "
            f"{refusal.get('liveJobId')}); the Fly worker cutover did NOT run for {merged_sha} and production was not "
            "rolled back. Do not dispatch production semantics or resume this job: deploy a release that contains "
            "the live commit")
    if stage not in ("SUCCEEDED", "SUPERSEDED"):
        raise ProductionGateError(
            f"durable job {job_id} is {stage}, not SUCCEEDED (run {fly.get('run_id')} concluded "
            f"{fly.get('conclusion')}); the Fly worker cutover is NOT live for {merged_sha}. Do not dispatch "
            f"production semantics: resume the saved deployment from back-end/ with `{resume_command(job_id)}` "
            "and rerun this gate once the durable job is SUCCEEDED"
        )
    if source_commit != merged_sha or attempt != fly["deployment_token"]:
        raise ProductionGateError(
            f"job {job_id} source/attempt mismatch: job sourceCommit={source_commit} attempt={attempt}, expected "
            f"{merged_sha} / {fly['deployment_token']}; a prior rollout of the same SHA cannot authorize this deploy"
        )
    descendant = None
    if stage == "SUPERSEDED":
        descendant = _descendant_cutover({**job, "jobId": job_id}, merged_sha, backend=backend, env=env, root=root)
        fly["verified_by_descendant"] = descendant
        # The descendant's own durable identity binds its surface; this merge's hash may legitimately differ.
        command = ["node", "--import", "tsx", "scripts/monitor-cooperative-cutover.ts", "--job-id",
                   descendant["descendant_job_id"], "--verify"]
    else:
        command = ["node", "--import", "tsx", "scripts/monitor-cooperative-cutover.ts", "--job-id", job_id,
                   "--expected-hash", expected_hash, "--verify"]
    monitor = subprocess.run(command, cwd=backend, env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=3600)
    tail = monitor.stdout[-2000:]
    if monitor.returncode != 0:
        raise ProductionGateError(
            f"monitor-cooperative-cutover.ts --verify failed (exit {monitor.returncode}) for job {command[6]}: {tail.strip()}"
        )
    result = {"job_id": job_id, "job_stage": stage, "source_commit": source_commit, "attempt": attempt,
              "expected_hash": expected_hash, "queue_read": "ok", "monitor_verify_exit": 0, "monitor_tail": tail}
    if descendant:
        result.update(verified_by="descendant-cutover", **descendant)
    return result


def _read_production_receipt(path: Path) -> object:
    """``production.json`` as parsed, whatever JSON it holds (its callers check
    the shape themselves), or None when absent or invalid. Distinct from
    ``_read_receipt`` above, which returns only a dict (the deploy-lane
    ``receipt.json`` contract: a non-dict file reads as no receipt)."""
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def production(merged_sha: str, state_dir: Path, dispatch: list[str] | None = None, *, root: Path | None = None,
               expected_hash: str | None = None, timeout: float = DEFAULT_FLY_TIMEOUT,
               start_timeout: float = DEFAULT_FLY_START_TIMEOUT, poll_seconds: float = DEFAULT_FLY_POLL_SECONDS) -> int:
    """Gate the production semantic dispatch on every exercised surface being
    live. The Vercel wait stays in deploy.md Step 13 and the Render wait is
    ``production-render`` (Step 13a); this command owns the Fly lane: when the merge touches agent runtime files (or
    deploy-agents.yml) it waits for the exact deploy-agents.yml run on the
    merged SHA to complete, recovers its durable job id, runs the Step 13ab
    proof (job SUCCEEDED + identity + monitor --verify), and only then runs
    ``dispatch`` (when given). A still-running run, a job that is not
    SUCCEEDED, an identity mismatch or a failed monitor exits 1 with the
    operator's next action and never dispatches. The receipt
    ``production.json`` in ``state_dir`` records the decision, the run
    id/attempt/job id, the run conclusion and job stage separately, and every
    GitHub wait. The ``render`` lane (``production-render``, Step 13a) of the
    same merged SHA is carried forward and never overwritten."""
    root = SOURCE_ROOT if root is None else root
    state_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = state_dir / PRODUCTION_RECEIPT
    waits: list[dict] = []
    receipt: dict = {"schema_version": PRODUCTION_SCHEMA, "merged_sha": merged_sha, "started_at": _now(),
                     "started_epoch": time.time(), "github_waits": waits, "status": "running",
                     "fly": {"required": None}, "cutover_verify": None, "semantic_dispatch": None}
    # Re-running the Step 13b block (production -> production-semantic) must not
    # forget the semantic lane of the same merged SHA: its recorded run, the one
    # consumed retry and its GitHub waits are carried forward so a resumed watch
    # or `--retry-failed-once` binds to that run and a second retry stays refused.
    previous = _read_production_receipt(receipt_path)
    if isinstance(previous, dict) and previous.get("merged_sha") == merged_sha:
        for key in ("semantic", "semantic_history", "render"):
            if key in previous:
                receipt[key] = previous[key]
        waits.extend(wait for wait in previous.get("github_waits") or []
                     if isinstance(wait, dict) and wait.get("workflow") == SEMANTIC_WORKFLOW)
    _write_production_receipt(receipt_path, receipt)

    def finish(status: str, code: int, error: str | None = None) -> int:
        receipt.update(status=status, finished_at=_now(), wall_s=round(time.time() - receipt["started_epoch"], 1))
        if error:
            receipt["error"] = error
        _write_production_receipt(receipt_path, receipt)
        return code

    try:
        changed = merged_changes(merged_sha, root)
        cutover = agent_cutover_required(changed, root)
        receipt["changed_files"] = len(changed)
        receipt["agent_cutover"] = cutover
        if cutover["required"]:
            print(f"PIPELINE_PRODUCTION fly=required head={merged_sha} runtime_files={len(cutover['runtime_files'])} "
                  f"workflow_changed={cutover['workflow_changed']}: waiting for the exact {AGENTS_WORKFLOW} run",
                  flush=True)
            try:
                fly_wait(merged_sha, root=root, waits=waits, state=receipt["fly"], timeout=timeout,
                         start_timeout=start_timeout, poll_seconds=poll_seconds)
            except ProductionGateError:
                _write_production_receipt(receipt_path, receipt)
                raise
            fly = receipt["fly"]
            print(f"PIPELINE_PRODUCTION fly=completed run={fly['run_id']} attempt={fly['attempt']} "
                  f"conclusion={fly['conclusion']} job={fly['job_id']}", flush=True)
            _write_production_receipt(receipt_path, receipt)
            expected = expected_hash or surface_hash(root)
            try:
                receipt["cutover_verify"] = cutover_verify(fly, merged_sha, expected, root=root)
            except ProductionGateError:
                _write_production_receipt(receipt_path, receipt)  # keeps fly.job_stage for the operator
                raise
            carried = receipt["cutover_verify"].get("descendant_job_id")
            print(f"PIPELINE_PRODUCTION cutover=verified job={fly['job_id']} job_stage={fly['job_stage']} "
                  f"hash={expected}" + (f" verified_by=descendant-cutover descendant={carried}" if carried else ""),
                  flush=True)
        else:
            receipt["fly"] = {"required": False, "reason": "no agent runtime or deploy-agents.yml change in the merge"}
            print(f"PIPELINE_PRODUCTION fly=not-required head={merged_sha} ({len(changed)} changed files, "
                  "no agent runtime change): no deploy-agents.yml wait", flush=True)
    except ProductionGateError as error:
        print(f"PIPELINE_PRODUCTION status=blocked exit=1 {error}", flush=True)
        return finish("failed", 1, str(error))
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as error:
        detail = getattr(error, "stderr", "") or ""
        message = f"{type(error).__name__}: {error} {detail.strip() if isinstance(detail, str) else ''}".strip()
        print(f"PIPELINE_PRODUCTION status=error exit=2 {message}", flush=True)
        return finish("failed", 2, message)
    if dispatch:
        receipt["semantic_dispatch"] = {"command": list(dispatch), "at": _now(), "exit": None}
        _write_production_receipt(receipt_path, receipt)
        completed = subprocess.run(dispatch, cwd=root)
        receipt["semantic_dispatch"]["exit"] = completed.returncode
        print(f"PIPELINE_PRODUCTION dispatch exit={completed.returncode}", flush=True)
        if completed.returncode != 0:
            return finish("failed", completed.returncode, f"dispatch command exited {completed.returncode}")
    else:
        receipt["semantic_dispatch"] = {"command": None, "gate": "open"}
    print(f"PIPELINE_PRODUCTION status=open exit=0 head={merged_sha} receipt={receipt_path}", flush=True)
    return finish("passed", 0)


# ── Post-merge Render lane (deploy.md Step 13a step 1) ────────────────────────
# ``production-render`` waits for Render to serve the merged backend. Render
# auto-deploy skips a commit that changes nothing under the service's Root
# Directory (back-end/), so no deploy for the merged SHA ever appears; the raw
# exact-SHA poll then spun to its bound twice on 2026-10-31 (#1652, #1655)
# until a human proved by hand that the live deploy's commit is an ancestor of
# the merged SHA with no backend change between them. That proof is now the
# CLI's: the live backend IS the merged backend (``source-equivalent``),
# recorded in ``production.json`` beside the Fly and semantic lanes of the
# same merged SHA.
RENDER_API_BASE = "https://api.render.com/v1"
# Paths whose change can change the backend Render builds: the service root,
# the Blueprint file should one land, and the root npm workspace manifests
# (Render's build with Root Directory back-end resolves the root workspace
# graph; deploy.md treats root package.json / package-lock.json as backend
# inputs, see docs/rca/cases/2026-07-25-floating-dep-spec-without-frontend-
# lockfile-breaks-render-build.md). Equivalence assumes the Render service's
# Root Directory is back-end with no build filters. Any change under these
# paths keeps the exact-SHA wait.
RENDER_SERVICE_PATHS = ("back-end/", "render.yaml", "package.json", "package-lock.json")
RENDER_FAILED_STATUSES = frozenset({"build_failed", "update_failed", "canceled", "pre_deploy_failed"})
# A merged deploy in one of these states was replaced: Render cancels a deploy a
# newer main commit superseded and deactivates a live deploy once a newer one
# goes live. It is verified only by a live deploy of a strict descendant of the
# merged SHA (``verified-by-descendant``); otherwise it blocks as before.
RENDER_SUPERSEDED_STATUSES = frozenset({"canceled", "deactivated"})
RENDER_TERMINAL_STATUSES = RENDER_FAILED_STATUSES | RENDER_SUPERSEDED_STATUSES | {"live"}
# deploy.md Step 13a: 90 x 10 s (Render builds can be slow).
DEFAULT_RENDER_TIMEOUT = 900.0
DEFAULT_RENDER_POLL_SECONDS = 10.0
RENDER_HTTP_TIMEOUT_SECONDS = 30.0
RENDER_DEPLOYS_LIMIT = 20


class ProductionToolingError(RuntimeError):
    """The gate could not decide (credentials, provider API, git): exit 2,
    never a pass; the message names what to repair before rerunning."""


def _write_production_receipt(path: Path, receipt: dict) -> None:
    """Write a lane's view of ``production.json`` without dropping the Render
    lane another process records in the same file for the same merged SHA:
    deploy.md Step 13a runs ``production-render`` beside the Fly/semantic
    commands, and only ``production-render`` writes ``render``, so the copy on
    disk is authoritative for that key."""
    current = _read_production_receipt(path)
    if isinstance(current, dict) and current.get("merged_sha") == receipt.get("merged_sha") and "render" in current:
        receipt["render"] = current["render"]
    write_receipt(path, receipt)


def render_credentials(root: Path) -> tuple[str, str]:
    """``RENDER_API_KEY`` / ``RENDER_SERVICE_ID`` from the environment or
    ``back-end/.env`` (deploy.md sources it); values are never printed."""
    values = _dotenv_values(root / "back-end" / ".env")
    key = os.environ.get("RENDER_API_KEY") or values.get("RENDER_API_KEY", "")
    service = os.environ.get("RENDER_SERVICE_ID") or values.get("RENDER_SERVICE_ID", "")
    missing = [name for name, value in (("RENDER_API_KEY", key), ("RENDER_SERVICE_ID", service)) if not value]
    if missing:
        raise ProductionToolingError(
            f"{' and '.join(missing)} not set (environment or back-end/.env); the Render lane cannot be verified "
            "without the Render API: restore back-end/.env from the authoritative env files and rerun")
    return key, service


def render_deploys(service_id: str, api_key: str, *, base: str | None = None) -> list[dict]:
    """The service's newest deploys (``GET /services/<id>/deploys``), newest
    first, unwrapped from Render's ``{"deploy": ..., "cursor": ...}`` rows. Any
    HTTP, network or JSON failure raises ``ProductionToolingError``: the
    gate fails closed instead of guessing."""
    base = (base or os.environ.get("DEPLOY_RENDER_API_BASE") or RENDER_API_BASE).rstrip("/")
    url = f"{base}/services/{service_id}/deploys?limit={RENDER_DEPLOYS_LIMIT}"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=RENDER_HTTP_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as error:
        raise ProductionToolingError(
            f"Render API GET {url} returned HTTP {error.code}; the live backend cannot be verified: check the Render "
            "API key/service id and Render status, then rerun this gate") from error
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise ProductionToolingError(
            f"Render API GET {url} failed ({type(error).__name__}: {error}); the live backend cannot be verified: "
            "rerun this gate once the Render API is reachable") from error
    if not isinstance(payload, list):
        raise ProductionToolingError(f"Render API GET {url} returned {type(payload).__name__}, not a deploy list")
    deploys: list[dict] = []
    for row in payload:
        if isinstance(row, dict):
            deploy = row.get("deploy", row)
            if isinstance(deploy, dict):
                deploys.append(deploy)
    return deploys


def _render_commit(deploy: dict) -> str:
    commit = deploy.get("commit")
    return str(commit.get("id") or "") if isinstance(commit, dict) else ""


def render_deploy_for(deploys: list[dict], merged_sha: str) -> dict | None:
    """The newest deploy Render created for the merged commit, if any."""
    for deploy in deploys:
        if _render_commit(deploy) == merged_sha:
            return deploy
    return None


def render_live_deploy(deploys: list[dict]) -> dict | None:
    """The deploy currently serving traffic (newest ``live`` row)."""
    for deploy in deploys:
        if deploy.get("status") == "live":
            return deploy
    return None


def _git_lines(arguments: list[str], root: Path) -> list[str]:
    completed = subprocess.run(["git", *arguments], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, timeout=300)
    if completed.returncode != 0:
        raise ProductionToolingError(f"git {' '.join(arguments[:3])} failed: {completed.stderr.strip()}")
    return [line for line in completed.stdout.splitlines() if line]


def _is_ancestor(older: str, newer: str, root: Path) -> bool:
    """``git merge-base --is-ancestor older newer``. A commit unknown to this
    checkout (a newer main merge that landed after this checkout fetched) gets
    one ``git fetch origin main`` and a retry; any remaining git failure is a
    tooling error, never an answer."""
    def check() -> subprocess.CompletedProcess:
        return subprocess.run(["git", "merge-base", "--is-ancestor", older, newer], cwd=root,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=300)
    completed = check()
    if completed.returncode not in (0, 1):
        fetched = subprocess.run(["git", "fetch", "--quiet", "origin", "main"], cwd=root, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, timeout=300)
        if fetched.returncode == 0:
            completed = check()
    if completed.returncode not in (0, 1):
        raise ProductionToolingError(
            f"git merge-base --is-ancestor {older} {newer} failed ({completed.stderr.strip()}); fetch origin main so "
            "both commits are known locally, then rerun this gate")
    return completed.returncode == 0


def render_source_equivalence(live_commit: str, merged_sha: str, root: Path | None = None) -> dict:
    """Is the live deploy's backend the merged backend? Yes only when nothing
    under ``RENDER_SERVICE_PATHS`` differs between the two commits AND they lie
    on one line of history: the live commit is an ancestor of the merged SHA
    (the merge built on what is live and Render skipped it: nothing under its
    Root Directory changed) or a descendant of it (another PR deployed after
    the merge without touching those paths, so the live backend is
    byte-identical to the merged one). A descendant that changed those paths
    is refused: the merged backend never ran as-is, which is a manual
    decision. An unrelated live commit is never equivalent. ``reason`` is one
    of ``live-ancestor-same-backend``, ``live-descendant-same-backend``,
    ``live-ancestor-backend-changed``, ``live-descendant-backend-changed``,
    ``live-unrelated``; ``detail`` explains it. A live commit unknown to this
    checkout is a tooling error (fetch origin), never a pass."""
    root = SOURCE_ROOT if root is None else root
    live_is_ancestor = _is_ancestor(live_commit, merged_sha, root)
    live_is_descendant = not live_is_ancestor and _is_ancestor(merged_sha, live_commit, root)
    relationship = "ancestor" if live_is_ancestor else "descendant" if live_is_descendant else "unrelated"
    backend_diff = _git_lines(["diff", "--name-only", live_commit, merged_sha, "--", *RENDER_SERVICE_PATHS], root)
    changed = _git_lines(["diff", "--name-only", live_commit, merged_sha], root)
    paths = ", ".join(RENDER_SERVICE_PATHS)
    live_short, merged_short = live_commit[:9], merged_sha[:9]
    if relationship == "unrelated":
        reason = "live-unrelated"
        detail = (f"live commit {live_short} is neither an ancestor nor a descendant of merged {merged_short}; "
                  "its backend history is unrelated to the merge")
    elif backend_diff:
        reason = f"live-{relationship}-backend-changed"
        detail = f"{len(backend_diff)} path(s) under {paths} differ between live {live_short} and merged {merged_short}"
        detail += ("; the live descendant contains the merge, so it can be verified by descendant, never "
                   "source-equivalent" if live_is_descendant else "; Render builds the merged backend")
    else:
        reason = f"live-{relationship}-same-backend"
        detail = (f"live commit {live_short} is an {relationship} of merged {merged_short} with no change under "
                  f"{paths} between them")
        detail += (" (Render auto-deploy skipped the merge: nothing under its Root Directory changed)"
                   if live_is_ancestor else " (a later deploy of the identical backend)")
    return {"live_commit": live_commit, "merged_sha": merged_sha, "live_is_ancestor": live_is_ancestor,
            "live_is_descendant": live_is_descendant, "relationship": relationship,
            "service_paths": list(RENDER_SERVICE_PATHS), "backend_diff": backend_diff,
            "changed_files": changed[:40], "changed_count": len(changed),
            "equivalent": relationship != "unrelated" and not backend_diff, "reason": reason, "detail": detail}


def render_wait(merged_sha: str, *, root: Path, state: dict, fetch, timeout: float = DEFAULT_RENDER_TIMEOUT,
                poll_seconds: float = DEFAULT_RENDER_POLL_SECONDS, sleep=time.sleep, log=print) -> dict:
    """Poll ``fetch()`` (the service's deploys) until the merged backend is
    served. A deploy for the merged SHA is the authority when Render created
    one: ``live`` opens the gate, a failed status blocks it, anything else
    keeps polling. A merged deploy Render ``canceled`` or ``deactivated``
    (a newer main commit replaced it) opens as ``verified-by-descendant`` only
    when the live deploy's commit strictly descends from the merged SHA; while
    a descendant's deploy is still in progress it keeps polling, and with none
    live or deploying it blocks (an older, unrelated or failed rollout is
    never accepted). With no deploy for the merged SHA, the live deploy's
    commit is tested once per distinct commit with ``render_source_equivalence``:
    equivalence opens the gate as ``source-equivalent`` and a live descendant
    that changed the backend as ``verified-by-descendant``. The bound elapses
    into ``timeout`` (blocked, as before). ``state`` records every fact as it
    is learned, including ``observed_live_commit`` on every poll, so a
    blocked gate's receipt still names what was live."""
    state.update(status="waiting", live_commit=None, observed_live_commit=None, observed_live_deploy_id=None,
                 deploy_id=None, deploy_status=None, backend_diff=None, equivalence=None, polls=0)
    started = time.monotonic()
    evaluated: dict[str, dict] = {}
    descends: dict[str, bool] = {}
    last_seen = "none"

    def descendant(commit: str) -> bool:
        if commit not in descends:
            descends[commit] = bool(commit) and commit != merged_sha and _is_ancestor(merged_sha, commit, root)
        return descends[commit]

    def verified(reason: str, live: dict, live_commit: str, mine: dict | None, detail: str) -> dict:
        state["verified_by_descendant"] = {
            "reason": reason, "merged_sha": merged_sha, "live_commit": live_commit, "live_deploy_id": live.get("id"),
            "merged_deploy_id": mine.get("id") if mine else None,
            "merged_deploy_status": str(mine.get("status") or "") if mine else None, "detail": detail}
        state.update(status="verified-by-descendant", live_commit=live_commit, deploy_id=live.get("id"),
                     deploy_status="live", waited_s=round(time.monotonic() - started, 1))
        log(f"  Render: verified by descendant live={live_commit[:9]} merged={merged_sha[:9]} reason={reason}: "
            f"{detail}", flush=True)
        return state

    while True:
        state["polls"] += 1
        deploys = fetch()
        mine = render_deploy_for(deploys, merged_sha)
        live = render_live_deploy(deploys)
        live_commit = _render_commit(live) if live else ""
        state.update(observed_live_commit=live_commit or None, observed_live_deploy_id=live.get("id") if live else None)
        if mine is not None:
            status = str(mine.get("status") or "")
            last_seen = status or "unknown"
            state.update(deploy_id=mine.get("id"), deploy_status=status)
            log(f"  Render: status={status} commit={merged_sha[:7]} (want {merged_sha[:7]}); "
                f"live commit={live_commit[:7] or 'none'}", flush=True)
            if status == "live":
                state.update(status="live", live_commit=merged_sha, backend_diff=[],
                             waited_s=round(time.monotonic() - started, 1))
                return state
            if status in RENDER_SUPERSEDED_STATUSES:
                if live and descendant(live_commit):
                    return verified(f"merged-deploy-{status}-live-descendant", live, live_commit, mine,
                                    f"Render {status} deploy {mine.get('id')} of the merged commit; live deploy "
                                    f"{live.get('id')} serves {live_commit[:9]}, a descendant of {merged_sha[:9]}")
                pending = [row for row in deploys if row is not mine and _render_commit(row)
                           and str(row.get("status") or "") not in RENDER_TERMINAL_STATUSES
                           and descendant(_render_commit(row))]
                if pending:
                    last_seen = f"{status}; descendant {_render_commit(pending[0])[:7]} {pending[0].get('status')}"
                    log(f"  Render: merged deploy {status}; waiting for descendant "
                        f"{_render_commit(pending[0])[:9]} ({pending[0].get('status')})", flush=True)
                else:
                    relation = ("none is live" if not live_commit else f"live commit {live_commit[:9]} is not a "
                                f"descendant of {merged_sha[:9]}")
                    state.update(status="deploy-failed", waited_s=round(time.monotonic() - started, 1))
                    raise ProductionGateError(
                        f"Render deploy {status} for {merged_sha[:7]} (deploy {mine.get('id')}) and no newer "
                        f"descendant of it is live or deploying ({relation}); a merged backend Render replaced is "
                        "verified only by a live descendant: check the Render dashboard, never redeploy an older "
                        "commit over a newer live main, then rerun this gate or continue per deploy.md (Review)")
            elif status in RENDER_FAILED_STATUSES:
                state.update(status="deploy-failed", waited_s=round(time.monotonic() - started, 1))
                raise ProductionGateError(
                    f"Render deploy {status} for {merged_sha[:7]} (deploy {mine.get('id')}); fetch its logs "
                    f"(GET /v1/services/<service>/deploys/{mine.get('id')} or the Render dashboard), fix, new PR, "
                    "continue per deploy.md (Review)")
        else:
            last_seen = f"no deploy for {merged_sha[:7]}"
            log(f"  Render: no deploy for {merged_sha[:7]}; live commit={live_commit[:7] or 'none'}", flush=True)
            if live_commit and live_commit != merged_sha:
                if live_commit not in evaluated:
                    evaluated[live_commit] = render_source_equivalence(live_commit, merged_sha, root)
                    state["equivalence"] = evaluated[live_commit]
                    state["backend_diff"] = evaluated[live_commit]["backend_diff"]
                    log(f"  Render: live={live_commit[:9]} equivalent={evaluated[live_commit]['equivalent']} "
                        f"reason={evaluated[live_commit]['reason']}: {evaluated[live_commit]['detail']}", flush=True)
                equivalence = evaluated[live_commit]
                if equivalence["equivalent"]:
                    state.update(status="source-equivalent", live_commit=live_commit, deploy_id=live.get("id"),
                                 deploy_status="live", backend_diff=[], waited_s=round(time.monotonic() - started, 1))
                    return state
                if equivalence["live_is_descendant"]:
                    state.update(equivalence=equivalence, backend_diff=equivalence["backend_diff"])
                    return verified(equivalence["reason"], live, live_commit, None, equivalence["detail"])
        if time.monotonic() - started >= timeout:
            state.update(status="timeout", waited_s=round(time.monotonic() - started, 1))
            verdict = ""
            if live_commit and live_commit != merged_sha:
                reason = evaluated.get(live_commit, {}).get("reason", "unevaluated")
                verdict = f"; live commit {live_commit[:9]} is not source-equivalent ({reason})"
            raise ProductionGateError(
                f"Render did not bring {merged_sha[:7]} live within {timeout:.0f}s (last status: {last_seen}{verdict}); "
                "check the Render dashboard for a deploy of the merged commit and rerun this gate")
        sleep(poll_seconds)


def production_render(merged_sha: str, state_dir: Path, then: list[str] | None = None, *, root: Path | None = None,
                      timeout: float = DEFAULT_RENDER_TIMEOUT, poll_seconds: float = DEFAULT_RENDER_POLL_SECONDS,
                      sleep=time.sleep, fetch=None) -> int:
    """deploy.md Step 13a step 1 as a CLI. Resolves the Render credentials,
    runs ``render_wait`` and records the lane under ``render`` in
    ``production.json`` (merged into the receipt of the same merged SHA, never
    replacing the Fly/semantic lanes). Prints ``RENDER_LIVE commit=<sha>``,
    ``RENDER_SOURCE_EQUIVALENT live=<sha> merged=<sha> reason=<code>`` or
    ``RENDER_VERIFIED_BY_DESCENDANT live=<sha> merged=<sha> reason=<code>`` and
    then runs the optional command after ``--`` only when the gate opened,
    recording its exit (the regression uses it to prove the gate opened;
    deploy.md's Step 13a probes follow in their own blocks). Exit 0 = the live
    backend is the merged backend (or a live descendant containing it), 1 = blocked (Render deploy failed or the
    bound elapsed), 2 = could not decide (credentials, Render API, git); a
    non-zero ``then`` exit is returned as is."""
    root = SOURCE_ROOT if root is None else root
    state_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = state_dir / PRODUCTION_RECEIPT
    entry: dict = {"provider": "render", "merged_sha": merged_sha, "started_at": _now(), "status": "starting",
                   "service_paths": list(RENDER_SERVICE_PATHS), "then": None}
    started_epoch = time.time()

    def save() -> None:
        current = _read_production_receipt(receipt_path)
        if not isinstance(current, dict) or current.get("merged_sha") != merged_sha:
            current = {"schema_version": PRODUCTION_SCHEMA, "merged_sha": merged_sha}
        current["render"] = entry
        write_receipt(receipt_path, current)

    def finish(code: int, error: str | None = None) -> int:
        entry.update(finished_at=_now(), wall_s=round(time.time() - started_epoch, 1))
        if error:
            entry["error"] = error
        save()
        print(f"RENDER_LANE_END {entry['finished_at']} exit={code} status={entry['status']}", flush=True)
        return code

    print(f"RENDER_LANE_START {entry['started_at']} merged={merged_sha}", flush=True)
    save()
    try:
        if fetch is None:
            api_key, service_id = render_credentials(root)

            def fetch() -> list[dict]:
                return render_deploys(service_id, api_key)
        render_wait(merged_sha, root=root, state=entry, fetch=fetch, timeout=timeout, poll_seconds=poll_seconds,
                    sleep=sleep)
    except ProductionGateError as error:
        print(f"PIPELINE_RENDER status=blocked exit=1 {error}", flush=True)
        return finish(1, str(error))
    except (ProductionToolingError, subprocess.TimeoutExpired, OSError) as error:
        if entry.get("status") in (None, "starting", "waiting"):
            entry["status"] = "error"
        print(f"PIPELINE_RENDER status=error exit=2 {error}", flush=True)
        return finish(2, str(error))
    if entry["status"] == "source-equivalent":
        equivalence = entry["equivalence"]
        print(f"RENDER_SOURCE_EQUIVALENT live={entry['live_commit']} merged={merged_sha} "
              f"reason={equivalence['reason']}: {equivalence['detail']}; the live backend is the merged backend",
              flush=True)
    elif entry["status"] == "verified-by-descendant":
        descendant = entry["verified_by_descendant"]
        print(f"RENDER_VERIFIED_BY_DESCENDANT live={entry['live_commit']} merged={merged_sha} "
              f"reason={descendant['reason']}: {descendant['detail']}; the live backend contains the merge "
              "(not an exact-SHA deploy)", flush=True)
    else:
        print(f"RENDER_LIVE commit={merged_sha} deploy={entry.get('deploy_id')}", flush=True)
    save()
    if then:
        entry["then"] = {"command": list(then), "at": _now(), "exit": None}
        save()
        completed = subprocess.run(then, cwd=root)
        entry["then"]["exit"] = completed.returncode
        print(f"PIPELINE_RENDER then exit={completed.returncode}", flush=True)
        if completed.returncode != 0:
            return finish(completed.returncode, f"follow-up command exited {completed.returncode}")
    print(f"PIPELINE_RENDER status=open exit=0 head={merged_sha} live={entry['live_commit']} "
          f"receipt={receipt_path}", flush=True)
    return finish(0)


# ── Post-merge production semantic gate (deploy.md Step 13b) ──────────────────
# ``production-semantic`` dispatches the trusted production semantic workflow
# on the exact merged commit and watches the run that dispatch created. The
# #1646 deploy (2026-10-31) ran ``gh workflow run ... --ref main`` after a
# data-only commit had landed on main, so the run's headSha was not the merged
# SHA and the deploy had to record a separate source-equivalence proof.
# ``workflow_dispatch`` refs must be branches or tags, so the commit travels as
# the workflow's ``source_sha`` input and the workflow's run-name names it;
# the watcher binds to that title, never to the branch head.
SEMANTIC_WORKFLOW = "chat-lifecycle-ratchet.yml"
SEMANTIC_DISPATCH_REF = "main"
SEMANTIC_FRONTEND_URL = "https://www.roselabs.ai"
SEMANTIC_BACKEND_URL = "https://navi-j9a9.onrender.com"
SEMANTIC_TITLE_PATTERN = re.compile(r"source_sha=([0-9a-f]{40})")
# Both workflow jobs allow 30 minutes plus runner queueing; the run is polled
# every 30 s (the repo's 5000/h token quota is shared with other lanes).
DEFAULT_SEMANTIC_START_TIMEOUT = 300.0
DEFAULT_SEMANTIC_TIMEOUT = 3600.0
DEFAULT_SEMANTIC_POLL_SECONDS = 30.0
# GitHub stamps createdAt on its own clock: a run stamped up to this much
# before the local dispatch clock still belongs to this dispatch; anything
# older never matches.
DISPATCH_CLOCK_SKEW_S = 5.0
# A dispatch `gh workflow run` confirmed (exit 0) whose run was never adopted
# (a `gh run list` failure or a discovery timeout right after it) is a live
# production dispatch: the next call looks for its run instead of dispatching
# again. Only a confirmed dispatch older than this with still no run is
# abandoned and dispatched anew.
SEMANTIC_DISPATCH_RESUME_WINDOW_S = 15 * 60.0
SEMANTIC_RUN_FIELDS = "databaseId,createdAt,headSha,displayTitle,status,conclusion,url,event"
SEMANTIC_VIEW_FIELDS = "status,conclusion,attempt,url,headSha,displayTitle,createdAt,updatedAt,jobs"


def _parse_github_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def semantic_select_run(rows: object, merged_sha: str, dispatched_at: datetime) -> dict | None:
    """The newest ``workflow_dispatch`` run this dispatch created: created no
    earlier than the dispatch clock (minus ``DISPATCH_CLOCK_SKEW_S``) and
    titled ``source_sha=<merged_sha>`` by the workflow's run-name. Older runs
    and runs of another source commit never match, whatever their headSha
    (the branch head at dispatch time, which may be a later commit)."""
    earliest = dispatched_at - timedelta(seconds=DISPATCH_CLOCK_SKEW_S)
    matches: list[tuple[datetime, int, dict]] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        created = _parse_github_time(row.get("createdAt"))
        title = SEMANTIC_TITLE_PATTERN.search(str(row.get("displayTitle") or ""))
        if created is None or created < earliest or title is None or title.group(1) != merged_sha:
            continue
        if row.get("event") not in (None, "workflow_dispatch"):
            continue
        matches.append((created, int(row.get("databaseId") or 0), row))
    if not matches:
        return None
    matches.sort(key=lambda item: (item[0], item[1]))
    return matches[-1][2]


def semantic_pending_dispatch(entry: object, merged_sha: str) -> datetime | None:
    """The dispatch clock of a recorded ``semantic`` entry for ``merged_sha``
    whose ``gh workflow run`` succeeded (``status == "dispatched"``) but that
    never adopted a run (``run_id`` null); None for anything else."""
    if not isinstance(entry, dict) or entry.get("run_id") or entry.get("status") != "dispatched":
        return None
    if entry.get("merged_sha") != merged_sha:
        return None
    dispatch = entry.get("dispatch") if isinstance(entry.get("dispatch"), dict) else {}
    return _parse_github_time(dispatch.get("at"))


def _semantic_jobs(view: dict) -> list[dict]:
    jobs = view.get("jobs")
    if not isinstance(jobs, list):
        return []
    return [{"name": job.get("name"), "status": job.get("status"), "conclusion": job.get("conclusion"),
             "url": job.get("url")} for job in jobs if isinstance(job, dict)]


def _semantic_wait_complete(run_id: str, *, root: Path, waits: list[dict], entry: dict, min_attempt: int,
                            timeout: float, poll_seconds: float, sleep) -> None:
    """Poll the run until it is ``completed`` at an attempt >= ``min_attempt``
    (right after ``gh run rerun`` the view can still show the previous
    completed attempt). Run identity, GitHub status, attempt, per-job
    conclusions and the wait land in ``entry``/``waits`` as they are learned."""
    started = time.monotonic()
    polls = 0
    while True:
        polls += 1
        payload = _gh_json(["run", "view", run_id, "--json", SEMANTIC_VIEW_FIELDS], root)
        view = payload if isinstance(payload, dict) else {}
        attempt = int(view.get("attempt") or 0)
        entry.update(status=view.get("status"), attempt=attempt or entry.get("attempt"),
                     url=view.get("url") or entry.get("url"), head_sha=view.get("headSha") or entry.get("head_sha"),
                     display_title=view.get("displayTitle") or entry.get("display_title"),
                     created_at=view.get("createdAt") or entry.get("created_at"), jobs=_semantic_jobs(view))
        if view.get("status") == "completed" and attempt >= min_attempt:
            conclusion = str(view.get("conclusion") or "none")
            entry.update(conclusion=conclusion, completed_at=view.get("updatedAt"))
            waits.append({"workflow": SEMANTIC_WORKFLOW, "kind": "run-complete", "run_id": run_id, "attempt": attempt,
                          "polls": polls, "waited_s": round(time.monotonic() - started, 1), "status": "completed",
                          "conclusion": conclusion, "outcome": "completed"})
            return
        if time.monotonic() - started >= timeout:
            waits.append({"workflow": SEMANTIC_WORKFLOW, "kind": "run-complete", "run_id": run_id, "attempt": attempt,
                          "polls": polls, "waited_s": round(time.monotonic() - started, 1),
                          "status": view.get("status"), "outcome": "timeout"})
            raise ProductionGateError(
                f"{SEMANTIC_WORKFLOW} run {run_id} ({view.get('url') or 'no url'}) is still {view.get('status')} after "
                f"{timeout:.0f}s; the gate is not green: keep observing it (`gh run view {run_id}`) and rerun this "
                "command once it is terminal"
            )
        sleep(poll_seconds)


def production_semantic(merged_sha: str, state_dir: Path, *, frontend_url: str = SEMANTIC_FRONTEND_URL,
                        backend_url: str = SEMANTIC_BACKEND_URL, retry_justification: str | None = None,
                        root: Path | None = None, timeout: float = DEFAULT_SEMANTIC_TIMEOUT,
                        start_timeout: float = DEFAULT_SEMANTIC_START_TIMEOUT,
                        poll_seconds: float = DEFAULT_SEMANTIC_POLL_SECONDS, sleep=time.sleep) -> int:
    """deploy.md Step 13b. Requires the ``production`` (Fly lane) receipt for
    this merged SHA to have passed in ``state_dir`` (never dispatch while a
    surface is still cutting over). When the receipt already names a run of
    this SHA that is not ``completed`` (a CLI-side timeout or interruption),
    it resumes watching that run instead of dispatching again. A dispatch
    ``gh workflow run`` confirmed but whose run was never adopted (``gh run
    list`` failed or the discovery timed out) is recorded as ``dispatched``
    and looked up again on the next call; only when it is older than
    ``SEMANTIC_DISPATCH_RESUME_WINDOW_S`` and one more query finds no run is
    it abandoned to ``semantic_history`` and dispatched anew. Otherwise it
    dispatches ``chat-lifecycle-ratchet.yml`` on ``main`` with
    ``source_sha=<merged_sha>`` plus the URLs and binds to the newest run
    created after the dispatch whose title names that SHA. It polls every
    ``poll_seconds`` within ``timeout``, records run id/url/headSha/effective
    source_sha/created/completed/conclusion/per-job conclusions under
    ``semantic`` in ``production.json`` (every GitHub wait joins
    ``github_waits``) and exits 0 only when the run concluded ``success``.
    ``retry_justification`` (``--retry-failed-once``) reruns only the failed
    jobs of this SHA's run (the recorded or resumed one, or the one this
    invocation dispatched) exactly once; the justification is recorded once
    ``gh run rerun`` succeeded. A second retry is refused with exit 2. Exit 1
    = not green (failed, timed out, never started), 2 = refused/usage/tooling
    error."""
    root = SOURCE_ROOT if root is None else root
    receipt_path = state_dir / PRODUCTION_RECEIPT
    receipt = _read_production_receipt(receipt_path)
    if not isinstance(receipt, dict) or receipt.get("merged_sha") != merged_sha or receipt.get("status") != "passed":
        found = ("no receipt" if not isinstance(receipt, dict)
                 else f"receipt merged_sha={receipt.get('merged_sha')} status={receipt.get('status')}")
        print(f"PIPELINE_SEMANTIC status=refused exit=2 the Fly lane gate is not open for {merged_sha} ({receipt_path}: "
              f"{found}); run `python3 scripts/run_deploy_pipeline.py production --merged-sha {merged_sha} --state-dir "
              f"{state_dir}` first and dispatch production semantics only when it exits 0", flush=True)
        return 2
    waits = receipt.setdefault("github_waits", [])
    previous = receipt.get("semantic") if isinstance(receipt.get("semantic"), dict) else None
    has_run = previous is not None and bool(previous.get("run_id"))
    # A recorded run that never reached `completed` is resumed, never replaced.
    resume = has_run and previous.get("status") != "completed"
    # A confirmed dispatch that never adopted its run is looked up again, never
    # dispatched again: a second `gh workflow run` would run the gate twice.
    pending = semantic_pending_dispatch(previous, merged_sha)
    if retry_justification is not None and previous is not None and not resume:
        if previous.get("retry"):
            print(f"PIPELINE_SEMANTIC status=refused exit=2 run {previous.get('run_id')} already used its one "
                  f"--retry-failed-once ({previous['retry'].get('at')}: {previous['retry'].get('justification')}); a "
                  "second retry is never allowed: fix the root cause in a new PR and repeat the deploy loop", flush=True)
            return 2
        if previous.get("conclusion") == "success":
            print(f"PIPELINE_SEMANTIC status=refused exit=2 run {previous.get('run_id')} for {merged_sha} already "
                  "succeeded; nothing to retry (dispatch again without --retry-failed-once to re-verify)", flush=True)
            return 2
    retrying_previous = retry_justification is not None and has_run and not resume

    def new_entry() -> dict:
        return {"workflow": SEMANTIC_WORKFLOW, "merged_sha": merged_sha, "started_at": _now(), "outcome": "running",
                "dispatch": {"ref": SEMANTIC_DISPATCH_REF, "at": None,
                             "inputs": {"source_sha": merged_sha, "frontend_url": frontend_url,
                                        "backend_url": backend_url}},
                "run_id": None, "url": None, "head_sha": None, "source_sha": None, "display_title": None,
                "created_at": None, "completed_at": None, "attempt": None, "status": None, "conclusion": None,
                "jobs": [], "retry": None}

    if resume or retrying_previous or pending is not None:
        entry = previous
    else:
        if previous is not None:
            receipt.setdefault("semantic_history", []).append(previous)
        entry = new_entry()
    receipt["semantic"] = entry
    started_epoch = time.time()

    def finish(outcome: str, code: int, error: str | None = None) -> int:
        entry.update(outcome=outcome, finished_at=_now(), wall_s=round(time.time() - started_epoch, 1))
        if error:
            entry["error"] = error
        _write_production_receipt(receipt_path, receipt)
        print(f"SEMANTIC_LANE_END {entry['finished_at']} exit={code}", flush=True)
        return code

    def rerun_failed(justification: str) -> None:
        run_id = str(entry["run_id"])
        failed_jobs = [job.get("name") for job in entry.get("jobs", [])
                       if job.get("conclusion") not in ("success", "skipped")]
        print(f"PIPELINE_SEMANTIC retry=failed-jobs run={run_id} previous_conclusion={entry.get('conclusion')} "
              f"jobs={','.join(str(name) for name in failed_jobs) or 'none'}: {justification}", flush=True)
        # A rejected rerun (e.g. 403) must not consume the single retry.
        _gh_text(["run", "rerun", run_id, "--failed"], root)
        entry["retry"] = {"justification": justification, "at": _now(), "previous_attempt": entry.get("attempt"),
                          "previous_conclusion": entry.get("conclusion"), "failed_jobs": failed_jobs, "attempt": None}
        _write_production_receipt(receipt_path, receipt)
        _semantic_wait_complete(run_id, root=root, waits=waits, entry=entry, min_attempt=int(entry.get("attempt") or 1) + 1,
                                timeout=timeout, poll_seconds=poll_seconds, sleep=sleep)
        entry["retry"]["attempt"] = entry.get("attempt")

    def dispatch() -> datetime:
        """``gh workflow run``; once it returned 0 the dispatch is recorded
        (status ``dispatched``, run_id null) before any discovery, so a failed
        ``gh run list`` or a discovery timeout never dispatches the gate twice."""
        dispatched_at = datetime.now(timezone.utc).replace(microsecond=0)
        entry["dispatch"]["at"] = dispatched_at.strftime("%Y-%m-%dT%H:%M:%SZ")
        _write_production_receipt(receipt_path, receipt)
        _gh_text(["workflow", "run", SEMANTIC_WORKFLOW, "--ref", SEMANTIC_DISPATCH_REF,
                  "-f", f"source_sha={merged_sha}", "-f", f"frontend_url={frontend_url}",
                  "-f", f"backend_url={backend_url}"], root)
        entry["status"] = "dispatched"
        _write_production_receipt(receipt_path, receipt)
        print(f"PIPELINE_SEMANTIC dispatched workflow={SEMANTIC_WORKFLOW} ref={SEMANTIC_DISPATCH_REF} "
              f"source_sha={merged_sha} at={entry['dispatch']['at']}", flush=True)
        return dispatched_at

    def discover(dispatched_at: datetime, limit: float) -> tuple[dict | None, int, float]:
        """Poll ``gh run list`` for up to ``limit`` seconds for the run this
        dispatch created: (row or None, polls, waited seconds)."""
        started = time.monotonic()
        polls = 0
        while True:
            polls += 1
            rows = _gh_json(["run", "list", "--workflow", SEMANTIC_WORKFLOW, "--event", "workflow_dispatch",
                             "--branch", SEMANTIC_DISPATCH_REF, "--limit", "20", "--json", SEMANTIC_RUN_FIELDS], root)
            row = semantic_select_run(rows, merged_sha, dispatched_at)
            if row is not None or time.monotonic() - started >= limit:
                return row, polls, round(time.monotonic() - started, 1)
            sleep(min(10.0, poll_seconds))

    try:
        if resume:
            run_id = str(entry["run_id"])
            print(f"PIPELINE_SEMANTIC resume run={run_id} status={entry.get('status')} source_sha={merged_sha}: "
                  "watching the recorded run instead of dispatching again", flush=True)
            print(f"SEMANTIC_RUN_ID={run_id}", flush=True)
            retry = entry.get("retry") if isinstance(entry.get("retry"), dict) else None
            min_attempt = int(retry.get("previous_attempt") or 0) + 1 if retry else int(entry.get("attempt") or 1)
            _semantic_wait_complete(run_id, root=root, waits=waits, entry=entry, min_attempt=min_attempt,
                                    timeout=timeout, poll_seconds=poll_seconds, sleep=sleep)
            if retry and retry.get("attempt") is None:
                retry["attempt"] = entry.get("attempt")
            if entry["conclusion"] != "success" and retry_justification is not None and not retry:
                _write_production_receipt(receipt_path, receipt)
                rerun_failed(retry_justification)
        elif retrying_previous:
            print(f"PIPELINE_SEMANTIC resume run={entry['run_id']} conclusion={entry.get('conclusion')} "
                  f"source_sha={merged_sha}: rerunning failed jobs once", flush=True)
            print(f"SEMANTIC_RUN_ID={entry['run_id']}", flush=True)
            rerun_failed(retry_justification or "")
        else:
            row = None
            if pending is not None:
                dispatched_at = pending
                age_s = time.time() - pending.timestamp()
                stale = age_s > SEMANTIC_DISPATCH_RESUME_WINDOW_S
                print(f"PIPELINE_SEMANTIC resume dispatch at={entry['dispatch']['at']} age={age_s:.0f}s "
                      f"source_sha={merged_sha}: looking for that dispatch's run instead of dispatching again", flush=True)
                # Within the window the run may still be appearing: keep polling.
                # Past it, one more query decides: adopt the run, or abandon the dispatch.
                row, polls, waited_s = discover(pending, 0.0 if stale else start_timeout)
                if row is None and stale:
                    waits.append({"workflow": SEMANTIC_WORKFLOW, "kind": "run-start", "head": merged_sha, "run_id": None,
                                  "polls": polls, "waited_s": waited_s, "outcome": "abandoned"})
                    print(f"PIPELINE_SEMANTIC dispatch at={entry['dispatch']['at']} is older than "
                          f"{SEMANTIC_DISPATCH_RESUME_WINDOW_S:.0f}s with no run: abandoning it and dispatching again",
                          flush=True)
                    entry["outcome"] = "abandoned"
                    receipt.setdefault("semantic_history", []).append(entry)
                    entry = new_entry()
                    receipt["semantic"] = entry
                    pending = None
            if pending is None:
                dispatched_at = dispatch()
                row, polls, waited_s = discover(dispatched_at, start_timeout)
            if row is None:
                waits.append({"workflow": SEMANTIC_WORKFLOW, "kind": "run-start", "head": merged_sha, "run_id": None,
                              "polls": polls, "waited_s": waited_s, "outcome": "timeout"})
                raise ProductionGateError(
                    f"no {SEMANTIC_WORKFLOW} run titled source_sha={merged_sha} created after the dispatch at "
                    f"{entry['dispatch']['at']} appeared within {start_timeout:.0f}s; the dispatch is unconfirmed: "
                    f"inspect `gh run list --workflow {SEMANTIC_WORKFLOW} --event workflow_dispatch` (an older run "
                    f"is never adopted; a run GitHub stamped more than {DISPATCH_CLOCK_SKEW_S:.0f}s before this "
                    "host's dispatch clock counts as older, so check the host clock if the run exists) and rerun "
                    f"this command (it resumes this dispatch for {SEMANTIC_DISPATCH_RESUME_WINDOW_S:.0f}s before "
                    "dispatching again)"
                )
            run_id = str(row.get("databaseId"))
            entry.update(run_id=run_id, url=row.get("url"), head_sha=row.get("headSha"), source_sha=merged_sha,
                         display_title=row.get("displayTitle"), created_at=row.get("createdAt"),
                         status=row.get("status"))
            waits.append({"workflow": SEMANTIC_WORKFLOW, "kind": "run-start", "head": merged_sha, "run_id": run_id,
                          "polls": polls, "waited_s": waited_s, "outcome": "found"})
            _write_production_receipt(receipt_path, receipt)
            print(f"SEMANTIC_RUN_ID={run_id}", flush=True)
            print(f"PIPELINE_SEMANTIC run={run_id} url={entry['url']} head_sha={entry['head_sha']} "
                  f"source_sha={merged_sha} created={entry['created_at']}", flush=True)
            _semantic_wait_complete(run_id, root=root, waits=waits, entry=entry, min_attempt=1, timeout=timeout,
                                    poll_seconds=poll_seconds, sleep=sleep)
            if entry["conclusion"] != "success" and retry_justification is not None:
                _write_production_receipt(receipt_path, receipt)
                rerun_failed(retry_justification)
    except ProductionGateError as error:
        print(f"PIPELINE_SEMANTIC status=blocked exit=1 {error}", flush=True)
        return finish("failed", 1, str(error))
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as error:
        detail = getattr(error, "stderr", "") or ""
        message = f"{type(error).__name__}: {error} {detail.strip() if isinstance(detail, str) else ''}".strip()
        print(f"PIPELINE_SEMANTIC status=error exit=2 {message}", flush=True)
        return finish("error", 2, message)
    jobs = " ".join(f"{job.get('name')}={job.get('conclusion')}" for job in entry["jobs"]) or "no jobs"
    if entry["conclusion"] == "success":
        print(f"PIPELINE_SEMANTIC status=passed exit=0 run={entry['run_id']} attempt={entry['attempt']} "
              f"source_sha={merged_sha} head_sha={entry['head_sha']} url={entry['url']} jobs: {jobs}", flush=True)
        return finish("passed", 0)
    retry_state = "used" if entry.get("retry") else "available (--retry-failed-once \"<justification>\")"
    print(f"PIPELINE_SEMANTIC status=failed exit=1 run={entry['run_id']} attempt={entry['attempt']} "
          f"conclusion={entry['conclusion']} url={entry['url']} jobs: {jobs}; retry={retry_state}; the deployment is "
          "not complete: inspect the run's Playwright artifacts and service logs (deploy.md Step 13b)", flush=True)
    return finish("failed", 1, f"run {entry['run_id']} concluded {entry['conclusion']}")


def _full_sha(value: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise argparse.ArgumentTypeError(f"expected a full 40-hex commit SHA, got {value!r}")
    return value


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="action", required=True)
    run_parser = sub.add_parser("run")
    run_parser.add_argument("--plan", type=Path, required=True)
    run_parser.add_argument("--state-dir", type=Path, required=True)
    run_parser.add_argument("--max-parallel", type=int, default=None,
                            help="concurrent lanes; default: host-scaled plan value (0 = memory-bounded only)")
    run_parser.add_argument("--memory-budget-mb", type=int, default=None,
                            help="tighten declared-memory budget; whole-box watchdog headroom always applies")
    run_parser.add_argument("--follow-source", action="store_true",
                            help="supersede the attempt when the source changes and settles")
    run_parser.add_argument("--settle-seconds", type=float, default=DEFAULT_SETTLE_SECONDS)
    run_parser.add_argument("--poll-seconds", type=float, default=DEFAULT_POLL_SECONDS)
    run_parser.add_argument("--max-attempts", type=int, default=DEFAULT_MAX_ATTEMPTS)
    run_parser.add_argument("--fix-loop-cap", type=int, default=_env_int("DEPLOY_FIX_LOOP_CAP", DEFAULT_FIX_LOOP_CAP),
                            help="completed failed rounds before FIX_LOOP_CAP (0 disables)")
    run_parser.add_argument("--after-rca", default=None,
                            help="RCA reference that authorizes the next round and restarts the count")
    wait_parser = sub.add_parser("wait")
    wait_parser.add_argument("--state-dir", type=Path, required=True)
    wait_parser.add_argument("--timeout", type=float, default=0)
    wait_parser.add_argument("--stall-seconds", type=float, default=0.0)
    wait_parser.add_argument("--since", type=float, required=True,
                             help="epoch captured before launching `run`; older receipts never satisfy the wait")
    verify_parser = sub.add_parser("verify", help="exit 0 only when the receipt passed on the current bytes")
    verify_parser.add_argument("--state-dir", type=Path, required=True)
    verify_parser.add_argument("--expect-head", default=None)
    verify_parser.add_argument("--require-staged", action="store_true",
                               help="refuse legacy receipts when staged validation is required")
    plan_parser = sub.add_parser("plan", help="print the standard Group 3/4 plan JSON")
    plan_parser.add_argument("--group", choices=("3", "4", "all"), default="all")
    plan_parser.add_argument("--backend", action="store_true")
    plan_parser.add_argument("--frontend", action="store_true")
    plan_parser.add_argument("--agents", action="store_true")
    plan_parser.add_argument("--smoke", choices=("cloud", "local", "skip"), default="cloud")
    plan_parser.add_argument("--agentcard", action="store_true")
    plan_parser.add_argument("--live-probes", action="store_true",
                             help="Group 3: add the Step 4p live-probes lane after every other Group 3 lane")
    plan_parser.add_argument("--semantic-stack", action="store_true",
                             help="Group 4: add the Steps 5/6b semantic-stack lane (scripts/run-deploy-semantic-stack.sh)")
    plan_parser.add_argument("--e2b-smoke", action="store_true",
                             help="Group 4: add the Step 6c e2b-smoke lane (run-deploy-semantic-stack.sh --e2b-smoke-only)")
    plan_parser.add_argument("--backend-blackbox-workers", type=int, default=4)
    plan_parser.add_argument("--backend-unit-workers", type=int, default=6)
    plan_parser.add_argument("--frontend-workers", type=int, default=4)
    plan_parser.add_argument("--agents-workers", type=int, default=6)
    plan_parser.add_argument("--host-cpus", type=int, default=None, help="plan for this many cores (default: this host)")
    plan_parser.add_argument("--host-mem-mb", type=int, default=None,
                             help="plan for this MemAvailable in MB (default: this host)")
    plan_parser.add_argument("--host-total-mem-mb", type=int, default=None,
                             help="plan for this MemTotal in MB (default: this host)")
    plan_parser.add_argument("--host-watchdog-mb", type=int, default=None,
                             help="plan for this watchdog cap in MB (default: recorded cap or 90%% of MemTotal)")
    plan_parser.add_argument("--schedule", choices=(SCHEDULE_PHASED, SCHEDULE_LEGACY), default=SCHEDULE_PHASED,
                             help="Group 3 admission: phased (quick -> exclusive structural -> coverage) or legacy")
    production_parser = sub.add_parser(
        "production",
        help="post-merge Fly lane: wait for the exact deploy-agents.yml run of the merged SHA (agent runtime "
             "changes only), verify its cutover, then run the dispatch command after `--`")
    production_parser.add_argument("--merged-sha", required=True)
    production_parser.add_argument("--state-dir", type=Path, required=True)
    production_parser.add_argument("--timeout", type=float, default=DEFAULT_FLY_TIMEOUT,
                                   help="seconds to wait for the run to complete once it exists")
    production_parser.add_argument("--start-timeout", type=float, default=DEFAULT_FLY_START_TIMEOUT,
                                   help="seconds to wait for the exact run to appear")
    production_parser.add_argument("--poll-seconds", type=float, default=DEFAULT_FLY_POLL_SECONDS)
    production_parser.add_argument("--expected-hash", default=None,
                                   help="precomputed agent workflow surface hash (default: scripts/agent_workflow_surface_hash.py)")
    production_parser.add_argument("dispatch", nargs=argparse.REMAINDER,
                                   help="-- <command> run only once the gate is open (e.g. gh workflow run ...)")
    semantic_parser = sub.add_parser(
        "production-semantic",
        help="post-merge Step 13b: dispatch chat-lifecycle-ratchet.yml on main with source_sha=<merged SHA>, bind to "
             "the run that dispatch created, poll it and record it under `semantic` in production.json; exit 0 only "
             "when every job succeeded (requires the passed `production` receipt for the same SHA)")
    semantic_parser.add_argument("--merged-sha", required=True, type=_full_sha)
    semantic_parser.add_argument("--state-dir", type=Path, required=True)
    semantic_parser.add_argument("--frontend-url", default=SEMANTIC_FRONTEND_URL)
    semantic_parser.add_argument("--backend-url", default=SEMANTIC_BACKEND_URL)
    semantic_parser.add_argument("--retry-failed-once", metavar="JUSTIFICATION", default=None,
                                 help="rerun only the failed jobs of this SHA's run once (`gh run rerun <id> --failed`) "
                                      "and record this justification; a second retry is refused")
    semantic_parser.add_argument("--timeout", type=float, default=DEFAULT_SEMANTIC_TIMEOUT,
                                 help="seconds to wait for the run to complete once it exists")
    semantic_parser.add_argument("--start-timeout", type=float, default=DEFAULT_SEMANTIC_START_TIMEOUT,
                                 help="seconds to wait for the dispatched run to appear")
    semantic_parser.add_argument("--poll-seconds", type=float, default=DEFAULT_SEMANTIC_POLL_SECONDS)
    render_parser = sub.add_parser(
        "production-render",
        help="deploy.md Step 13a step 1: wait for Render to serve the merged backend (exact-SHA deploy live, or the "
             "live commit is source-equivalent: an ancestor or descendant with no change under the Render service "
             "paths), record it under `render` in production.json, then run the optional command after `--`")
    render_parser.add_argument("--merged-sha", required=True, type=_full_sha)
    render_parser.add_argument("--state-dir", type=Path, required=True)
    render_parser.add_argument("--timeout", type=float, default=DEFAULT_RENDER_TIMEOUT,
                               help="seconds to wait for the merged backend (deploy.md: 90 x 10 s)")
    render_parser.add_argument("--poll-seconds", type=float, default=DEFAULT_RENDER_POLL_SECONDS)
    render_parser.add_argument("then", nargs=argparse.REMAINDER,
                               help="optional command to run only once the merged backend is live (after `--`)")
    simulate_parser = sub.add_parser("simulate", help="project the Group 3 union wall: phased vs legacy")
    simulate_parser.add_argument("--plan", type=Path, required=True)
    simulate_parser.add_argument("--max-parallel", type=int, default=None)
    simulate_parser.add_argument("--memory-budget-mb", type=int, default=None)
    simulate_parser.add_argument("--legacy-plan", type=Path, default=None,
                                 help="plan --schedule legacy output: the legacy variant's own lane reservations")
    args = parser.parse_args(argv)
    if args.action == "plan":
        print(json.dumps(standard_plan(args), indent=2))
        return 0
    if args.action == "simulate":
        try:
            print(json.dumps(simulate_plan(args.plan, args.max_parallel, args.memory_budget_mb, args.legacy_plan),
                             indent=2))
        except ValueError as error:
            print(f"invalid plan {args.plan}: {error}", file=sys.stderr)
            return 2
        return 0
    if args.action == "run":
        try:
            return run(
                args.plan, args.state_dir, args.max_parallel, args.memory_budget_mb,
                follow_source=args.follow_source, settle_seconds=args.settle_seconds,
                poll_seconds=args.poll_seconds, fix_loop_cap=args.fix_loop_cap,
                after_rca=args.after_rca, max_attempts=args.max_attempts,
            )
        except ValueError as error:
            print(f"invalid plan {args.plan}: {error}", file=sys.stderr)
            return 2
    if args.action == "verify":
        if args.require_staged:
            return verify(args.state_dir, args.expect_head, require_staged=True)
        return verify(args.state_dir, args.expect_head)
    if args.action == "production":
        dispatch = list(args.dispatch)
        if dispatch and dispatch[0] == "--":
            dispatch.pop(0)
        return production(args.merged_sha, args.state_dir, dispatch or None, expected_hash=args.expected_hash,
                          timeout=args.timeout, start_timeout=args.start_timeout, poll_seconds=args.poll_seconds)
    if args.action == "production-render":
        then = list(args.then)
        if then and then[0] == "--":
            then.pop(0)
        return production_render(args.merged_sha, args.state_dir, then or None, timeout=args.timeout,
                                 poll_seconds=args.poll_seconds)
    if args.action == "production-semantic":
        return production_semantic(args.merged_sha, args.state_dir, frontend_url=args.frontend_url,
                                   backend_url=args.backend_url, retry_justification=args.retry_failed_once,
                                   timeout=args.timeout, start_timeout=args.start_timeout,
                                   poll_seconds=args.poll_seconds)
    return wait(args.state_dir, args.timeout, args.stall_seconds, args.since)


if __name__ == "__main__":
    sys.exit(main())
