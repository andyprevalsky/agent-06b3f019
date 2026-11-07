---
id: 2026-11-07-controller-runner-docker-client-calls-unbounded-and-silent
date: 2026-11-07
title: Controller gate sat 70 minutes with no output because the Linux fixture runner's first docker client call never returned and nothing bounded or named it
surface: harness
component: run-cloudbench-controller-linux
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: scripts/tests/run-cloudbench-controller-linux.py main issued its pre-container docker client calls (image inspect, build, label inspect, toolchain preflight run) with no deadline and no step announcement; the wedge that triggered the hang (the very first `docker image inspect` on the Blacksmith VM) is observed but its cause on that VM is unproven
symptoms:
  - "remote run ended without a worker result"
  - "##[error]The operation was canceled." (Run gate step, 06:04:04Z to 07:14:12Z)
  - status-service-shutdown.log is 0 bytes with no status-service-shutdown.json while the other 11 cases PASS
  - "Terminate orphan process: pid (6180) (docker)"
  - "docker image inspect did not finish within 120s"
tags:
  - cloudbench-controller
  - blacksmith
  - docker
  - hang
  - silent-gate
  - deploy-step-4cb
  - status-service-shutdown
sources:
  - PR #1751 (source 9997bca37f)
  - task deploy gate cloudbench-controller, GitHub Actions run 42345175145 (job deploy-gates/4vcpu/cloudbench-controller-062faaf57d6ebcdf)
  - memory:blacksmith-deploy-gates
repro: scripts/tests/cloudbench-controller-linux.test.py::test_wedged_docker_client_fails_by_step_name_instead_of_hanging
status: mitigated
---

## Problem

The `cloudbench-controller` deploy gate for PR #1751 (source `9997bca37f`) ran on
a Blacksmith 4 vCPU VM. Its `Run gate` step started at 06:04:04Z, printed
nothing, and was cancelled at 07:14:12Z (70 minutes). The gate was recorded
UNVERIFIED with "remote run ended without a worker result". The same gate
passed on Blacksmith at `a26727b05` in 18.3 minutes (11-06) and ran in 19.3
minutes locally on four CPUs in this RCA.

The evidence bundle retrieved after the cancel (`remote-artifact/` under the
originating attempt) shows exactly which case was stuck. All 12 cases of
`scripts/run-cloudbench-controller-local.py` started at 06:04:06Z. Eleven wrote
a result JSON and PASSED: environment 42.4 s, autoscale 4.7 s, infra-canary
2.3 s, infra-stability 38.9 s, rootless-sms 0.4 s, multi-workstream 987.5 s,
linux-contract 1.0 s, github-token 1.2 s, seed-toolchain 0.4 s, wall-clock
5.1 s, selected-pytest 241.1 s. Only `status-service-shutdown` never finished:
its log is 0 bytes (not even the runner's `Native controller artifacts:` line)
and it has no result JSON. The job's orphan cleanup listed five python3
processes and one `docker` process (pid 6180).

## Diagnosis

`status-service-shutdown` runs `run-cloudbench-controller-linux.py --fixture
status-service-shutdown`. On a non-root Linux host (the `runner` user, as on this
devbox) that runner always uses the offline container path: `docker image
inspect`, `docker build` when the image tag is missing, `docker image inspect`
for the label, a toolchain-preflight `docker run`, and only then the fixture
container. Of the 12 cases only this one reaches the docker daemon: the others run
natively on Linux, and seed-toolchain and linux-contract use fake docker stubs.

The five python3 orphans match the process chain above the runner (worker
supervisor, worker, local gate, local supervisor, runner), and the `docker` client
is its leaf. The supervisors' reaped-pid ranges place the 12 case shells at
pids 6085 to 6152 (all within 0.04 s). The orphan `docker` is pid 6180, about 30
pids later. The other cases spawned tens of thousands of processes (environment
reached pid 32501 within 42 s, multi-workstream 149881), so pid 6180 was created
within the first second. That is the runner's first docker call, `docker image
inspect`. It blocked for the full 70 minutes before any output, so the daemon
or socket stopped answering the very first client call on that VM. Baseline runs
with the same flow (r13 at `447fa427de`, 11-06 at `a26727b05`) show the call
returning immediately and the cold image build finishing in 17 s.

The PR is deploy tooling only. Among the changed files reachable from a case, the
cases that passed in the same job (environment, multi-workstream, linux-contract,
github-token, selected-pytest) cover `cloudbench-env.sh`, `run-bench-fleet` and
the tests. For the stuck case, the only changed inputs are the Dockerfile (Node
22.13.0 to 22.23.4) and the runner's pinned-toolchain text. They are consumed
after the first docker call, and a registry stall would have printed BuildKit's
`#0`/`#1` lines first, which the empty log rules out. Re-running the same case at
the PR tip on this devbox with the new Dockerfile, starting from a missing image
tag, built the image and passed in 27.3 s. The full gate on four CPUs with all 12
cases concurrent passed in 1160.9 s with `status-service-shutdown` at 6.2 s.

`Gate: NOT_INTRODUCED`. The hang is a daemon or VM level wedge of the first docker
client call and does not reproduce at the PR tip. Why the daemon stopped
answering on that VM is not recorded in the artifacts (no dockerd journal and no
`docker info`), so that cause stays an open observability gap.

What made a single wedged call cost 70 silent minutes is owned and was
reproduced: the runner had no deadline on any pre-container docker call and
printed nothing before them, and `run_case` has `timeout=None`, so an empty case
log with a live `docker` child could neither fail nor identify itself. A fake
`docker` that sleeps on one step reproduces it: the original runner waits for the
call to return and then fails with an unrelated message
("controller image identity is invalid").

## Solution

`scripts/tests/run-cloudbench-controller-linux.py` now routes every docker client
call that precedes the fixture container through `bounded_docker`. It prints
`docker step: <name>` to stderr (the case log merges it; `--check-only` stdout stays
pure JSON) and raises `RuntimeError("docker <name> did not finish within <N>s")`.
Limits are 120 s for the inspect calls, 300 s for the preflight run and 1200 s for
a cold build. Measured passing times are 0.1 s per inspect, about 1 s for the
preflight run and 22 s for a cold build. The fixture container itself stays unbounded because
multi-workstream legitimately runs for 16 to 19 minutes, and its exact-owner
retirement is unchanged. A wedge now fails the case in two minutes with the
stuck step as the last log line instead of holding the gate until the 270-minute
workflow limit.

The regression is `test_wedged_docker_client_fails_by_step_name_instead_of_hanging`
in the existing `scripts/tests/cloudbench-controller-linux.test.py`, which the
`linux-contract` case of the controller gate runs. It drives the real runner and
real subprocesses against a fake docker that sleeps at exactly one of four steps
(inspect, build, label, run). Against the original runner (with the limit
constants stubbed in so the test can load) all four sub-cases fail after waiting out
each 6 s sleep, 24 s in total; against the fix the whole file passes in 4.4 s, five
consecutive times. Nothing else changed: no gate's pass criteria
and no timeout of a passing run.

Not changed, recommended: `remote_run` in `scripts/deploy_test_github.py` gives the
Actions job log no output until the worker exits (the worker log with its
`GATE_STEP_START` and `GATE_STEP` lines lives under `.context/deploy-worker`). Tailing
that file into the step log would have shown the stuck case at minute one. A
per-case deadline in `run-cloudbench-controller-local.py` would bound any other
hang, but needs a measured margin above multi-workstream (987 to 1155 s here) and
was left to the owner. This change touches CI gate tooling only; it has no
per-agent state, so it does not change behavior at 10k agents.

## Human feedback

None recorded.

## Reusable lesson

Give every external-client call a named deadline and announce it before it starts, so a wedged daemon is a two-minute failure that names its step rather than a silent multi-hour gate.
