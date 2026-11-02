---
id: 2026-10-31-rose-1-oss-open-weights-models-omit-nested-output-schema-on-browser-spawn
date: 2026-10-31
title: rose-1-oss open-weights models never emit the nested `output_schema` object on a browser spawn_agent call, so the structured-output retry burns all three regenerations
surface: agents
component: rose-pools
classification: model-intelligence-limitation
problem_class: model-intelligence-limitation
first_bad_boundary: agents/providers/rose/pools.py rose-1-oss waterfall (moonshotai/kimi-k3 -> qwen/qwen3.8-27b) — the served open-weights model's tool call omits `output_schema`, which agents/utils/tool_schemas.py check_spawn_agent_constraints requires when type='browser'
symptoms:
  - "LLM call failed 3 consecutive times: ValidationError: 22 validation errors for AgentAction"
  - "function-after[check_spawn_agent_constraints(), SpawnAgentRoseDesktopTool]: Value error, output_schema is required when type='browser'."
  - "llm.structured_candidate_excluded actual_model=moonshotai/kimi-k3 failed_responses=2"
  - "rose.waterfall.step_skipped reason=reply_cut_off_at_output_limit (mislabel: the skip was a structured-output exclusion)"
  - "browser-biometrics-webdecoy FAILED after 64 s, $0, no browser agent spawned"
tags:
  - rose-1-oss
  - structured-output-retry
  - spawn-agent
  - open-weights
  - kimi-k3
  - qwen3-8-27b
sources:
  - agent 8099ad68-8b9d-4593-baf7-df56df370da3
  - PR #1660
  - commit f039142da
  - agent ea6390fd-4c8e-433f-8b3d-a9b4b04aa77d
  - commit a334edca1
repro: agents/tests/blackbox/llm.blackbox.py::test_structured_exclusion_carries_into_next_activity_attempt (+ test_structured_retry_feedback_narrows_to_model_level_branch_error) and agents/tests/blackbox/rose.blackbox.py::test_waterfall_logs_structured_exclusion_reason_separately_from_cut_off (+ test_truncation_labels_cut_off_models_without_relabeling_structured_exclusions); model-capability replay via RoseClient().complete(pool="rose-1-oss") on the dumped attempt-1 input
status: mitigated
---

## Problem

Evidence files: `.llm-dumps/8099ad68-8b9d-4593-baf7-df56df370da3/*execute_loop.json` (9 dumps, deploy 12), `.llm-dumps/ea6390fd-4c8e-433f-8b3d-a9b4b04aa77d/*execute_loop.json` (3 dumps, deploy 11), worker.log of isolated stack `1793477059-3761178-91894`, and the replay script `/var/tmp/rca-oss-replay/replay.py` (RoseClient().complete, 2026-10-31 20:30–20:45Z).

Pre-deploy smoke task `browser-biometrics-webdecoy` (pinned `model: rose-labs/rose-1-oss`, open-weights only) FAILED in deploy 12 round 1 after 64 s at $0: root agent 8099ad68 made nine `execute_loop` LLM calls (3 outer `run_agent.structured_output_retry` attempts × 3 inner parse retries), and every one returned a `spawn_agent` call with keys `type, task_name, goal, start_url, run_in_background, depth` and no `output_schema`. `check_spawn_agent_constraints` rejects that for `type='browser'`, so no browser agent was ever spawned and the task's browser-session and step-count checks failed.

Served models per outer attempt (worker.log of stack 1793477059-3761178-91894): Foundry DeepSeek-V3.2 `deployment_disabled` → kimi-k3 (invalid) → kimi-k3 (invalid, `llm.structured_candidate_excluded failed_responses=2`) → qwen/qwen3.8-27b (invalid). All nine replies have `finish_reason: tool_calls` and 420–601 completion tokens against `max_tokens: 8192` — **not truncated** (H1 refuted). The model reasoning in the retries literally says "Browser agent requires output_schema. Let me retry with an output_schema." and then the emitted arguments still lack it.

## Diagnosis

Critical path: execute_loop messages+tools → RoseClient waterfall (rose-1-oss) → OpenRouter kimi-k3/qwen → streamed tool_call arguments (raw, streaming.py:501-509) → `AgentAction.model_validate` → `check_spawn_agent_constraints` raises → `_build_structured_retry_messages` replays the call + feedback → regenerate (×2) → candidate excluded → next leg → outer retry ×3 → agent FAILED.

Discriminating measurements (all through `RoseClient().complete`, identical dumped messages/tools, temperature 1.0, max_tokens 8192, effort xhigh; `actual_model`/`pool_name` recorded per call):

- kimi-k3, attempt-1 input (no feedback): 0/2 emit `output_schema` → INVALID.
- kimi-k3, attempt-2 input (one feedback round, verbatim replay of its rejected call): 0/2 → INVALID ("Need to add output_schema for browser agent.").
- kimi-k3, attempt-3 input (two feedback rounds): 0/3 → INVALID; all three replies re-emit the replayed rejected call byte-for-byte (args_len 1569 = prod attempt-2 payload).
- kimi-k3, user-only feedback with the rejected call removed (H3 variant): 0/3 → INVALID ("Let me spawn a browser agent with proper output schema.").
- kimi-k3 with nullable `anyOf` wrappers collapsed in the tool declaration (provider-shape variant): 0/3 → INVALID.
- Prod: kimi-k3 0/8 across deploys 11 and 12; qwen3.8-27b 1/4 (the single success, deploy 11, emitted `output_schema` as a JSON string that `ResponseSchemaConfig._coerce_malformed_input` repaired).
- Model-only control, same input on `rose-1-ultra` → `openai/gpt-6-sol`: 1/1 VALID with a well-formed `output_schema` (407 tokens, 4.3 s).
- Candidate open-weights rescuer `deepseek/deepseek-v3.2` via OpenRouter: 1/2 VALID, 16–23 s per call.

Totals: kimi-k3 0/21 (prod+replay), qwen3.8-27b 1/4, deepseek-v3.2 1/2, gpt-6-sol 1/1. `agents/` code is byte-identical between the passing deploy-11 run (a334edca1) and the failing deploy-12 run (f039142da): the only difference is qwen's sampling luck on its 3 shots.

Hypothesis verdicts: H1 truncation — refuted (finish `tool_calls`, ≤601/8192 tokens). H2 model omits a complete field — confirmed as the cause. H3 feedback not reaching the model — refuted as the cause (reasoning acknowledges the field; removing the replay does not help), but a real sibling defect exists (below). H4 Foundry fall-through — refuted (each DeepSeek attempt fails in <1 s, candidate order identical to the comparator).

Deepest owned causes (Step 5a):

1. **Pool capability contract** (`agents/providers/rose/pools.py` rose-1-oss): the pool's only legs cannot reliably produce the nested `output_schema` object the root execute-loop contract requires for every browser/code/general_purpose spawn, so a required-field validation turns into a 3×3 regeneration storm and a dead agent. Model limitation per the controlled replay; the pool composition is what we own.
2. **Exclusion does not carry across outer retries** (`agents/loop/run_agent.py` structured_output_retry → `call_llm_structured_streaming` `_skip_models`): each of the 3 outer attempts re-tries the already-excluded kimi-k3 twice, so 6 of 9 calls go to a 0/21 model and the only model with any success rate gets 3 shots instead of 7.
3. **Feedback narrowing fails on model-level validator errors** (`agents/utils/error_utils.py _selected_tool_errors`): the matching spawn branch reports its error at loc `("tool_calls", 0, "function-after[...SpawnAgentTool]")` (length 3), which the `len(loc) < 4` guard skips, so no branch is selected and all 22 union errors are kept; the actionable one survives the 5-slot summary only by position (it was 3rd). Verified offline against the dumped arguments with `create_agent_action_model`.
4. **Observability mislabel** (`agents/providers/rose/waterfall.py:237`): a structured-output exclusion is logged as `reason=reply_cut_off_at_output_limit`, which sent this RCA toward truncation first.

## Solution

Landed on `fix/rose-1-oss-browser-spawn-schema` (owned harness defects 2-4 above; each regression observed failing on the pre-fix sources and passing after, both via the domain `run_all_tests` registration):

- (b) `LLMStructuredOutputError.excluded_models` carries the candidates excluded after two invalid replies; `call_llm_activity` reports them in `ApplicationError.details` (`{"excluded_models": [...]}`) and accepts them back as its new trailing positional `skip_models`; `run_agent` unions them into `skip_models_on_llm_retry` for the in-process inner retry and the activity path, and resets that set together with `exclude_anthropic_family_on_llm_retry` / `bypass_fast_mode_cache_on_llm_retry` once a response is accepted. Boundary: the exclusion lives for one LLM call sequence (all attempts of the same turn) and the next turn starts with the full pool — the exclusion answers this context's sampling pathology, not the model's fitness for later turns (browser steps, summaries) on the same pool. Regression: `test_structured_exclusion_carries_into_next_activity_attempt` (requests `[kimi, kimi, qwen]` then, with the reported exclusion, `[qwen, qwen]`).
- (c) `_selected_tool_errors` treats a three-part loc (`tool_calls.<i>.<branch>`, a model-level validator error) as a branch entry, so the matching branch is selected and the summary becomes `1 validation error(s): …output_schema is required when type='browser'.` instead of 22 union errors. Regression: `test_structured_retry_feedback_narrows_to_model_level_branch_error` (dumped kimi arguments through `create_agent_action_model`, offline).
- (d) `waterfall_complete(skip_reasons=…)` logs `structured_output_excluded` for llm.py exclusions and keeps `reply_cut_off_at_output_limit` for truncation.py cut-offs; `truncation.py` labels the models it adds and preserves incoming labels. Regressions: `test_waterfall_logs_structured_exclusion_reason_separately_from_cut_off`, `test_truncation_labels_cut_off_models_without_relabeling_structured_exclusions`.

10k-agent behaviour: per-call frozensets and one extra activity argument; no shared state, no new I/O.

Still proposals (not implemented; approval-gated or needing a measured leg):

1. Pool/config repair: give rose-1-oss a leg that passes the controlled replay on this call, or stop pinning root execute-loop work with required nested spawn parameters to legs measured at 0/21. Any new leg must keep the pool open-weights and be measured on the same replay before landing (deepseek-v3.2 measured 1/2 — not sufficient alone). Coordinator held this back from the fix branch.
2. Schema-level alternative (approval-gated, proposal only): the browser spawn path does not read `output_schema` in `tools/spawn_browser_agent_v3.py`; if the workflow can synthesize a default schema for browser children as it already does for schema-less roots ("Generated output_schema synchronously"), the `type='browser'` requirement could become a soft default instead of a hard reject. Needs parent approval and a load-bearing check before proposing further.

Outcome proof for the exact benchmark is pending the deploy's smoke lane (no local `run-bench --local` permitted on this box during the deploy round). The landed fixes raise the rescuer's attempts from 3 to up to 7 per turn; they do not make kimi-k3 or qwen3.8-27b emit the field, so `mitigated`, not `fixed`.

## Human feedback

Coordinator (2026-10-31): do not run `scripts/run-bench --local` or any local stack on this box during the deploy round; limit to RoseClient replays and the owning regression suite; state outcome proof as pending the deploy's smoke lane. Schema changes require a concrete proposal, not an edit.

## Reusable lesson

When an open-weights pool fails structured output on a required nested tool parameter, replay the exact dumped call through RoseClient on the same pool and on a capable pool before touching prompts, budgets or schemas — a `tool_calls` finish under the token limit with the field missing is a model-capability limit, and the owned fixes are pool composition, exclusion carry-over and feedback narrowing.
