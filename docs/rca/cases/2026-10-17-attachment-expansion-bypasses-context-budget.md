---
id: 2026-10-17-attachment-expansion-bypasses-context-budget
date: 2026-10-17
title: Attachment bodies expanded after pointer-only context budgeting overflowed a research agent's model input
surface: agents
component: attachment-context-assembly
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py build_llm_messages expands downloaded text attachments after agents/loop/run_agent.py checks a context estimate that contains only their file pointers
symptoms:
  - "LLM call failed 3 consecutive times: RoseAllFailed: All 2 waterfall models failed for pool rose-1-flash"
  - "context_length_exceeded"
  - "Your input exceeds the context window of this model. Please adjust your input and try again."
  - "OpenAI/OpenRouter stream closed without content or tool_call"
  - "rose.complete TTFT exceeded 90.0s"
tags:
  - attachment
  - context-window
  - context-compaction
  - file-pointer
  - roseallfailed
  - token-accounting
sources:
  - agent 2550d1d1-ff2d-4d57-ae8e-f03e9563b61a
  - commit fa1485b567a16d754dbd64d580d9ef4f65aab844
repro: agents/tests/blackbox/attachments.blackbox.py
status: open
---

## Problem

The production research child was assigned batch 29 of a YC/a16z Series A
verification task. It initialized, then exhausted every model route before
producing usable execution output or calling a research tool. The terminal
message was `LLM call failed 3 consecutive times: RoseAllFailed: All 2 waterfall
models failed for pool rose-1-flash`.

A read-only bounded sibling audit found 54 children created together at
20:25:45.661 UTC, all now FAILED with that exact status message. All 54 inherited
the same seven attachment filenames (378 attachment rows). This establishes
the scope of the shared input and terminal symptom, not independent provider
replay proof for the other 53 children. Captures are `siblings.json` and
`sibling-attachments.json` in the private evidence directory.

Retained worker evidence contains nine execute-loop provider requests from
20:26:08 through 20:34:07 UTC on October 17, 2026. Temporal attempted each of
three loop-level calls three times. The separate response-schema request
succeeded, and is not included in these nine failures. Do not infer that the
agent did no initialization work from its zero execute-output token counters.
All nine execute requests have the same messages, native tools and generation
configuration (one SHA-256 input fingerprint in `request-repeat-audit.json`);
retrying did not reduce or otherwise change the oversized input.

The exact requests were recovered with the repository's verified archive
materializer. Every execute request has 12 messages and six native tool
schemas. Seven attachments were inherited; six readable files were inlined.
Their combined input contains about 3.57 million characters. Measured with
`o200k_base`, the original last request's content is 1,090,156 tokens, before
adding tool-schema/framing overhead. The normalized YC dataset alone contributes
672,762 tokens; the a16z dataset contributes 274,023, and the match audit
119,093. These source files were not absent: the harness injected too much of
them into the execution model's input.

The recorded provider outcomes are distinct:

- Cerebras was skipped because its model credential was already on cooldown.
- Foundry returned six execute-call token-rate errors and three explicit
  `context_length_exceeded` errors.
- OpenRouter Qwen had three 90-second TTFT failures, three HTTP 400 responses,
  and three empty streams.
- OpenRouter Gemini ended without content/tool calls on all nine attempts.

The exact reasons behind Qwen's HTTP 400/empty streams and Gemini's empty
streams were not captured in the available provider payloads. The oversized
context is a proven harness defect and an explicit Foundry rejection; it is
not evidence that every other provider error shares that cause. Rate limiting
is separately observed; its relation to this oversized concurrent workload is
not established.

An exhaustive listing of this child's 11 archived objects contained only ten
LLM input dumps and one schema-output update; there is no raw HTTP response
artifact from which to recover the missing OpenRouter error bodies.

## Diagnosis

Critical path:

`inherited FilePointer rows -> context estimate/compaction -> attachment cache
resolution -> build_llm_messages -> Rose routing -> provider request -> retry
exhaustion -> FAILED`.

The source estimator at `helpers/summarize.py:_message_summary_weight` includes
file-pointer metadata but not the file bodies. `loop/run_agent.py` checks that
estimate before constructing provider messages. Then
`helpers/llm.py:build_llm_messages` expands each supported text file smaller
than the shared 20 MiB per-file threshold. It has no cumulative materialized
attachment budget. The standalone `resolve_attachments_for_llm` repeats this
expansion policy. Neither a 20 MiB individual file limit nor counting reference
metadata establishes that a full model request fits its context window.

The declared Rose pool window is 200,000 tokens; existing output and compaction
reservations leave a 167,000-token trigger. Replaying exact archived file bytes
through the real `build_llm_messages`, with downloads forbidden and the same
seven file pointers cached, yields a source estimate of 1,557 tokens and a
materialized request of 1,090,132 `cl100k_base` tokens. The slight difference
from the original request count uses another encoding plus reconstructed
system-message grouping; both measurements establish an input over a million
tokens, not an exact provider billable-token count.

Executed local command:

```bash
agents/venv/bin/python .context/rca-2550d1d1/repro_attachment_context.py \
  --source-root /home/boxes/rose
```

Pre-fix: exit 1, `Materialized prompt 1090132 tokens exceeds 167000 compaction
trigger while raw estimator reports 1557`. The same artifact against the frozen
candidate source passes in about 0.6 seconds with 24,553 `cl100k_base` tokens
and 24,564 `o200k_base` tokens. All seven exact filenames and the user's task
text remain present. This proves the repaired attachment-admission mechanism;
production deployment and live task recovery remain pending.

The permanent public-API regression is registered in the existing attachments
blackbox suite. The documented command
`cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py
attachments` fails on current production source with the actual oversized
assembly assertion: `3494880 > 154232` (serialized UTF-8 token upper bound
versus selected input allowance). The 33 existing tests pass; supporting new
API tests also fail until their new implementation exists. The exact core
assertion is unchanged on the candidate. Its additional cases cover aggregate
small files, actual downloaded size, tool/schema overhead, smaller selected
windows, required sources, reference growth and hidden rows.

The final frozen candidate passes all seven affected domains through the normal
runner: attachments, llm (234 checks), spawn-agent (143 checks), reasoning,
param-populator, run-agent (77 checks), and run-agent-pure. The final run took
11.7 seconds and exited 0 after the snapshot freeze. Ruff and Python compilation
also pass. These are local causal/regression checks; deployment smoke gates and
live provider outcome verification have not run.

The exact captured request was also replayed through `RoseClient.complete`,
real request builders, and real SSE parsers using `httpx.MockTransport` only:

```bash
agents/venv/bin/python \
  .context/rca-2550d1d1/replay_recorded_provider_failure.py
```

It preserves the captured messages, six schemas, generation budgets and
Foundry error payload, then replays the observed empty EOF state for the two
OpenRouter legs. It reproduces `RoseAllFailed`. Because the mocked responses
are fixed independently of input size, this establishes request reconstruction
and error propagation only; it does not prove that bounded input would recover
the providers or complete the user's task. No paid live rerun was performed.

Archive searches: `RoseAllFailed All 2 waterfall models failed rose-1-flash`,
`agent initialization no tokens zero first LLM call failed`,
`context_length_exceeded attachment inline json large files`, and
`file parent LLM inlining context budget aggregate`. The focused attachment
search found no earlier case at this exact expansion boundary. This is a
relative of `2026-08-04-compaction-token-accounting-asymmetry-grows-context`:
that repair unified DB-message metadata counting, but attachment bytes are
materialized later and never enter that estimator. Its metadata repair still
holds; this is an uncovered sibling boundary.

The deepest coherent owned class is disagreement between the representation
used for admission and the materialized request sent to the provider. A more
general, coherent repair is a shared prepared-request contract that accounts
for system/user context, tools/schema, framing, output reservation and expanded
attachments. That class is owned and must not be dismissed in favor of a
one-file threshold patch. Guaranteeing successful provider execution despite
external outages, capacity and model capability leaves this owned contract.
The candidate changes which file bodies reach the model and adds explicit
required-source errors. Those LLM-visible/context semantics require the concrete
approval snapshot before production application and deployment.

Abstraction check: the stopped class is admission of materialized text using
the same complete representation measured for the request; the candidate
accounts for surrounding messages and schemas rather than adding a per-file
threshold. The next wider attempt was exact provider-independent accounting
for every input modality. That is not a coherent local contract: image/PDF
tokenization and provider framing are provider-specific external behavior.
This repair therefore uses a conservative text bound and preserves ordinary
mandatory-context compaction, with its limitation stated explicitly.

Adversarial review independently reproduced the failure, checked the frozen
12-file manifest and the final passing suites, and approved the candidate for
bounded text attachment admission. It rejected attributing all fallback errors
to attachment size or claiming that mocked provider errors prove live recovery.

## Solution

Open pending approval, deployment and live verification. Production code is
unchanged. A complete candidate is isolated in
`.context/rca-2550d1d1/candidate-v2`; the earlier one-function experiment is not
the proposed final repair.

The candidate adds one shared text-file admission owner for both assemblers.
It renders a metadata-only projection of the complete message list, includes
the actual tool/schema and extra-user-message overhead, then admits only whole
file bodies within the selected model allowance. It reserves the existing
32,768-token output escalation plus the existing 13,000-token buffer. Its
serialized UTF-8 byte count is explicitly a conservative upper bound, not an
actual provider token measurement. Reference expansion and candidate identity
are checked again on the final normalized representation. Full source bytes
are unchanged. If mandatory baseline context is already too large, this policy
adds no optional text; it does not replace ordinary context compaction or prove
that every possible non-file request fits.

The actual context allowance is carried through inline, same-worker and
cross-worker calls, reasoning and parameter generation. Explore retains file
pointers until its full request is assembled, and bounds its allowance by its
own selected model window as well as the caller's constraint. Since Explore
cannot retrieve an omitted file through code/browser tools, required text that
cannot be read or admitted produces an explicit source-size/read error. Normal
parents retain their existing metadata and code/browser retrieval path. Images
and PDFs retain Explore's existing metadata-only behavior.

A Temporal patch marker preserves the old attachment-resolution command for
recorded histories. The legacy text-list activity argument remains in its
original positional slot; new pointer data is appended. Regression coverage
uses the actual Temporal payload decoder as well as both workflow branches.
No task prompt, provider deadline, schema definition or source artifact is
modified to obtain a pass.

The unchanged captured-request assembly repro now passes with 24,553 actual
`cl100k_base` tokens, all seven exact filenames and the task text preserved.
This is causal proof of repaired file admission, not provider-recovery or
research-completion proof. Final source/test snapshot and focused suite results
are recorded in the private candidate artifacts and approval request.

Golden references inspected:

- `claude-code-src/src/tools/FileReadTool/limits.ts:2-18` and
  `FileReadTool.ts:755-770`: gate file size and actual materialized tokens.
- `hermes-agent/tools/file_tools.py:50-63,97-108`: bound model-visible reads and
  return continuation offsets.
- `codex/codex-rs/core/src/context_manager/history.rs:565-573`: account for
  serialization allowance when admitting tool output.
- `openclaw/src/agents/tools/web-fetch.ts:318-342`: bound model-visible text
  while retaining the recoverable full-source spill.

The candidate converges on their shared pattern: bounded materialized
input with recoverable complete sources. A per-file threshold alone does not
solve multiple smaller files accumulating beyond one request's budget.

10k-agent requirement: budget and selection must remain scoped to each request,
linear in that request's input, with no new shared counters, fan-in, database
queries, subscriptions or cross-agent locks. Avoid reserializing a whole growing
request per attachment. The expected savings are smaller provider payloads and
fewer doomed retries; no numerical production-exposure estimate is available.

Evidence is private under `.context/rca-2550d1d1/`. Its exact last call was rendered
and uploaded using the existing `publish_llm_dump` helper; the presigned HTTPS
link and HTTP verification are in `published-dump.json` and
`dump-url-verification.json`. The regular publisher CLI rejected this real
non-benchmark agent because it requires a benchmark run UUID. No fake run UUID
or synthetic benchmark bundle was created. The canonical agent FE returns
HTTP 200 and its authenticated API identity matches; the app shell alone does
not prove fresh-browser transcript visibility. The captured tree has no browser
tasks requiring a recording. Source transcripts/dumps are not committed.

### October 18 delegated continuation

The latest user direction was to fix file counting via `/RCA`, rather than
repeat the investigation. Review of the preserved v2 candidate found additional
owned gaps: mandatory baseline requests and legacy prebuilt Temporal activity
payloads could bypass admission; reasoning could materialize a required file
and then discard it through a separate message-count trim; Explore converted
unsupported required sources to inaccessible metadata.

A revised isolated candidate is preserved at
`.context/rca-2550d1d1/candidate-v3`, with 10 runtime files and three owning
blackbox files. Its manifest is `candidate-v3-manifest.json`, snapshot SHA-256
`f3b8df84e42f005acc52a57570ad16139cc097ea36f18c6990afd13b84a12db2`.
The v2 frozen manifest and source were preserved. No root runtime or existing
root test changes were overwritten.

V3 validates mandatory complete serialized text requests even when no optional
body is admitted, including legacy prebuilt activity messages and final
appended instructions. It includes both schema projections, reserves 32,768
output tokens and the existing 13,000-token framing/compaction headroom, and
fails explicitly when required content cannot fit. Reasoning and parameter
population require accessible source content; reasoning no longer silently
slices off older materialized files. Explore now errors on required nontext
sources it cannot retrieve. Required download/decoding failures are explicit.
No prompt constant or tool description changed (Prompt diff: None).

The identical recorded reproduction, unchanged except `--source-root`, failed
on working baseline in 1.292 seconds: 1,090,132 cl100k and 1,090,207 o200k tokens,
pointer estimate 1,557. On final v3 it passed in 0.665 seconds: 24,553 cl100k and
24,564 o200k tokens, preserving all seven filenames and the task. Two new
regressions separately failed against frozen v2: an oversized mandatory
message was returned, and an oversized legacy activity request reached the
mock provider. The corresponding owning tests pass in v3. An additional unchanged regression
failed on v2 when reasoning discarded an older required file; it passes on v3
after removing the redundant message-count trim. All 13 frozen runtime/test
files also pass Python compilation.

Final focused validation: attachments, llm (234 tests), spawn-agent, reasoning,
param-populator, run-agent (77 tests), run-agent-pure: seven domains pass in
12.4 seconds. Wider workflow and workflow-determinism: two domains pass in
51.8 seconds. Changed runtime Ruff checks pass. Logs are private
`delegated-{baseline,fixed,v2-new-regressions,focused-final,temporal,ruff}.txt`.
These are source-boundary and mocked-provider checks, not proof of production
recovery or task completion.

Adversarial review confirmed the text-request correction and exposed a separate
limit: serialized bytes do not prove decoded image/PDF token costs, and provider
transforms can add framing. The framing buffer is an explicit reservation, not
an exact measurement of every provider projection. Do not describe v3 as a
universal multimodal guarantee. Preserving arbitrary multimodal capabilities
with complete route-level admission needs image dimensions, PDF page/extracted
text accounting and provider-specific projections or token counting. Those
were not implemented or claimed as verified by this text-attachment incident.

The exact-snapshot gate remains `.claude/commands/deploy.md` Step 0p: runtime
context-chunk selection counts as LLM-visible change and requires explicit
approval of the presented snapshot. The latest instruction directs the repair,
but is not acceptance of the earlier unaccepted snapshot, and v3 changes it
further. Therefore v3 remains isolated; no PR, merge, deployment, full deploy
coverage, smoke run or production recovery is claimed. Status remains open.

Supplemental reference evidence supplied by the parent was inspected locally:
Claude Code `src/utils/attachments.ts:3023` routes actual file attachments
through bounded FileReadTool reads; explicit sliced reads still validate output
tokens. OpenClaw `src/media/input-files.ts:92,211,396` bounds expanded uploaded
text/PDF text; its separate bootstrap owner
`src/agents/embedded-agent-helpers/bootstrap.ts:375` subtracts admitted content
from an aggregate allowance. These complement the references above: stored
source and model-visible projection are distinct; every expanded body belongs
in the aggregate request budget. Per-file caps alone do not establish it.

### Approved application and deploy continuation

On October 18, the user accepted the presented v3 snapshot with “ok sounds good
to me,” after the parent described budgeted whole-file inlining and existing
code-agent delegation for sources that do not fit. No direct read_file tool or
automatic delegation was proposed. Approval covers snapshot
`f3b8df84e42f005acc52a57570ad16139cc097ea36f18c6990afd13b84a12db2`, including
explicit request/source failures. The 13 frozen files were applied with exact
hash equality; existing dirty tests were inspected and preserved. The unchanged
recorded reproduction on applied source passes at 24,564 o200k tokens in 0.679s.

The earlier pending-approval statements above record the historical stages;
approval is now received and `/deploy` is active for the whole worktree. Its
private durable status is `.context/rca-2550d1d1/deploy-status.md`. Source assembly
proof does not establish completion of the original research task through
code-agent delegation. General agents can pass exact original filenames to
`spawn_agent(type='code')`; no direct read_file/get_my_files capability exists.

### October 22 correction: drop the blanket request gate (mass-agent smoke)

`test-mass-agent-run-0` failed on every run of the applied v3 source while it
passed on main. v3 added `assert_request_fits`, which rejected every complete
request, with or without attachments, whose size exceeded
`_DEFAULT_CONTEXT_WINDOW - 32768 - 13000 = 154232`. First run: GP children
failed with `158226 serialized bytes > 154232` (bytes counted as tokens).
With the loop's canonical estimate instead, the root's reasoning/DAG requests
still failed at 181k-285k estimated tokens. 200000 is only the fallback for
unknown models such as `rose-labs/rose-1-ultra`, and these are replays of
requests production served. The gate was new behavior beyond the original
defect, which was attachment bodies inlined without being counted.

Fix: remove the blanket gate from `run_agent` and `call_llm_activity`.
Attachment admission is unchanged: bodies are counted with the conservative
byte bound and inlined only within the allowance; a request already past it
keeps pointer metadata only; required inline sources still fail closed.
Requests without attachments pass through exactly as on main. Regressions:
`oversized_baseline_keeps_attachment_bodies_out` and
`legacy_prebuilt_request_without_attachments_reaches_provider` fail on the
gated source and pass after the fix.

### October 23 review corrections

- Reasoning and DAG parameter population no longer force required-inline
  attachments: an unrelated `.zip`, `.docx` or oversized upload anywhere in the
  conversation failed those tool-less calls closed. They keep the budgeted
  admission and fall back to the metadata label, as main did; reasoning keeps
  main's `MAX_CONTEXT_MESSAGES` trimming, which the removed whole-request gate
  had been meant to replace. Explicitly requested explore sources still fail
  closed. Regressions: `reasoning_keeps_metadata_for_unadmitted_attachments`,
  `populate_keeps_metadata_for_unadmitted_attachments`.
- A rejected non-text explore pointer is now refused before the explore
  heartbeat task starts (it previously leaked that task); pinned in
  `explore_text_only_sources`.
- Open: explore admission uses the byte bound while compaction uses the token
  estimate, so a large required source can fail closed mid-run before
  compaction would fire. Aligning compaction with admission is a separate
  harness change.

## Human feedback

On October 18, 2026, the user rejected displaying implementation code in
approval Detail: show only an exact prompt-text diff when one exists, and make
the preference durable. Context-selection code is not a prompt-text diff.
The shared approval contract, auto-loaded CLAUDE guidance, command templates,
and existing deploy-format regression now encode that rule. This presentation
correction does not approve the pending attachment-budget candidate.

On October 18, 2026, the user further directed: “so we should not skip files
when counting context / spawn a sub agent to fix via /RCA / and then answer /
how do the golden refs handle FILES in terms of these bounds”. The continuation
implemented and verified v3 in isolation, preserved the pending snapshot gate,
and did not treat pointer preservation as proof that expanded bytes were
counted. Complete multimodal admission remains an explicit unresolved limit.

## Reusable lesson

Budget the materialized provider request, including expanded attachment contents, rather than treating file-pointer metadata as the cost of the files themselves.
