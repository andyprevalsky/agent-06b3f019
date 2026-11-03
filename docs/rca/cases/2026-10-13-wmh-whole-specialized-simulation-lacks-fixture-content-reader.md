---
id: 2026-10-13-wmh-whole-specialized-simulation-lacks-fixture-content-reader
date: 2026-10-13
title: WHM startup prefix omits the full frozen network
surface: harness
component: specialized-simulation-fixture-grounding
classification: unresolved
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The original initial-state network contains aggregate counts rather than the complete frozen Person source; its causal contribution to fundraiser failure remains unproven
symptoms:
  - pipeline_audit_with_warm_leads
  - No fully verified actionable warm lead
  - full Tamy history in DB but no source-verified warm paths
tags:
  - wmh
  - fixture
  - message-history
  - source-grounding
  - whole-call-simulation
sources:
  - PR #1453
  - commit badbbc2b31dc1c09ff84c20101e085cd8875b313
  - agent 882b536f-5210-4c83-bf10-f2b4ce034228
  - fleet run f0a05573-f50e-49c2-b3c9-43b3b90dfbf9
repro: .context/whm-migration/rca-20261013/grounding/static-prefix-user-review/full_prefix_owning_assertion.py
status: open
---

## Problem

Run13 completed its authorized 60-minute window with no source-verified warm
investor paths, replies, meetings, commitments or settled proceeds. The native
retirement joined revision 414. Its `pipeline_audit_with_warm_leads` observation
does not establish an actionable warm relationship merely by its name.

A new read-only audit of the exact frozen fixture confirms all 42,910 original
messages for the acting **auth identity**: 23,130 iMessage, 10,593 email and 9,187 WhatsApp,
plus 2,225 contacts. The `SEED_MESSAGE_LIMIT=100000` full-history requirement was
satisfied in the database. This incident is not evidence of a wrong reseed,
missing message bytes, a corrupt native model or an incomplete migration.

The unchanged initial-state file has SHA256
`cdf955f29336eb54f70e3779bc8c07b79db6bf2c4a80f7d5bf0c61ba5e183c49`.
It is 13,909 raw file bytes; default `json.dumps` produces 10,523 bytes and compact
sorted canonical JSON 10,151 bytes. Network/source fields describe counts and
connectivity rather than providing the full contact/message corpus.

Private audit artifacts are under
`.context/whm-migration/rca-20261013/grounding/`; no message bodies, source contact
details or credentials belong in this public case.

## Diagnosis

**Scope of the evidence.** The audit parsed all 540 captured native prediction
requests, 410,426,415 joined captured message-content bytes, across the full run. No original
`MessageRecord.id` occurs in those requests. Exact matching tested 120-character
original lines for 18,041 fixture messages using 27,581 plain/JSON-escaped prefix
variants. One prefix shared by two fixture rows occurred in a late
`candidate_response` delegated `goal` and five subsequent `visible_conversation`
requests. No corresponding source IDs or complete source package accompany it.
Therefore **“no message body ever reached the native model” is unsupported**.
These results exclude exact tested substrings/IDs, not paraphrases or knowledge
that an actor copied into a delegation. They establish no complete source-history
reader or provenance in the captured native requests.

The 416 retained LLM dump files for all 25 actors present in the native history
also contain zero declared `grep` tool schemas. The production dispatcher has a
grep handler, but that alone does not make the source-search tool available to
these actors. Actual tool declarations, not the dispatcher registry, determine
what the acting models could choose.

**Traced paths.** The frozen database feeds ordinary agent user context through
`helpers/get_user_context.py` (up to 200 recent messages and 100 top contacts), and
ordinary live Explore can search messages through `grep`. The database does not
automatically become the simulator's current-world evidence. In simulate mode,
`agents/domains/spawn_agent/handler.py::_spawn_explore` returns through
`_spawn_world_model_specialized` before `fetch_local_data_summary` and the actual
Explore activity. That path forwards the delegated goal/arguments and root goal,
then obtains one terminal native prediction. `run_benchmark.py` seeds the exact
per-run JSON before agent creation; `ParallelWorldModel.new_session` copies that
seed and the native prediction builder uses state/history/retrieved transitions.
It has no fixture database/source reader. Backend logs contain no
`/api/data/grep` requests for this run. Simulated descriptions of searches are
not proof of real fixture reads.

**Owning-boundary checks, not a completed repair.** Executed:

1. `agents/venv/bin/python .context/whm-migration/rca-20261013/grounding/audit_grounding.py`
   — all 540 request audit above; 23.737 seconds with section attribution.
2. `agents/venv/bin/python .context/whm-migration/rca-20261013/grounding/run_fixture_grep.py`
   — real `back-end/src/domains/data/service.ts::grep` through Prisma, on a
   verified `default_transaction_read_only=on` connection to the exact frozen
   source. PASS: all 42,910 messages and each channel's expected count; 2,225 contacts;
   real bounded content/source paths returned; foreign identity 0 matches.
   Service work 0.701 seconds. No model, embedding, provider or benchmark calls.
3. Existing owning blackbox
   `test_simulate_mocks_specialized_agents_but_keeps_general_purpose_real`, plus
   a captured `_spawn_explore` invocation, PASS through private
   `boundary_replay.py`: one `world_model_specialized_agent_activity`, zero live
   source fetches and zero specialized agents started. This positively proves
   deliberate whole-call simulation; it is not a baseline FAIL/candidate PASS.

**Deepest proven boundary.** Why 1: DB availability does not supply a source reader
to the native whole-specialized operation. Why 2: the actual specialized executor
and its source tools are deliberately bypassed to implement whole-call
simulation. The next rung is that documented design choice, so do not call it
an accidental wrong fixture or silently undo it. A source-grounded private
record lookup requires an explicit simulator source-access capability. The
financial outcome is still unresolved: neither a controlled causal before/after
prediction nor the exact unchanged benchmark before/after has been run. The
missing reader must not be presented as the proved cause of all missing outreach.

**Archive searches.** Searched
`pipeline_audit_with_warm_leads no fully verified actionable warm lead` and
`WMH message fixture counts history grounding`. The first returned unrelated
keyword hits; the second found the root-goal/start-fixture and public-resource
cases. Those are relatives. This case retains the root goal, exact seed and
complete frozen records, and concerns access to existing private sources rather
than generation of plausible unknown public pages. It is a distinct capability
gap, not recurrence of the seed-null bug.

**Golden references, inspected read-only.** Claude Code
`claude-code-src/src/tools/GrepTool/GrepTool.ts:441` actually runs ripgrep and
keeps incomplete-search errors distinct from zero matches. Hermes
`/home/boxes/rose/hermes-agent/tools/file_tools.py:1053` executes a scoped,
paginated source search with path checks and source-content redaction. OpenClaw
`/home/boxes/rose/openclaw/src/agents/sessions/tools/read.ts:372` reads actual
immutable captured file bytes with cancellation and pagination. Codex
`/home/boxes/rose/codex/codex-rs/core/src/tools/runtimes/unified_exec.rs:653` uses
the execution manager for actual tool output. These are source-access analogs,
not WHM simulator-policy equivalents. The proposed capability converges on
explicit source reads, scoped provenance, pagination and visible errors; none
supports treating aggregate row counts as relationship evidence.

## Solution

**2026-10-13 user steering:** the source-query proposal below is superseded and
rejected. The user requires the full network to be static and loaded in the WHM
prefix at the start of the run. A complete data-only startup override is prepared
under `grounding/static-prefix-user-review/` and proven at the native and wire
prefix boundaries. Use the existing `--wmh-initial-state-file` selector for a
future explicitly authorized run. No query reader or invented relationship
graph has been implemented. The historical query design below is retained as
rejected investigation history, not a pending implementation.


No production/runtime repair is claimed. The original native artifact, frozen
fixture, policy identity, prompts, task, soft examples, shared state, sampling
and replay keys are unchanged. No new paid call or full benchmark ran.

Concrete preparation is complete: an exact private extraction contains 42,910
message documents (73,266,788 bytes) and 2,225 contact documents (733,549 bytes), with
stable source IDs and whole-file SHA256 in `source-snapshot-manifest.json`.
`source-access-proposal.json` specifies a session-bound, read-only source-query
stage at the simulator boundary using the existing generic `grep` service.
It can read every fixture row without rebuilding the original model or buying
embeddings. Message/relationship truth must remain current-world evidence,
separate from historical transition examples and probability calibration.

The simulator must choose explicit typed source queries, retain exact returned
pages/source IDs and snapshot/query/result digests, and replay the same frozen
source bytes through repair/retry/rebase. A zero-match result must remain distinct
from unavailable access. Do not derive or rewrite queries from fundraising
keywords, insert invented warm connections, expose new tools to the agent under
test or silently replace whole-call simulation with live specialized execution.

Wiring source results changes LLM-visible simulator evidence/protocol and requires
review of the concrete diff before implementation. No such evidence injection
has been applied. A future owning blackbox must prove original-record provenance,
foreign/snapshot rejection, failed-vs-empty reads, cancellation and replay
stability; the separately authorized unchanged local benchmark remains the
non-substitutable outcome gate. The RCA stays open until those proofs exist.

At 10k agents, share immutable snapshot bytes by content identity, retain bounded
source pages and fixed/backpressured reader admission, and avoid per-agent corpus
builds, whole-history prompt copies, global mutable counters and per-root write
locks. The fixture-service check does not establish 10k-agent throughput.

## Human feedback

The user required the correct new Tamy fixture and her whole messaging history,
progress toward realistic complete fundraising, and one subagent plus `/RCA`
per issue. Earlier task instructions preserve original sources and forbid new
paid trials without authorization, benchmark/prompt changes solely to pass,
model substitution, fabricated warm relationships, merge or deployment.

2026-10-13 static-startup preparation now retains all 2,225 original Person
rows and all 33 columns. A lossless shared-value/columnar packet decodes to the
exact source rows, preserving nulls and source ownership with no inferred warm
edges. Expanded rows, packet and per-run initial-state override remain private.
Only `structured.network.static_full_network` is added; other original seed
values and policy are identical. The 42,910 raw message bodies remain in their
separate preserved source export and were not silently appended as network.

The same unchanged native/wire owning assertions fail on the original seed
(0.764s) and pass on the prepared static override (1.020s). The immutable cached
task prefix remains identical after replacing dynamic world state and loading
822 actual recorded history messages. Every row/column is reachable in that
prefix. Provider generation, world commits and model rebuilds are all zero.
Independent review PASS is preserved with the private preparation.

Local token estimates put startup at 367,788 input tokens and the largest of
five preserved large canonical probes at 694,843. These fit the documented
Azure primary input limit, but actual deployment admission and future history
growth are unproven; the smaller Cerebras shared fallback cannot fit this
prepared input. No context truncation, weaker packer or route change is proposed.
This proves static network startup inclusion, not a realistic warm introduction
or completed round. Another paid run remains unauthorized.

## Reusable lesson

Verify frozen source availability and explicit simulator access separately, and require source-record provenance before treating private relationship predictions as grounded.
