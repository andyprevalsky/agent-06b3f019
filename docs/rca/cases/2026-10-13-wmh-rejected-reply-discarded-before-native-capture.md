---
id: 2026-10-13-wmh-rejected-reply-discarded-before-native-capture
date: 2026-10-13
title: WHM discarded rejected provider replies before native capture
surface: agents
component: rose-wmh-provider
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: _WMHInvalidPrediction retained the validation reason and metering but discarded the rejected response bytes before the provider bridge and native prediction writer
symptoms:
  - "WMH prediction rejected: Expecting ',' delimiter"
  - "WMH prediction rejected: Extra data"
  - "WMH prediction rejected: Duplicate JSON key in outcome distribution"
  - "WMH prediction rejected: Outcome probabilities must sum to 1"
  - "_WMHInvalidPrediction object has no attribute rejected_response"
tags:
  - wmh
  - rose-client
  - json
  - prediction-capture
  - protocol-repair
sources:
  - PR #1453
  - commit badbbc2b31dc1c09ff84c20101e085cd8875b313
  - commit cfc29428257c18dd5666f1969e6ff3c4ebb90e61
  - agent 882b536f-5210-4c83-bf10-f2b4ce034228
  - benchmark run f0a05573-f50e-49c2-b3c9-43b3b90dfbf9
repro: agents/benchmarks/wmh_reliability_test.py test_rejected_distribution_capture_keeps_exact_bytes_private_and_validation_strict
status: open
---

## Problem

Run13 used the unchanged `raise-5m-rose-labs-brex` task, frozen Tamy fixture and
60-minute execution window on `badbbc2b3`. Native session
`69eeb4a4a80d4975af6c7998ba7086b8` preserved 540 prediction records and 415
validated outcome selections. Of the predictions, 125 were rejected; all 125
error records lack the rejected response, actual model and per-call usage.
The corresponding provider log has 125 `wmh.rose.invalid_prediction` events
with a reason and model, but no rejected reply bytes. The run ended in an
execution-window failure; the [published trajectory](https://www.roselabs.ai/?agent-id=882b536f-5210-4c83-bf10-f2b4ce034228)
is evidence of that outcome, not a successful fundraising proof.

The full population is more precise than “125 malformed JSON replies”:

| Validation rejection | Attempts |
| --- | ---: |
| Expecting comma delimiter | 91 |
| Extra data after JSON | 18 |
| Expecting colon delimiter | 1 |
| Expecting a quoted property name | 1 |
| Duplicate JSON key | 7 |
| Invalid tool observation or call identity | 3 |
| Probabilities do not sum to one | 3 |
| Invalid outcome keys | 1 |

Thus 111 are syntax/trailing-data errors and 14 are duplicate-key or protocol
errors. JSON-object mode cannot replace probability, unique-key, identity or
state validation. Ninety-three call IDs encountered a rejection. Twenty-one
call IDs exhausted a native repair attempt; 17 later committed after activity
retry and four never committed. This does not mean 125 independent failed
operations. The provider log attributes 124 rejections to
`gpt-5.6-luna-foundry` and one to `qwen/qwen3.8-27b`; the Qwen rejection is
`Invalid outcome keys`. All 540 metered completions report `finish=stop`.
There is no recorded completion-limit evidence for these rejections.

## Diagnosis

The path is native request and immutable execution identity → loopback bridge →
Rose collect/provider transport → strict distribution validation before DEMO
completion → invalid-prediction exception → bridge error → native protocol
repair and prediction writer. The observed generation failure first appears at
distribution validation. Its deeper cause remains unproven because its source
bytes were discarded. The proven capture defect is separate: the baseline
exception stores only the reason, sanitized metering and model; the bridge
forwards only the reason, and the native writer can therefore preserve only an
error instead of the response that caused it.

The original native requests are available without capture redactions. The
offline population audit recomputed and verified all 540 embedded request
SHA256s using the pinned native helper. It reconstructed the canonical native messages,
system policy, empty tools, `tool_choice=none`, 16,384-token budget and execution
identity for the first error and first syntax error. The actual Rose
configuration was `rose-1-flash`, Azure first, `result_required=True`,
`retry_partial_errors=True`, `dump_context=False`, with the existing 590-second
whole-call, 90-second TTFT and 120-second idle guards. The run source did not
support the later `json_mode` option. Absence of JSON mode is a candidate
mitigation target, not proof of the original generation cause.

Four pairs have byte-identical canonical native request payloads and fingerprints
at the same snapshot revision, with one rejected and one successful prediction.
The original log has 540 `wmh.stream.rendered` events; the exact Rose message
arrays after stateful stream rendering, STREAM_GUIDE and cache boundaries are
not preserved. Equal native inputs do not prove equal sent wire layouts. Their
successes do not recreate the missing failed outputs or prove model
intelligence, provider, parser or concurrency causation. The immutable Run13
dump inventory contains 416 agent LLM JSON dumps and zero WHM call-site dumps.
The other inventory member is a span ledger. Agent dumps and nearby successful
WHM replies are not substitutes for the rejected WHM responses.

Evidence and reconstructed private inputs are retained under
`.context/whm-migration/rca-20261013/json/`: `findings.json`,
`first-failing-original-record.json`, `first-syntax-failing-original-record.json`,
`same-input-original-pair.json`, `source-hashes.json` and pre/post test logs.
`analyze.py` only reads the owned originals; it does not call a service/model or
alter the originals. The original log is
`.context/wmh-resume-generation1/run13-flash-azure60m/wmh-serve.final.log`.

Archive searches were `TextWorldModelProtocolError WMH prediction rejected JSON
Extra data` and `world model malformed structured output repair rejected response
capture`. The empty-prediction and full-build JSONL cases are relatives: they
identify different first-bad boundaries. Neither reproduces this discarded
reply boundary, so this is a new capture incident, not a recurrence of them.

## Solution

The existing follow-up `cfc294282` retains the rejected bytes and sanitized
metering in `_WMHInvalidPrediction`, carries them through the authenticated
loopback bridge and native exception, and uses the existing redacted private
prediction writer before repair. It leaves invalid output out of world history
and DEMO completion. Unifying with that writer avoids a second capture store or
an ordinary-log response body. Work is proportional to this one reply, with
per-prediction files and existing session ownership; no global lock, query,
poller or cross-agent serialization is added.

The new owning regression exercises seven synthetic syntax/protocol controls
through both the stream validator before cache `done` and the actual
RoseWMHProvider/ASGI bridge boundary. It requires exact byte retention,
credential-free usage, rejection before cache completion and absence of reply
and credential markers in ordinary warning logs. These are synthetic controls
for the proven capture defect, not fabricated originals or a replay of Run13's
missing replies.

The final unchanged test file runs eight controls through the original baseline,
the prepared response-only capture and the new full-envelope capture. The
seven semantic/syntax controls now additionally require the exact request;
an eighth uses the real StreamBook and authenticated ASGI bridge to require
STREAM_GUIDE, cache-boundary blocks, routing/JSON flags and the exact collected
messages while excluding auth objects. No prior assertion was weakened.

```bash
source /home/boxes/rose-wmh-resumed/agents/venv/bin/activate
PYTHONPATH=agents python -m pytest -q agents/benchmarks/wmh_reliability_test.py -k 'rejected_distribution_capture or rejected_prediction_captures_actual'
```

On original `badbbc2b3`, the seven response-capture controls fail because
`rejected_response` is absent. The additional wire test cannot establish this
old boundary: it first encounters an unsupported `json_mode` constructor option.
Its original-baseline failure is excluded from causal wire proof.
On prepared `a389797bb`: eight failures, exit 1, 1.05s (missing request capture).
After the WHM-only full-envelope correction: eight passes, exit 0, 0.78s. The
same test file has pre/post SHA256 `0deedb3099aad6acc91b93a1070dc088c836287ab591d05bca238e2914f5a550`.
Private original response-only proof is `original-response-capture-final-fail.log`.
The all-eight old-baseline log is retained only as an excluded diagnostic.
Wire proof logs are `wire-capture-before.log`
and `wire-capture-after.log`; source comparisons are in `source-hashes.json`.
The normal registered `world-model-harness fast-cache-client` runner passes both
domains in 16.5s, including 59 native and 208 provider/reliability cases. Isolated
Ruff 0.17.0 passes all three changed Python files. Adversarial review is recorded
with the final handoff.

The follow-up now passes safe collect-input fields into the existing private
rejected-response envelope from both pre-cache and cached validation. It copies
messages/config only on rejection, excludes lease/auth objects, and changes no
messages, model routing, budgets, replay keys, policy, sampling or ordinary
agent behavior. The same private native writer retains this envelope before
repair; it is not committed world evidence or a DEMO replay entry. No second
capture store or global mutable state was added. This improves future replay
insurance; it cannot recover the exact lost Run13 wire layouts or rejected bytes.
The existing native capture test also checks capture before repair and absence
from committed history. The permanent WMH blackbox discovers this test file
through `test_native_rose_provider_regressions`; `/deploy` Step 4g invokes it.

Supporting JSON-format transport references, not capture proof: Claude Code's
`claude-code-src/src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:131`
compiles and checks the supplied schema before successful structured output;
Codex's `codex/codex-rs/core/tests/suite/json_result.rs:56` verifies the actual
Responses `text.format` schema and strict flag; OpenClaw's
`openclaw/src/agents/embedded-agent-runner/extra-params.sampling.test.ts:116`
checks run-scoped response format precedence; Hermes'
`hermes-agent/agent/auxiliary_client.py:1677` translates format to the provider's
native structured-output field. Their common pattern makes format an explicit
request contract. The prepared WHM JSON-mode option converges on that transport
pattern while retaining stronger local distribution validation. None of these
references proves Run13's generating cause or guarantees fundraising success.

Capture-specific references were also searched for `raw_response`,
`rawResponse`, `rejected_response` and `rejectedResponse`. Codex
`codex/codex-rs/core/src/session/mod.rs:4271` preserves raw response items through
its existing event path; OpenClaw `openclaw/src/proxy-capture/runtime.ts:327`
persists an owned exchange with redacted headers and a request body separately
from transport rejection. These are capture/provenance analogs, not proof of
Run13 causation. Claude and Hermes searches found no exact matching private
invalid-distribution capture boundary. The WHM correction converges on retaining
source data in the existing owner rather than logging response bodies publicly.

The exact-wire, raw-output and unchanged benchmark outcome gates remain open. No
paid replay or new benchmark was run during this investigation. Resolution
needs an original failing provider response, or newly authorized matched work
that captures a rejection through the preserved local client path, followed by
the unchanged benchmark outcome proof. Do not report this benchmark fixed from
the capture or JSON-mode contract tests.

## Human feedback

The user required Rose completion on Flash, one Azure-first routing flag,
WHM-only deadline changes and explicit failed-example filtering, then requested
one 60-minute run. After seeing the results, they asked for each issue to be
tackled by a sub-agent using `/RCA`. The completed paid run is not authority for
another paid trial, merge or deploy. Preserve the native policy, shared world,
parallelism, sample-once/replay identities, original fixture and goal.

2026-10-13: the user approved schema descriptions and DEMO reporting, required
the full static network in the startup prefix, and rejected unmentioned
proposals. They asked whether WHM errors belong to schema validation or the
existing Rose completion retry owner. The two validation boundaries differ:
the approved Zod annotation repair preserves response field descriptions;
WHM syntax/probability/call-identity/state validation remains strict.

The private retry experiment positively reproduces a separate recovery gap:
WHM validation occurs after `RoseClient._complete_impl` has left
`recover_truncated`, and its ValueError does not enter the existing RoseError
recovery path. A private candidate validates raw attempts inside that same Rose
owner, records rejected attempts before its existing next-model retry, and
preserves numeric usage/cache counters and per-model cost attribution. It does
not add a retry loop, weaken validation, or raise the existing timeouts.

Native-to-bridge mock-inference checks exercise caller cancellation/rejoin,
retirement, capture admission and unrelated parallel requests. An initially
failing retirement test exposed a candidate capture-admission race; the same
assertion passes after correcting that private proposal. Caller disconnect
preserves admitted work under the native shield/rejoin contract; retirement
cancels and joins it without a new world-history commit.

**Whole retry proposal held and unapplied:** its current helper uses the
existing redaction/atomic-write primitives but introduces a separate
`native-provider-rejections` directory and schema. That is not the existing
native prediction writer. One-store ownership and existing archive/export/
replay schema compatibility must be proven before application. Mocked local
mechanism tests neither recover the lost original replies nor establish the
exact fundraising outcome; those RCA gates remain open.

The final frozen patch has SHA256
`1b489f5e1d162f43cf64f54ee82c48b94039fcfacfe9bd2014109090e9c73f4e`
and remains outside task source. The identical six permanent owning assertions
produce five FAIL/one PASS on the baseline (0.55s), then six PASS plus a seventh
real native mock-inference integration PASS on the candidate (16.43s). The
complete affected local family passes 192 cases in 21.36s. The scratch fixture's
initial missing setup-script failure was corrected by pointing to the exact
authoritative script and already verified native interpreter; no replacement
artifact or dependency environment was built. Independent review HOLD confirms
the second-store integration gap and unproved mixed terminal usage, repeated
cancellation, crash recovery and capture-process scale behavior. No application
approval is requested from these mechanism controls.

All 173 regular private proposal/test/review/proof files are authenticated by
per-file manifest SHA256 and full encrypted archive readback. Nonsecret durable
receipts are `run13-validation-recovery-hold.json` and
`run13-retry-proposal-private-receipt.json` under
`docs/handoffs/whm-b07d9037-preservation/`. Original task records and all previously
preserved checkpoint artifacts remain intact.

## Reusable lesson

Retain every rejected structured response privately at its validation boundary before protocol repair, and distinguish syntax, semantic and task-outcome proof.
