# R1 Polar browser execution surface: grounding packet

This packet accompanies row R1, not the two R2 judge failures. The original
campaign task definitions, prompts, expected tools, five-step browser minimum,
price caps and deadlines remain unchanged. Production is not deployed.

## Source and causal evidence

Base: `0c96ea5a86edf9f3267e6a4edacf4870cf834bd0`, derived from
`origin/descend/polar-k3-recovery`. Campaign A used
`35ae7f4a7e15dda8a41d093f3d778a5722c0e5c1`.
The final cohort is 26 no-browser failures, two judge failures, two passes.
All 26 no-browser failures generated a schema and completed using explore.
The case file contains member-by-member agent and schema request IDs.

The immutable primary browser-use V1 reference is
[`browser-use/benchmark@dff86d1a32134f4bf3b38ce30ea92264cacbcac7`](https://github.com/browser-use/benchmark/tree/dff86d1a32134f4bf3b38ce30ea92264cacbcac7):

- [run_eval.py:63](https://github.com/browser-use/benchmark/blob/dff86d1a32134f4bf3b38ce30ea92264cacbcac7/run_eval.py#L63)
  loads BU_Bench_V1; [107](https://github.com/browser-use/benchmark/blob/dff86d1a32134f4bf3b38ce30ea92264cacbcac7/run_eval.py#L107)
  constructs the browser agent using raw `confirmed_task` and an actual browser.
- [run_eval.py:139](https://github.com/browser-use/benchmark/blob/dff86d1a32134f4bf3b38ce30ea92264cacbcac7/run_eval.py#L139)
  evaluates that browser's result, trajectory and screenshots.
- [frameworks/browser_use/run_task.py:43](https://github.com/browser-use/benchmark/blob/dff86d1a32134f4bf3b38ce30ea92264cacbcac7/frameworks/browser_use/run_task.py#L43)
  uses the same explicit browser entrypoint.
- [frameworks/codex_harness/system_prompt.md](https://github.com/browser-use/benchmark/blob/dff86d1a32134f4bf3b38ce30ea92264cacbcac7/frameworks/codex_harness/system_prompt.md)
  explicitly binds its alternate executor to the browser harness.

This is the last available upstream revision before Polar's publication, not a
proven pin used by that publication. The opened
[`recursive-hq/polar-evals@8d94585489911a3688193cb61462a3bc99654580`](https://github.com/recursive-hq/polar-evals/tree/8d94585489911a3688193cb61462a3bc99654580)
contains evaluation results and identifies a browser agent, but no runner.
The source supports an explicit browser substrate; it does not support changing
raw task text, demanding arbitrary extra browser steps or using a token browser
visit while explore actually supplies the answer.

## Per-hunk map

Rose line numbers below refer to the base revision; symbols identify moved code.

| Changed surface | Opened source / existing Rose contract | Why this shape / limits |
| --- | --- | --- |
| `agents/benchmarks/run_benchmark.py:create_agent` | V1 `run_eval.py:107-115`; existing `is_polar_bench_task` and API body's start phase | Select explicit browser execution by suite identity. Preserve raw prompt and catalog object. No keyword selection. |
| `back-end/src/domains/agents/types.ts:CreateAgentSchema` | Existing plan/execute admission plus `agentLifecycleService.ts:78-102,248-269` | Admit browser start phase through the same API and persist existing workflowStartPhase. No new database field or default. |
| `back-end/src/providers/temporal.ts:StartAgentWorkflowParams` | Existing positional workflow argument contract at `:330-370` | Extend the typed phase union; preserve argument ordering. |
| `back-end/src/domains/agents/agentWakeService.ts:launchParams` | Existing persisted workflowStartPhase; wake deliberately begins a new task | Browser-bound agents retain that executor on new work. Other modes still wake at execute. |
| `back-end/src/domains/agents/agentRestartService.ts:startReplacementWorkflow` | Existing replacement claim, saved resumeState and generation fencing | Preserve browser launch intent while restoring native execution state. Other modes still start at resume. |
| `agents/workflows/agent_workflow.py:__init__,_restore_deployment_state,_continuation_resume_state,_run_phases` | Existing native continuation at `:1374-1530`; mode cannot be inferred from execute_continued/resume | Persist execution intent plus accepted request/schema contract and dispatch ID. Browser branch uses native lifecycle and never enters free root actor. |
| `agents/workflows/agent_workflow.py:_finish_execute_result` | Existing execute terminal body at `:2936-2960`; post-DAG guard at `:2815-2848` | Extract unchanged shared terminal handling so browser completion retains accepted-schema and superseding-feedback guards. |
| `agents/workflows/agent_workflow.py:_response_schema_user_messages` | Existing durable ordered feedback reader at `:3188-3280`, canonical `_poll_messages` / `_admit_durable_response_schema_feedback` | Optional browser read excludes redundant schema prose, uses canonical row admission, fails closed on read failure. Default schema-generation behavior remains unchanged. No invented user instruction. |
| `agents/workflows/background_agents.py:FINISHED_RECORD_KEYS,_record_background_event,_finish_background_task` | Native browser `handler.py:13855-13888` emits success only for verified completion; clean auth refusal can also be FINISHED | Preserve actual browser success separately from generic wrapper completion. Never manufacture a browser trajectory or infer success from a wrapper. |
| `agents/workflows/browser_execution.py` | BackgroundAgentsMixin `:413-675` native start/record/join/handoff; `_wake_background_task:705-789`; native browser manager `:12730-12915`; `_attempt_post_dag_completion:2961-3057`; `_run_verifier:2915-2925,3161-3191` | Dispatch the initial accepted requirements/schema at neutral about:blank. Keep the same native conversation during in-flight/paused updates, restore actual resume hints, require native success plus acknowledged updated input, then real completion tool and verifier. The native manager uses one logical browser identity per root; no second dispatch can replay writes. Post-terminal changed requirements fail closed. Superseded verifier output continues; ordinary failed verifier remains failed. |
| `agents/domains/spawn_browser_agent_v3/handler.py:_browser_instruction_receipt`, native successful return and manager terminal metadata | Existing live `_sync_browser_user_instructions:1479+`, pre-action synchronization at `:9479`, pre/post verifier checks at `:10923,11047` | Expose the already acknowledged durable user-row IDs and confirmed/current-schema state of successful browser verification. This is native execution evidence, not a generated instruction. The root compares only post-launch deltas; initial goal predates the session boundary. |
| `agents/tests/blackbox/browser_execution.blackbox.py` | Owning BlackboxResult runner and existing workflow fixtures | Deterministic admission red/green, native state lifecycle controls, actual workflow entry and continuation, actual verifier interruption, accepted input races and ordinary failure controls. Browser/model/database boundaries are mocked; these are not live task outcomes. |
| `back-end/src/tests/unit/browser-execution-mode.test.ts` | Real wake/replacement producers, isolated transpiled imports | Exercise actual parameter construction with mocked persistence and Temporal boundaries. Preserve ordinary phase behavior. No backend or deployment required. |

## Independent review and gates

Managed reviewer: `ph79x0wes55k0qxakj3rtvt8yh8h3ets` (same devbox, read-only).
The final reviewed implementation retains one native conversation for live
updates and requires its actual input acknowledgment. The source was applied
only after exact-snapshot approval. Final reviewed patch SHA256:
`f17c90011690d85bd951f1f64db9091f7d50fd1d9ed4500d1d4db9a59f073021`.
Verdict: **GROUNDED**, implementation/reference scope only. Full report SHA256:
`c40f727f2c0e83e2c57e03eb1ade0ad833d25c0938357e0c56ce1c9f913c80fd`.
The accepted snapshot checks the actual returned root verifier requirement keys
against the original launch baseline and native receipt, closing input arrival
during join and during the verifier's own fresh poll. Seventeen focused controls
pass. No source changes followed review; case/packet documentation is separate.

Outcome proof is separate: the historical saved failure still fails the original
external browser check. Deterministic admission passing is not a claim that
BU-074 or the 26-copy cohort now passes. Next proof is the exact unchanged task
on isolated local stack, followed by the unchanged full slice at k3 when the
parent authorizes its held campaign. BU-002's CAPTCHA acting-prompt conflict and
its other judge failure remain R2. External Foundry quota is unrepaired and no
numeric cap is known; successful fallback means it was not this cluster's blocker.


Applied-source gates: canonical agents blackbox domains `browser-execution`,
`workflow`, `background-agents`, `run-agent` passed together (run
`20261027-185204-984057-825c8698`); full `spawn-browser-agent-v3` passed (run
`20261027-185209-984860-65f1f967`). Backend wake/restart control and TypeScript
compilation passed. Original provider replay and saved fail/pass regrade preserve
their original behavior. RCA archive validation passed. No live benchmark or
production deployment was used as a substitute for these deterministic checks.
