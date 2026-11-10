---
id: 2026-11-10-backend-production-dump-guard-omits-private-archive
date: 2026-11-10
title: Backend chat captures stop at the production plaintext guard without a private archive producer
surface: back-end
component: llm-dump-private-archive
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: back-end/src/providers/llmDump.ts dumpLlmContext returns null for a defined FLY_APP_NAME before any encrypted private base-call producer exists
symptoms:
  - No archived LLM base calls
  - Archived LLM dump recovery failed
  - Both chat-mode tasks passed but supplemental durable LLM publication failed
  - FLY_APP_NAME is defined as an empty string
  - Equal-millisecond updates recover FIRST instead of SECOND
tags:
  - llm-dump
  - chat
  - private-archive
  - fly
  - observability
sources:
  - commit 5690b07270b16e82c1cf024207a915be9c2925cc
  - agent b1c7ff8b-2599-444a-9961-2eb48927843d
  - agent 10bdd264-624b-4d9d-a8ff-72c792408336
  - fleet run 20261110-051613-2790952
  - fleet run 20261110-051613-2790951
repro: back-end/src/tests/blackbox/llm-dump-archive.blackbox.ts proposed in the ignored candidate; original empty-Fly helper and independent update controls retain their pre-fix evidence
status: open
---

## Problem

The original SourceA and SourceB logical campaigns on pushed commit `5690b07270b16e82c1cf024207a915be9c2925cc` each completed their normal two-stack infrastructure canary and then their unchanged actual `chat-mode` task. Each parent exited zero, published its ordinary Hub bundle, verified its canonical native teardown audit, and closed its source-consumer claim. Both task grades remain PASS. This case concerns their separate mandatory full-call evidence, not a reinterpretation of either grade or the original run clocks.

The standard `scripts/publish_evidence_links.py --run-json <original chat-mode/run.json> --agent-id <original root>` failed once for each root with `No archived LLM base calls` followed by `Archived LLM dump recovery failed`. It failed before the supplemental Hub upload and did not produce a verified FE/dump evidence pair. The original task Hub UUIDs are `882f4a3c-dc8e-4bf0-a4b8-953798dcc714` and `850b1319-0fa4-4243-8805-13d84f374d29`.

The original private publisher logs, strict archive listings, task/cleanup receipts and hashes are recorded under `.context/preparation-recovery/llm-dump-rca/diagnosis.json` and `.context/preparation-recovery/parallel-5690-final-proof.json`. Each strict listing contains only its correct root's five start/end fixture and manifest/finalization-control objects; neither has an `llm/` base object. Retained backend logs record three actual Node Cerebras request starts per root, then archive finalization with only two fixture artifacts. Python worker activity is not the source of these chat completions.

## Diagnosis

**Gate attribution: NOT_INTRODUCED relative to main `8046dcbc3`.** The owning `back-end/src/providers/llmDump.ts` is byte-identical there and at the failed campaigns: SHA256 `443e6cde0822a3f3e3a19f3f8a5f29b8d8c881fe5e6e9d6795ce39ae31119c40`.

The router and generator already supply `dump_context`; `back-end/src/providers/rose/client.ts` calls `dumpLlmContext` before streaming and finalizes its output afterward. The source of the evidence gap is the next boundary: the helper treats any defined `FLY_APP_NAME`, including the cloud runner's explicit empty assignment, as production and returns `null`. That correctly prevents plaintext local prompt dumps. However, the module has no encrypted private archive path at all, so the original full requests are never produced for the strict materializer. Its later refusal is correct.

A provider-free invocation of the unchanged actual TypeScript helper reproduces the boundary: defined-empty Fly identity returns null and creates no directory; absent Fly identity writes the development dump. Network calls were prohibited and counted zero. The failure is not evidence of a wrong archive owner or credentials: both authenticated listings contain the correct root fixtures, and the approved capsule/controller archive enablement, backend and credential/bucket hashes agree.

The two exact listed end fixtures were read through the strict authenticated archive provider, retained encrypted and decrypted privately with mode 0600, and inspected without connecting to a database. Each contains the original eight messages and three ToolUsage rows. Those rows contain model/token/cost checkpoints, not complete request messages, tool schemas, generation options, or original base-call payloads. The retained Hub task trees and service logs also lack those complete payloads. Recovery from the retained objects is therefore insufficient; reconstructing prompts from transcripts or current constants would fabricate evidence. No old dump qualification is claimed.

Archive searches used the literal failure plus Node/Fly/private-archive terms. The related September 11 missing `dump_context` case has a different boundary because the current builders already pass that binding. The October 3 Render plaintext-dump case requires preserving the current production privacy guard. The September 27 inherited-identity case concerns local test configuration; unsetting Fly identity is not the repair for an actual cloud campaign. These are related cases, not proof of this incident or a recurrence of their exact causes.

The deepest owned cause is an observability contract gap: production plaintext suppression was treated as the end of capture rather than selecting the existing encrypted archive transport. Deleting the privacy guard would violate the earlier safety decision. Reusing the existing private envelope/store/materialization path removes the writer/reader mismatch without a second storage system.

## Solution

**Independently reviewed R3 candidate applied by the coordinator at a quiescent boundary; not yet committed, shipped, or natively qualified.** The proposed change is confined to `llmDump.ts`, one drain call in `traceArchiveLifecycle.ts`, and the new automatically discovered `llm-dump-archive.blackbox.ts` domain. It reuses the existing encryption, envelope validation, `storeWorkerArtifact`, late-finalization manifest reconciliation and strict materializer. It binds the real caller agent to its same-user original root, registers pending work before asynchronous root lookup, orders base acknowledgement before immutable updates, and joins the original end fixture's agent queues before its finalization fence and terminal artifact acknowledgement. Production plaintext suppression and development behavior remain intact. Archive-disabled behavior is explicit and unchanged.

Independent review found two real defects in the first ignored candidate: circular update serialization synchronously escaped into model completion, and equal-millisecond updates sorted by random filenames could materialize the earlier output last. The narrowed revision catches serialization inside the best-effort boundary while retaining a failed own-root queue, and binds fixed-width monotonically increasing update filenames to the immutable call handle. It preserves actual metadata timestamps and refuses clock regression instead of inventing a clock. The materializer and Python/legacy object formats are unchanged.

The ordinary blackbox runner discovers and executes the new owning domain. Its focused revision passes all fifteen boundary controls with real private encryption, storage and strict materialization, while external networking is forbidden. It covers defined-empty Fly production capture, complete request/schema/tools/output retention, ordered updates, same-user root authority, disabled-archive and development compatibility, no plaintext production files or secret log canary, base failure and own-root drain rejection, independent pending roots, malformed updates, equal-time reverse-UUID order and actual timestamp regression. Database rows, manifest-lock ownership and unrelated derived indexing are explicit fixture doubles; no model, provider task, database query or native campaign was added. The existing unmodified production privacy unit also passes. The original helper failure, independent adversarial findings and missing-drain causal failure remain retained.

Author scale review found that the first drain waited only for its own agents but still scanned the global handle map. The coordinated ignored refinement adds a synchronous agent-to-handle index and reads, rechecks and removes only original fixture-agent queues. A deterministic owning control poisons only the module handle map scan: it fails before this index and passes afterward, without a timing threshold or production debug export. R2 independent review and the subsequent R3 changed-hunk review are recorded. The coordinator applied the exact reviewed R3 files; original pre-fix and R2 finding evidence remains preserved. Queue work scales with that root fixture's agents and pending calls, not unrelated roots; graph ownership resolution remains bounded indexed ancestor reads and every call adds the existing private base/update archive I/O, not new model calls.

**Open acceptance:** independent review and the scale refinement are complete, but validation of the unchanged task definitions on the final frozen source, full native evidence publication and retrieval remain PENDING. That future coordinated validation is a NEW experiment with distinct run identities and original clocks, not a reset or retry of these historical receipts. There is no automatic campaign launch, historical call reconstruction, or promotion of old supplemental failures. Later evidence can append a records-only closeout without changing the original receipts. Golden reference: not applicable (no approval-gated prompt, model, schema, evaluator or agent-behavior hunk).

## Human feedback

The original user required full parallel testing with unchanged task budgets and prohibited Kernel allocation, app-global secret mutations and protected-resource interference. The coordinator chose two bounded one-task chat campaigns using SourceA and SourceB and instructed each logical cohort to launch once; that specific count and launch-once plan was a coordinator instruction, not an original human requirement. The coordinator also required actual grades, publication and exact native cleanup rather than inference from startup claims, and kept this author lane in ignored candidates until independent review. Original clocks and failed receipts must remain intact. Any post-fix validation is a new separately coordinated experiment with distinct identities, not a reset of either successful runtime receipt or its failed supplemental evidence. These coordination decisions are not represented as new human approval or a deployment.

## Reusable lesson

Preserve production plaintext suppression while producing and draining authenticated encrypted full-call records before claiming durable evidence.
