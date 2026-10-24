---
id: 2026-08-04-convert-context-to-messages-skips-provider-invariant-guards
date: 2026-08-04
title: convert_context_to_messages emitted two tool_result blocks for one tool_use, 400ing every leg of the pool
surface: agents
component: helpers/llm.py context-to-provider-message conversion
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py — convert_context_to_messages emitted one `role: tool` message per terminal TOOL row without deduping by toolCallId or pairing orphan tool_use, neither of which build_llm_messages omits
symptoms:
  - "each tool_use must have a single result. Found multiple `tool_result` blocks with id"
  - "RoseAllFailed: All 2 waterfall models failed for pool rose-1-ultra"
  - "tool_use ids were found without tool_result blocks"
  - "tool_result_pairing.repaired original_count=12 repaired_count=12 (completion_summary)"
  - agent finishes its work but call_site=completion_summary produces no summary
tags:
  - completion-summary
  - tool-result
  - anthropic-400
  - spawn-browser-agent
  - rose-waterfall
  - blackbox-false-green
sources:
  - agent 5cce9d33-72bb-4d85-9dee-70c6b1482507 (descend-full69-20261023 r004-j0055, recurrence 2026-10-23, 59/70 copies)
  - agent 1d7e1fb9-2604-45c6-906e-b6da1f12d4b7 (smoke task browser-biometrics-webdecoy)
  - agent 2a94f607-86e6-486d-aaf0-eca9d669f0af (smoke task browser-smoke, same 400, task still passed)
  - commit 3646fde6f (branch under test — proven NOT the cause)
repro: agents/tests/blackbox/llm.blackbox.py::test_convert_context_to_messages_one_tool_result_per_tool_use
status: fixed
---

## Problem

Every provider returned HTTP 400 for the `completion_summary` LLM call on smoke
task `browser-biometrics-webdecoy`. Anthropic named the defect exactly
(`worker.8.log:660`):

```
messages.2.content.1: each tool_use must have a single result.
Found multiple `tool_result` blocks with id: toolu_011ZJAa4M5KxJUzKuJsemswi
```

The claudeAuth leg rejected it as `rose.claude_auth.invalid_request` and fell
through without rotating the token (correct — 400s must not rotate). OpenRouter
`anthropic/claude-opus-4.8` returned the same 400, `google/gemini-3.1-pro-preview`
returned 400 `INVALID_ARGUMENT`, and the pool died with
`RoseAllFailed: All 2 waterfall models failed for pool rose-1-ultra`. Because the
payload is malformed rather than the provider being unhealthy, the waterfall
cannot degrade — every leg fails identically, and the agent loses its completion
summary entirely.

The exact failing request was captured at
`.llm-dumps/1d7e1fb9-.../1785887682046-2b570beafb04-completion_summary.json`.
Replaying it through `transform_messages_for_anthropic` reproduces the error
string and its byte position, plus a second latent violation:

```
FAIL: messages.2.content.1: each tool_use must have a single result. Found multiple `tool_result` blocks with id: toolu_011ZJAa4M5KxJUzKuJsemswi
FAIL: messages.4.content.1: each tool_use must have a single result. Found multiple `tool_result` blocks with id: toolu_01UJfkFCQbPQHWmBv5suVbnB
FAIL: tool_use ids were found without tool_result blocks: ['dd27bdbb-1e39-4414-bea1-4d1fce95b691']
```

**This did not cause the benchmark failure, and that failure is still open.**
`browser-biometrics-webdecoy` failed on `Browser agent f4ef3abc recorded 1
trajectory step(s); expected at least 5` after the first browser agent hit
`RuntimeError: Navigation failed: net::ERR_CONNECTION_CLOSED` against
`https://webdecoy.com/product/fcaptcha-demo/` (worker.4.log, span
`browser_activity_wait` status=error, 15144ms). `browser-smoke` hit the
identical duplicate-`tool_result` 400 in the same concurrent group and still
passed, which is what separates the two defects. The 400 diagnosed here is an
independent, silently-shipped defect that destroys completion summaries; the
trajectory-step failure needs its own RCA against the webdecoy navigation
failure and is **not** closed by this case.

## Diagnosis

Critical path: browser tool executes → two terminal TOOL rows persist →
workflow calls `generate_completion_summary` → `convert_context_to_messages`
builds OpenAI-dialect messages → `transform_messages_for_anthropic` → provider.

**Why 1 — where the data first goes wrong.** `convert_context_to_messages`
(`agents/helpers/llm.py`) appends one `{"role": "tool", "tool_call_id": ...}`
message for *every* terminal TOOL row whose `toolCallId` was declared by a
preceding ASSISTANT. It never checks whether it already emitted a result for
that id. The captured dump shows the consequence directly: messages 4 and 5
both carry `toolu_011ZJAa4M5KxJUzKuJsemswi`; messages 7 and 8 both carry
`toolu_01UJfkFCQbPQHWmBv5suVbnB`. The Anthropic transform bundles consecutive
tool-result user messages into one turn, so both land in `messages.2.content`
— matching the provider's `messages.2.content.1` verbatim.

**Why 2 — why two rows exist.** `spawn_browser_agent` persists two terminal
rows per tool call. Inside the activity,
`save_browser_action_message(title="✓ Task Completed" | "Task Failed", ...)`
passes `tool_call_id=tool_call_id` explicitly
(`agents/domains/spawn_browser_agent_v3/handler.py:4235`, `:6705`, `:7512`). At
the manager boundary, `yield ToolEvent(title="Browser automation complete" |
"failed", ...)` (`:8485`, `:8528`) carries no id of its own — it is stamped by
the shared event handler, `agents/helpers/handle_tool_event.py:62`, which sets
`"toolCallId": tool_call_id` on every `POST_MESSAGE` before persisting. That is
the mechanism by which two independently-written rows end up sharing one id.
`spawn_claude_code_agent` has the same shape (`handler.py:202`,
`service.py:1791`). Confirmed in `backend.log` for agent 1d7e1fb9 and in the
dump's message titles.

Whether the double-write is *itself* desirable was not settled here: nothing
was found that consumes both rows, `build_llm_messages` has always discarded
one, and the duplicate still inflates raw-context consumers this fix does not
touch (`helpers/summarize.py` token estimation, `helpers/context_compaction.py`).
Collapsing the write path is a live follow-up. It is not the fix for *this*
incident, because a converter that emits an invalid payload when handed two
rows is broken regardless of who wrote them, and because two other tool
families already produce the same shape.

**Why 3 — the deepest owned cause.** The repo has **two** context→provider
converters, and only one enforces the provider contract. `build_llm_messages`
(the main agent loop) applied *both* guards: an inline "keep only the latest
terminal row per toolCallId" pass, and `_ensure_tool_result_pairing`, which
already drops duplicate tool results (`llm.py:1976`) and synthesizes missing
ones. `convert_context_to_messages` applied **neither**, even though its only
production caller — `helpers/summarize.py:1059`,
`generate_completion_summary` — is the one that passes `include_assistant=True`
and therefore is the only path that emits `tool_result` blocks at all. The rule
existed, was tested, and was simply not reachable from the second converter.
That asymmetry is the bug: a provider invariant enforced per-converter instead
of once.

Why 4 would be "the message pipeline was designed with two converters", a
design fact whose remedy (one shared enforcement) already lives at Why 3. Stop.

**Branch causation — answered.** Not caused by commit `3646fde6f`.

```
$ git diff --stat 5ef01b873..3646fde6f -- agents/helpers/llm.py \
      agents/domains/spawn_browser_agent_v3/ agents/loop/dag_executor.py
(empty — 0 lines changed in all three)
```

A scratch replay of the captured context through `convert_context_to_messages`
+ `transform_messages_for_anthropic` was then run in `git worktree`s of all
three revisions:

```
$ git worktree add /tmp/rca-base 5ef01b873 && git worktree add /tmp/rca-main origin/main
$ for wt in /tmp/rca-base /tmp/rca-main .; do (cd $wt/agents && python .repro_dup_tool_result.py); done

/tmp/rca-base   (5ef01b873, merge-base)  messages.2 role=user content=['tool_result','tool_result']
                FAIL: Anthropic payload has multiple `tool_result` blocks with id: toolu_011ZJAa4M5KxJUzKuJsemswi
/tmp/rca-main   (5b1249f29, origin/main) messages.2 role=user content=['tool_result','tool_result']
                FAIL: Anthropic payload has multiple `tool_result` blocks with id: toolu_011ZJAa4M5KxJUzKuJsemswi
.               (3646fde6f, branch)      messages.2 role=user content=['tool_result','tool_result']
                FAIL: Anthropic payload has multiple `tool_result` blocks with id: toolu_011ZJAa4M5KxJUzKuJsemswi
```

Identical failure at the identical index on all three. The branch's
`activity_helper.py` change *reduces* retries and its `summarize.py` changes
only touch token estimation. Not concurrency-dependent either: `browser-smoke`,
run in the same concurrent group, hit the same 400 and still passed. (The
scratch script was superseded by the checked-in blackbox tests and deleted;
`test_convert_context_to_messages_one_tool_result_per_tool_use` asserts the
same thing permanently.)

**Secondary find.** `agents/tests/blackbox/llm.blackbox.py` returned
`r.summary()` (a dict, always truthy) into
`SystemExit(0 if asyncio.run(run_all_tests()) else 1)`, so running that file
directly exited **0 with 3 red tests**. It was the only blackbox file returning
a dict; the rest return `r.all_passed`. The `/deploy` gate
(`scripts/run_blackbox_tests.py`) reads `summary["failed"]` and correctly
exited 1, so no regression escaped — but direct invocation reported a false
green.

## Solution

Enforce the provider contract once, at the boundary where context becomes
provider messages, and make both converters share it.

1. Extracted `build_llm_messages`'s inline dedup into
   `collapse_duplicate_tool_results()` (`agents/helpers/llm.py`) — keeps the
   latest terminal (`FINISHED`/`ERROR`) TOOL row per `toolCallId`, leaves
   `IN_PROGRESS` rows alone. `build_llm_messages` now calls it instead of
   re-implementing it, so the terminal-row dedup has exactly one definition.
   Between that and the redundant filters removed in item 3, the two converters
   lost 87 lines and gained 120 — the additions are the shared helpers and
   their docstrings; the per-converter logic shrank.
2. Added `drop_rows_never_sent_to_model()` and made **both** converters run
   `collapse_duplicate_tool_results(drop_rows_never_sent_to_model(context))`.
   Order matters: the original inline dedup ran *inside* the filter loop, so a
   row that is never sent (excluded, sub-agent-internal, cloud-agent lifecycle)
   could not win. Hoisting the dedup without hoisting the filter would let a
   later-timestamped internal row win and take the real result with it,
   orphaning the tool_use — guarded by
   `test_convert_context_to_messages_subagent_row_cannot_win_the_dedup`.
3. `convert_context_to_messages` now returns through
   `_ensure_tool_result_pairing` — the same closing guard
   `build_llm_messages` has always applied. Its now-redundant inline
   `is_excluded_from_model` / `is_internal_subagent_message` /
   `_is_cloud_agent_lifecycle_tool` checks were deleted rather than left as a
   second definition of the same filter.
4. `get_timestamp` now re-anchors **all** terminal rows to their IN_PROGRESS
   timestamp, not just `FINISHED`. Adding the pairing pass in item 3 made this
   load-bearing: verifier TOOL rows render as `role: assistant`, and
   `_ensure_tool_result_pairing` treats every assistant as a run boundary, so
   an un-anchored `ERROR` row sorting after a verifier row left its declaring
   assistant "uncovered" — the pass then synthesized a placeholder *and* kept
   the real result, recreating the exact duplicate-`tool_result` 400. Caught by
   adversarial review, reproduced, fixed, and pinned by
   `test_convert_context_to_messages_verifier_row_between_call_and_error_result`.
5. `_context_timestamp` now normalizes every parse path to UTC. An
   offset-naive timestamp string parsed naive while the missing-timestamp
   fallback was aware, so comparing the two raised `TypeError` — a crash
   surface introduced by the new dedup comparison. The dedup also uses strict
   `>` so ties keep the earlier row, exactly as the inline dedup it replaced
   did, and `build_llm_messages` now sorts on the same `_context_timestamp` the
   dedup keys on so a row cannot win the dedup and then sort elsewhere. Pinned
   by `test_collapse_duplicate_tool_results_timestamp_edge_cases`.

The latest row wins, which is the row `build_llm_messages` has always shown the
main loop, so the two converters no longer disagree about *which* result a tool
call produced. They still differ in other respects by design — only
`build_llm_messages` does pointer annotation, attachment resolution, and
superseded-browser-failure filtering — so this is convergence on the
one-result-per-call contract, not on the full message shape.

One honest cost: on the browser *error* path the surviving row
("Browser automation failed: RuntimeError: …", 86 chars) is thinner than the
one now dropped ("Task Failed: **Status**: ❌ FAILED / **Outcome**: … /
**Error**: Failed during: initialization", 135 chars). This is not a
regression — `build_llm_messages` already showed the main loop only the thinner
row — but it does mean the completion summary sees less error detail than the
context holds. Enriching the manager-boundary error row is the right follow-up;
changing which row wins would diverge the two converters again.

Sibling failures this also prevents: the orphan `attempt_completion` tool_use in
the same captured request (`dd27bdbb-...`), which would have 400'd the summary
the moment the duplicate was fixed; the identical dual-terminal-row shape from
`spawn_claude_code_agent`; and any future tool that posts both an in-activity
and a manager-boundary result.

Also fixed the always-green `__main__` guard in
`agents/tests/blackbox/llm.blackbox.py`.

10k agents: the change is pure per-request list filtering, O(messages) in one
agent's own context with no shared state, no new I/O, and no per-agent
subscription or connection. It strictly *reduces* bytes sent per LLM call by
dropping a duplicated tool result. Cost is unchanged with agent count.

Regression coverage in `agents/tests/blackbox/llm.blackbox.py` (run by
`scripts/run_blackbox_tests.py`, which `/deploy` invokes at Step 4g):
Targeting the original defect (each observed red on the unfixed code, green
after, assertions unchanged):

- `test_convert_context_to_messages_one_tool_result_per_tool_use`
- `test_convert_context_to_messages_pairs_orphan_tool_use`
- `test_collapse_duplicate_tool_results_keeps_latest_terminal_row`

Guarding hazards the fix itself introduced (each verified to fail when its
specific guard is reverted, so none is merely asserting post-fix shape):

- `test_convert_context_to_messages_verifier_row_between_call_and_error_result`
  — reverting `get_timestamp` to FINISHED-only re-anchoring reproduces
  `[('tc-verifier-interleave', 'messages.1.content.0'), ('tc-verifier-interleave', 'messages.3.content.0')]`
- `test_collapse_duplicate_tool_results_timestamp_edge_cases` — flipping `>` to
  `>=` fails the tie case; dropping the UTC normalization fails with
  `can't compare offset-naive and offset-aware datetimes`
- `test_build_llm_messages_dedupes_duplicate_terminal_tool_rows` — removing the
  `collapse_duplicate_tool_results` call from `build_llm_messages` emits both
  rows
- `test_convert_context_to_messages_subagent_row_cannot_win_the_dedup` — guards
  the filter/dedup ordering in item 2

Pre/post evidence for the original defect:

```
# pre-fix (llm.py at 3646fde6f)
❌ convert_context_to_messages_one_tool_result_per_tool_use: expected 1 tool message,
   got ['toolu_011ZJAa4M5KxJUzKuJsemswi', 'toolu_011ZJAa4M5KxJUzKuJsemswi']
❌ convert_context_to_messages_pairs_orphan_tool_use
❌ collapse_duplicate_tool_results_keeps_latest_terminal_row
llm FAIL (174 passed, 3 failed)   # scripts/run_blackbox_tests.py llm -> exit 1

# post-fix
llm PASS (177 passed)             # scripts/run_blackbox_tests.py llm -> exit 0
# full agents suite: Results: 90 passed, 0 failed
```

## Adversarial review

Step 7 review caught a P0 in the first version of this fix: adding
`_ensure_tool_result_pairing` to `convert_context_to_messages` without also
re-anchoring `ERROR` rows recreated the duplicate-`tool_result` 400 whenever a
verifier row landed between a tool call and its error result. It was
reproduced, fixed (item 4 above), and pinned by a test verified to fail when
the fix is reverted. The review also produced the tie-break, naive-timestamp,
dedup-key-vs-sort-key, and redundant-filter corrections, and forced the
overclaims about "identical view" and the -27-line count to be walked back.
The reviewer's remaining open objection — that the browser double-write may
itself be the thing to delete — is recorded in the Diagnosis as an unsettled
follow-up rather than silently resolved.

## Recurrence 2026-10-23 — the orphan guard hid a pairing bug

**Evidence.** In /descend run descend-full69-20261023, 59 of 70 completed roots logged
`tool_result_pairing.repaired` exactly once, on `call_site=completion_summary`
(first: r004-j0055, 23:16:19.59Z, `original_count=12 repaired_count=12`). The
decoded completion_summary dump showed the root's final assistant turn with its
`attempt_completion` tool_call already removed and the verifier verdict
(`⚖️ Progress: 100%: …`) as a separate assistant message. The count did not
change because stripping a tool_call removes no message.

**First-bad boundary.** `convert_context_to_messages` turned every
`verifierMessage=True` TOOL row into assistant text. `run_agent` posts the
verifier verdict as the `attempt_completion` call's FINISHED row with
`toolCallId` = the declared call id, so that conversion left the declared
tool_use without a result, and `_ensure_tool_result_pairing` stripped it.
`build_llm_messages` has no such branch and pairs the same row as a tool result.
The 2026-08-04 fixture (`test_convert_context_to_messages_strips_orphan_tool_use`)
used a verifier row with no `toolCallId`, which is why the guard looked correct.
The guard was masking a converter disagreement, not repairing a real missing row.

**Fix.** A verifier row whose `toolCallId` is declared is that call's tool
result in both converters; verifier rows with no declared call keep the
assistant-feedback rendering. Stale comments in `run_agent.run_verifier` that
said the feedback reaches the model as assistant text are corrected. The guard
stays as a tripwire: it firing is a bug (`claude-code-src/src/utils/messages.ts:5120-5133`
logs every activation "to help identify the root cause" and throws in strict mode).

**Repro (red→green).** `agents/tests/blackbox/llm.blackbox.py::test_completion_summary_context_pairs_verifier_result_with_attempt_completion`
(registered in `run_all_tests`). Pre-fix: `guard fired: [call('tool_result_pairing.repaired',
original_count=3, repaired_count=3)]`. Post-fix: passes; the `llm` domain is green 5/5.

**10k agents.** No change in cost: one conditional per TOOL row in an existing O(messages) pass.

## Human feedback

The task explicitly warned that the branch's `activity_helper.py` change
*reduces* retries and so plausibly should reduce rather than cause duplicate
tool results — "verify, don't assume". Verified: the branch is not the cause on
any of the three revisions tested. The task also required treating the prior
archive hits (`2026-04-17-claude-code-messages-minted-fresh-tool-call-ids`,
`2026-07-22-browser-chips-keyed-by-task-render-twice-on-retry`) as leads rather
than verdicts; both concern *identity minting* on the write path, whereas this
incident's evidence points at the *read* path, where two legitimately-persisted
rows are converted without dedup. Neither prior diagnosis was adopted.

## Reusable lesson

When two converters feed the same providers from the same context, the provider
contract has to be enforced once in code both call — a guard that exists in only
one converter is a guard the other will violate.
