---
id: 2026-09-28-wmh-root-session-send-email-head-of-line-wait
date: 2026-09-28
title: Approved simulated email sends exhausted their activity deadline in a loaded WMH session
surface: harness
component: served-world-model-session
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: agents/helpers/world_model_runtime.py WorldModelToolExecutionAdapter.execute and agents/benchmarks/serve_world_model.py serialized_step omit correlated enqueue, lock-acquire, and completion spans
symptoms:
  - "message_person: activity StartToClose timeout"
  - "send_email_activity" ran for 65001 ms and ended with status=error
  - "Timeout after 603s (dynamic cap=600s)"
tags:
  - world-model
  - message-person
  - email
  - session-lock
  - timeout
sources:
  - agent b5167c46-ef7f-4903-8d72-f1d87c8d9af7
  - benchmark run 20260928_173854_raise-5m-rose-labs-brex.json
  - agent 65889659-9f08-4488-917e-9611223be811
  - benchmark run wmh-raise-5m-rose-labs-brex-1791845194
repro: agents/tests/blackbox/world_model_harness.blackbox.py::test_served_wmh_parallelizes_same_session_llm_calls_and_keeps_both_steps
status: open
---

## Problem

In the 600-second fundraiser simulation, five approved email delivery activities began; four ended in an error after 65 seconds and the fifth was canceled at teardown. The root remained active with 16 agents. The workflow gave `send_email_activity` a 60-second StartToClose timeout. In simulate mode that activity sends `rose.message.message_transport_send` to the shared WMH session and never falls back to real Gmail.

## Diagnosis

Critical path: agent `message_person` → generated email → simulated approval → `send_email_activity` → `WorldModelToolExecutionAdapter.execute` → WMH HTTP `/step` → `serve_world_model.py` root-session lock → Rose WMH LLM prediction → synthetic delivery receipt.

The run's root session was `e3165d5063ac45228fce07acf62faf24`. The approved email from agent `4f02deb0` began delivery at 17:38:22 and was canceled at 17:39:22. In that interval the same WMH session returned four other steps, at 17:38:31, :45, :59, and 17:39:12. Its retrieval audit contained no `message_transport_send` query for that email agent by shutdown, although it contained three such queries for another child, `55639782`, whose sends also timed out. The served WMH wraps every session step in one `threading.Lock`, so actions from parallel children execute serially. Late WMH calls had 121k–145k-token contexts and Cerebras returned 32 HTTP 429 quota errors during the run; fallback predictions took roughly 12–14 seconds each near the email timeout. The runtime HTTP client permits 660 seconds for a WMH step, while the outer email activity permits only 60 seconds.

A local replay of the actual `_install_root_scoped_sessions` wrapper with six 120-ms steps ahead of an email step made that email miss a 600-ms deadline; it completed at 840 ms. This proves that shared-lock head-of-line delay is possible. The production trace lacks a per-request WMH enqueue/acquire marker, so it cannot establish whether the timed-out email spent its interval waiting for the lock, in WMH model inference, or in transport. A Temporal cancellation also does not prove that the synchronous WMH step was never applied; the run did not preserve a per-action simulated delivery receipt or idempotency outcome. This is preliminary evidence, not a completed causal RCA. A fixed RCA still requires a permanent pre-fix reproduction, a general fix, and the unchanged benchmark passing.

The user then made same-session LLM parallelism an explicit contract. A permanent blackbox test at the served WMH boundary submits two `message_transport_send` actions against the same session, synchronizes their fake provider calls, and asserts that both calls overlap while both observations, state notes, and usage records survive. On the old wrapper it failed with `AssertionError: same-session WMH predictions must overlap`. The same command passed after the wrapper was changed:

```bash
cd agents
./venv/bin/python -c 'import importlib.util,sys; sys.path.insert(0,"tests/blackbox"); spec=importlib.util.spec_from_file_location("wmh_blackbox","tests/blackbox/world_model_harness.blackbox.py"); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); module.test_served_wmh_parallelizes_same_session_llm_calls_and_keeps_both_steps()'
```

The first live rerun after that change exposed a second defect at the Rose provider boundary. At 18:35:53 two real predictions entered the same WMH session simultaneously. One finished in 11.2 seconds; the other entered `fast_cache.cache_get_wait` and remained there for more than two minutes with no batch completion. The run was stopped before the fundraiser timed out, so it is not an outcome pass or fail. `RoseWMHProvider.complete` used `asyncio.run` on every FastAPI thread, creating a separate event loop for each call, while `providers.fast_cache.client` keeps its pending `asyncio.Future` queue and flush task globally. A local two-thread reproduction using the actual Fast Cache batch code completed one lookup and left the other pending after two seconds (`finished=['wmh-a'] ... alive=[False, True]`). The permanent WMH blackbox assertion that simultaneous Rose calls share their event loop failed before the bridge fix with `AssertionError: parallel WMH cache lookups must share the event loop that owns their futures` and passed afterward. Both real Fast Cache batch lookups also completed in the post-fix blackbox test.

The `world-model-harness` pin cannot supply either contract by itself: the last `wmh` revision still calls the provider synchronously from `step`, and current upstream's renamed `experiential` implementation also holds a per-session lock across `complete_turn`. Current upstream additionally requires Python 3.12, whereas Rose's agents venv is Python 3.11. These observations establish the local parallelism and cache-loop defects and rule out a simple dependency update. The subsequent benchmark run separately verifies one successful simulated email delivery; it does not establish that the entire fundraiser succeeds.

Archive searches: `activity StartToClose timeout send_email_activity message_transport_send` and `WMH shared session lock parallel agents tool step timeout serialization`. The September 6 email-channel stub case is related but not a recurrence: this run reached the simulated delivery activity. The September 27 unseeded-WMH-session case concerns different state and is not this boundary.

### October 12 Run12 follow-up: original caller deadlines still expire

Read-only analysis of the authenticated original Run12 checkpoint found two
`message_person` email attempts with exact call identities matching later native
send receipts. The first UI `Sending Email` marker at23:37:30.440Z became
`activity StartToClose timeout` at23:38:30.821Z; its native prediction ran
23:37:30.739Z–23:39:41.484Z (130.745s). The retry marker at23:42:06.222Z became
the same timeout at23:43:06.606Z; its native prediction ran
23:42:06.580Z–23:45:07.623Z (181.043s). Both later native observations say
simulated `provider_accepted`; both agent-facing delivery activities failed.
These are ambiguous late native commits, not two confirmed completed agent sends.

The unchanged delivery handler schedules `send_email_activity` with60s
StartToClose and maximum_attempts1 in simulate mode too. Calling that actual
scheduling boundary offline captured those parameters and the explicit
simulate/scope/approval arguments. A budget audit against the two original
prediction intervals exits1. This is supporting scheduling evidence, **not** a
live Temporal cancellation reproduction, green repair or benchmark outcome pass.
The old head-of-line explanation is not automatically adopted: each native
prediction started within0.36s of its UI sending marker, and model inference is
already longer than the caller's entire60s budget. No timeout was increased.

The user also reported failing explores. Exact original message cards separate
14 explore failures into8 model-generated sampled retrieval errors (5Gmail503,
2read timeouts,1reference miss),3 real WMH HTTP500/provider failures, and3 cutoff
cancellations. Replaying all8 recorded model distributions through production
`parse_distribution`, the original draw, `select_outcome`, and the runtime adapter
reproduces their error outputs byte-for-byte without calling any real service.
The simulated503s are not evidence of an actual Gmail outage. Why the model
assigned these probabilities and why the real provider streams went idle remain
open; do not force successful outcomes or substitute correlation for a repro.

Commands: from `agents/`, activate the pinned venv, then run
`PYTHONPATH=. python /home/boxes/rose-wmh-resumed/.context/whm-migration/replay-run12-failures.py`
(exit0,8 exact recorded-error replays and0 real service/model calls). Adding
`--require-delivery-budget` exits1 with the60s/130.745s/181.043s budget assertion.
Derived aggregate evidence is in
`docs/handoffs/whm-b07d9037-preservation/run12-message-and-explore-failure-trace.json`.
No runtime, policy, prompt, fixture, sample key or benchmark changes were made.
The original user's no-paid-trial/no-merge/no-deploy boundaries remain in force.
No new review agent was launched under the user's no-new-agent instruction.
This case remains open; no adversarial review, live repair or exact benchmark
outcome qualification is claimed for these new findings.

## Solution

The Rose WMH serving adapter now snapshots each shared session under a short lock, builds its prompt and calls the provider outside that lock, then appends the observation and state note under the lock. Concurrent actions each see the state at request start; commit order follows completion order. Logs correlate action name, agent ID, session ID, and step ID with snapshot-lock wait, prediction, and commit-lock wait. The Rose provider bridge now submits all served calls to one process-wide async loop, keeping Fast Cache's futures on their owning loop while model calls overlap. The world-model-harness blackbox domain and provider/serve unit suites pass.

The unchanged 600-second fundraiser was rerun with `BENCHMARK_SKIP_WMH_DELTA=1 bash scripts/run-bench --local raise-5m-rose-labs-brex --simulate`, using the freshly built WMH corpus. Run `agents/benchmarks/runs/20260928_185406_raise-5m-rose-labs-brex.json` failed at `Timeout after 601s (dynamic cap=600s)`, with root agent `2547b90b-6977-4401-9e89-a6c1d909785c` still ACTIVE. Its [published FE trajectory](https://www.roselabs.ai/?agent-id=2547b90b-6977-4401-9e89-a6c1d909785c) was verified by `scripts/publish_evidence_links.py`. The WMH serve log recorded 95 started and 95 committed steps, zero unfinished steps, a peak of 10 concurrent predictions, and no measured snapshot or commit lock wait above 0 ms. Worker trace showed one approved `send_email_activity` completed successfully in 4,605 ms; its correlated `rose.message.message_transport_send` WMH step took 4,594 ms. Thus the same-session parallelism contract and one email delivery succeeded in this run, while the overall outcome gate failed. The root trajectory also contains list-type validation errors on `spawn_general_purpose_agent_for_each`; it then created outreach children through another route. By timeout, two children reported investor outreach but no replies or committed capital. The causal role of the validation errors and `wait_for` loops in the timeout has not been locally reproduced. Keep this RCA open until the unchanged benchmark passes. Do not raise the benchmark or tool timeout to hide a failure. Preserve simulated send action, cancellation, and receipt evidence in any follow-up diagnosis.

## Human feedback

While the authorized Run13 was running unchanged on `badbbc2b3`, the faster
Flash route produced malformed-JSON attempts, and DEMO store events overstated
actual writes. Offline follow-up evidence and limitations are recorded in
`docs/handoffs/whm-b07d9037-preservation/run13-offline-reliability-followup.md`.
The store-event defect is reproduced on the exact baseline method with a
rejected write and repaired by the same owning check. JSON format enforcement
and retention of rejected replies are prepared and tested offline; they are
not a paid provider/outcome qualification. No new review agent was launched.

On October 13 the user explicitly authorized WHM-only reliability changes and
one new 60-minute benchmark. The earlier no-paid-trial boundary therefore no
longer prohibits this one trial. The preparation receipt is
`docs/handoffs/whm-b07d9037-preservation/run13-reliability-preparation.md`.
The same offline scheduling audit now covers both original native send durations,
and owning provider/native/workflow checks pass. These are contract checks,
not a live root-cause or fundraising-outcome qualification. This case remains
open. No ordinary-run activity or model configuration is changed by default.

The user asked whether `message_person` was mocked through WHM, requested analysis of why approved email delivery was slow, and made overlapping same-session LLM calls a mandatory assertion. They asked whether updating the original GitHub dependency would fix it.

On October13 the user pointed to Run12's `Failed to send Email` /
`activity StartToClose timeout` and failing explores after the scorecard had
counted late native accepted-send records as completed outreach. The derived
scorecard now separates0 completed agent email sends from2 late native receipts.

## Reusable lesson

Measure shared-session queue wait separately from model inference before changing a simulated tool's timeout.
