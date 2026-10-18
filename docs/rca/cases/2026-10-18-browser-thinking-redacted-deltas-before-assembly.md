---
id: 2026-10-18-browser-thinking-redacted-deltas-before-assembly
date: 2026-10-18
title: Browser thinking redacted individual deltas before realtime assembly
surface: agents
component: browser-thinking-stream
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: BrowserThinkingStream._publish_assistant redacted each delta independently before stream_assistant_chunk queued append-only realtime records
symptoms:
  - split canary reached assembled realtime output
  - abandoned secret prefix must never be flushed
  - task-local split secret leaked
sources:
  - plan:.context/phone-harness/rose-phone-split-stream-before.log
  - plan:.context/phone-harness/rose-phone-split-stream-after.log
  - plan:.context/phone-harness/rose-phone-split-stream-final.log
  - plan:.context/phone-harness/rose-phone-split-stream-final-green.log
tags:
  - browser-credentials
  - phone
  - streaming
  - privacy
repro: agents/tests/blackbox/browser_credentials.blackbox.py:test_phone_split_stream_is_private_and_responsive
status: fixed
---

## Problem

Synthetic registered private text split character-by-character across alternating
reasoning/content chunks reached assembled realtime output. The normal suite
also exposed abandoned prefixes on restart and each task's own split secret
under concurrent independent credential contexts. No real credentials were used.

From agents with the venv activated, the exact command on both sides was:
`python scripts/run_blackbox_tests.py browser-credentials`.
The before log records all three new registered cases failing (suite exit 1,
13.2s). The first after log records all three passing (exit 0, 13.2s).
Tests keep the actual stream_assistant_chunk helper and intercept only its
_queue_realtime_record network boundary, then concatenate the emitted deltas.
They do not mock the helper being investigated or use the production redactor
as the expected-output oracle.

The expanded suite's final.log then caught a preservation regression in the
initial buffer: input 1234 became 1{{secret:card_cvv}} for private CVV 234.
That additional red evidence required preserving the preceding numeric boundary;
the assertions were unchanged for the subsequent final-green run.

## Diagnosis

Path: provider StreamChunk -> BrowserThinkingStream.on_chunk ->
_publish_assistant -> actual stream_assistant_chunk -> queued ASSISTANT_STREAM
record -> downstream delta assembly. Each partial string had no complete secret,
so whole-value redaction passed it through before the append-only publication.
Clearing a bubble on done cannot undo an already published private value.

Archive searches executed before implementation:
`python3 scripts/rca_archive.py search 'stream_assistant_chunk secret split'`
and `python3 scripts/rca_archive.py search 'credential chunks streaming privacy'`.
Read process-feedback and the solution/human-feedback sections of
2026-10-14-payment-fill-included-background-tabs. This is a related privacy
boundary failure, not the payment target-ownership incident or its whole-schema
serialization recurrence: the independently proven first bad boundary here is
chunk publication before assembly.

Golden references searched across claude-code-src, openclaw, hermes-agent and
codex for redaction/stream buffering. OpenClaw's
src/logging/redacting-stream.ts:3 retains only a possible credential prefix,
emits ordinary text immediately and flushes at end. Its model-egress test at
src/secrets/model-egress.test.ts:119 checks split credentials plus live progress.
No equivalent exact registered-secret incremental buffer was found in the other
three repositories in this search. Rose had a whole-value redactor but no
credential-aware incremental buffer; its CoalescingStreamBroadcaster is a
transport scheduler, not a privacy boundary.

## Solution

The assigned streaming owner retains only a suffix that can still become a
registered secret or public alias (including existing JSON/HTML/URL forms and
formatted payment forms). The existing task-context redactor remains the sole
replacement policy. A cut-equivalence check prevents splitting a known match
or protected reference. One extra preceding digit preserves numeric boundaries.
Finish redacts and flushes the pending tail; restart discards it before closing
the old stream. Ordinary unambiguous text is still published immediately.

Delete/unify/guard assessment: deleting streaming would suppress legitimate
progress; whole-response buffering would remove responsiveness. The minimal
new responsibility is bounded prefix retention around the existing redactor.
No prompts, deadlines, model selection or benchmark contracts changed.
The private ContextVar is read locally because the allowed file scope excludes
adding a shared public prefix-policy API to secret_refs.py; no registry copy is
stored on the stream. Future redactor form additions must update this prefix
recognizer or move both into a shared abstraction under separate ownership.

Existing coverage retained: phone_canary_never_reaches_stream_dump_or_resume_turns
checks a whole tool-call canary, initial and late LLM dump output, and resume
messages. New coverage adds real-helper queued-record assembly, alternating
content/reasoning chunks, restart stream separation, dropped abandoned tail,
finish flush/idempotence, concurrent task-local redaction, preservation of the
other task's public text, encoded secrets, numeric nonmatches, formatted PAN /
expiry, public aliases, and 10,000 incrementally emitted ordinary chunks.
The original three test bodies and assertions remained unchanged after red.
The expanded suite command is identical to the initial command.

10k-agent behavior: one bounded pending suffix per decision stream, no global
secret map, shared lock, timers, background tasks, extra subscriptions, database
queries or cross-agent scans. Work depends on that task's registered bindings
and incoming chunk, not fleet size. Existing agent:<agent_id> routing and stream
sequence protocol remain unchanged. Pending size is bounded by the largest
recognized form plus boundary context, not total transcript length. CPU work
includes canonical redaction and prefix comparison per chunk; no 10k-concurrent
fleet/load or network-throughput claim is made. The 10,000-chunk case establishes
incremental output only.

Limits: this proves the owning realtime boundary with synthetic known values,
not real phone onboarding, native provider execution, transport delivery, UI
rendering, unknown/unregistered secrets, arbitrary novel secret encodings,
secret-bearing media, or values emitted before their private registration.
No native benchmark was run in this assignment. Other runtime/backend and phone
benchmark files belong to the parent/other child. The user's explicit no-spawn
instruction overrides the usual RCA subagent review; review here was local and
adversarial tests, not an independent agent review. Parent owns archive reindex.

## Human feedback

User required test-first normal-suite red/unchanged-command green, synthetic
credentials only, bounded task-local state, responsive legitimate output,
retention of the existing canary test, exact logs, exclusive assigned files,
no commit/deploy/spawn, and preservation of Freedom and AGENTS instructions.

## Reusable lesson

Retain possible private-value prefixes before append-only publication and discard abandoned tails on restart while preserving numeric boundaries.
