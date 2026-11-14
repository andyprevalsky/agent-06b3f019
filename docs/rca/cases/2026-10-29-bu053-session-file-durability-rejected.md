---
id: 2026-10-29-bu053-session-file-durability-rejected
date: 2026-10-29
title: BU053 verifier accepts report but durable file delivery fails
surface: agents
component: browser-file-extraction-and-storage
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Session report has no durable output pointer after repeated storage HTTP400 and HTTP500 responses
symptoms:
  - Required file outputs could not be delivered
  - Durable copy of Tilion download failed; kept in worker memory
  - Extracted 0/5 files
  - Max iterations (100) reached
tags:
  - r58
  - it14
  - polar-bu-053
sources:
  - commit 85d37fc8ab8e284459977debdef34348d825ef84
  - agent d032ffb3-81ef-4c6f-9eb1-b98d9ee21554
  - plan: archive ed2ec38cacc82af1e27ebe59b03ae916f14f90b76655af04fdeceb04c2271b95
repro: none-recorded; original encoded verifier and storage status observations
status: open
---

## Problem

Original assignment2026-10-29T04:19UTC. BU053r2 jobr002-j0023 remains
nativeFAILED after2858.7seconds, canonicaltaskFAIL/infraFALSE; no declared
judge is in the normal run. Its final native message says Max iterations100
reached. Execution source85d37fc8ab8e284459977debdef34348d825ef84/patchnone.
All seven normal files verify against manifest
f295cd0010fdbb27ffe5b74866537f9b6fa08e9b3527bdd0226d9705eaede350.

The task asks for ten arXiv web-agent papers with first-version submission
timestamps, titles, PDF links, first authors and affiliations. This differs
from R46's date-only narrowing: the actual03121a2af870 generated node schema
requires a file containing all ten records and full first-version timestamps.
No unsupported recursive type or date-only coercion is observed here.

## Diagnosis

First verifier1704f80ae6c5 rejects a Blob URL as a remote filesystem pointer
and requires better affiliation evidence. Later549fb834ed5e accepts a downloaded
5225byte report and score1/task_completedtrue. Further research follows a later
partial verification; then469a08927a4f and6b56e6acee83 accept the saved report
and complete timestamps with score1/task_completedtrue.

The last captured verifier request6b56e6acee83 has payload SHA256
f771d90033760a160fd646484a26ab84940c4194d230f8caf86e1a4e971de25e.
It returns /tilion-downloads/3a289896d71adbb4/web_agent_papers_verified_final.json,
4750bytes, with ten entries. These verdicts establish what the verifier saw,
not independent proof that every bibliographic assertion was true.

Native storage events independently show failure. The download persister
retains bytes in the worker ledger when upload_to_storage raises HTTP400;
two attempts also encounter HTTP500. At04:04:44.844, extraction lists five
session files. Every upload failsHTTP400, including the named final JSON at
04:04:45.399. The extractor reports Extracted0/5files. The actor is then told
Required file outputs could not be delivered and continues until its100-step
limit. At04:05:17, a later upload_file action also cannot locate the proposed
filename through that provider path. No successful durable delivery follows.

Exact85 extract_session_files first reuses a durable ledger pointer if present,
otherwise reads bytes from the ledger and calls upload_to_storage. That helper
POSTs bytes to attachment storage and raises for non-success status. Exceptions
leave extraction without a pointer. The handler's required-file guard rejects
completion when resolve_file_pointers_from_extracted cannot establish a public
output pointer. It does not equate model task_completed with successful delivery.

The source logs exception status strings but not storage response bodies. The
normal evidence does not supply the server error code, original response body,
a complete authenticated request or storage bucket policy. Filename, MIME,
authorization and service health cannot be distinguished causally from HTTP400
alone. The twoHTTP500s are separately retained, not called the same cause.

## Solution

OPEN/no runtime candidate. The required-file completion guard is doing useful
work and must not be removed to convert the native verifier's1.0 into a PASS.
No arbitrary renaming, MIME override, permission bypass, retries, cap increases
or task-output rewrite is justified by these status-only observations.
Needed next evidence is an already captured original storage response body and
request metadata bound to the failed final JSON upload. No new request or
capture was made. R46's semantic date loss is a comparator, not a shared cause;
R37's storage400 observation is similar but not proven identical.

## Human feedback

Parent required original evidence before grouping and forbade assuming earlier
submission-time, schema or file-delivery incidents recur. NativeFAILED,
canonicalFAIL, infraFALSE, absence of declared judge, successful internal
verifier extraction and failed durable delivery are kept as separate axes.
Original04:19clock retained. No model/browser/provider/API/DB/live operation,
new test, source mutation or original grade change occurred. Tokens UNMETERED.

## Reusable lesson

Separate a verifier's session-file acceptance from durable output delivery,
and require the original storage error body before attributing an HTTP status
to a filename, MIME, credential or service defect.

## Bounded safe diagnostic followup

Original04:19R58 clock retained; diagnostic phase began approximately04:20–21UTC.
The original storage cause and task failure remain OPEN. The scoped diagnostic
change was independently reviewed GROUNDED as exact patch
 a8d0ac08f5ecd676fc3f7a8d2df16f913a457dceb13dfa34ccd3cf61793e79d7.
Only helpers/attachments.py and its registered attachment tests change.

At the existing HTTPStatusError boundary, upload_to_storage now emits a typed
safe summary: numeric HTTP status, closed response-class label, allowlisted
provider machine code or SHA256 of an unrecognized code, and SHA256 of an
available request-ID header. No response body, prose error message, filename,
user ID, file bytes, authorization or URL is copied to this new diagnostic.
JSON parsing is limited to4096 already-buffered response bytes; invalid,
non-JSON, oversized, deep and unusual Unicode content remain safe categories.
The original exception is re-raised; request, retry, timeout, storage path,
success result and required-file delivery behavior are unchanged.

The same actual upload400 control fails on original85 because the diagnostic
is absent, and passes after the change. Registered4groups pass, including safe
400/403/500 diagnostic payloads, success, cancellation and deterministic upsert.
Pinned2filecompile passes. Original status/body and exception class are
preserved through failure. No live upload, model, provider or database call was
used. Early mock transport fixture errors were corrected before causal RED.

Personally opened primary references: Codex codex-api/src/files.rs245–282
records status and provider error/request headers; OpenClaw
packages/ai/src/transports/openai-responses-debug.ts201–245,277–320 uses hashed
identifiers and structured diagnostics; Supabase storage-js errors.ts54–101
and fetch.ts61–90 separates service code from HTTP status and prose. Contrary:
Hermes agent_runtime_helpers.py1542–1557 includes raw response bodies in debug;
that practice is deliberately not adopted for this privacy boundary. Raw
Codex correlation headers are also hashed here. Unknown provider code hashes
support correlation, not semantic diagnosis of the original400.
