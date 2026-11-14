---
id: 2026-10-28-it9-r23-bu025-r2-unresolved-screenshot
date: 2026-10-28
title: It9 BU025 r2 returned an unresolved screenshot after failed upload and rejected extraction
surface: cross
component: browser-session-file-delivery
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Latest screenshot upload failed; verifier assumed old session path was replaced; backend file-path guard subsequently rejected the listed Steel path
symptoms:
  - 'Failed to upload file screenshot.png: '
  - 'Invalid session file path'
  - '[Extract] Extracted 0/1 files'
  - 'Could not find matching file for partial pointer'
tags:
  - polar
  - bu025
  - screenshot
  - file-pointer
  - steel
sources:
  - commit 339894f88c95837c608b74c7a394ebc6fd338c6f
  - agent cc8a6e87-5b78-4323-813b-45a30db953c7
  - fleet run 20261028-080447-19705
repro: back-end/src/tests/blackbox/browser-session-file-carrier.blackbox.ts; offline original request/resolver evidence in .context/rca-r23; no fixed-task outcome claimed
status: open
---

## Problem

Primary scope is It9 BU025 r2/job r002-j0040, not r1/R14. Both runs failed;
there is no same-It9 PASS sibling. The original task asks for titles, metascores,
and critic-review counts for TV shows scoring below 60 with at least 10 reviews.
It does not prescribe 944 rows or a screenshot. The response-schema model chose
a required `qualifying_tv_shows_file` file pointer. The recorded task completed
but failed the declared judge (1/3, C2/C3 failures), infra false. No regrade.

Original normal archive SHA256 is
`8f33f0abbad44d9b569d97456050ab80aa863c114104b683ec96275b4ad6aad0`;
run JSON `4443b945052160d0f715071a0d87c75d5aa19eb7d4b4398f036f268b6eab8fea`;
worker log `ddc0e033b19ea4824386d7682071778eb4492a9899e2b52c6d3e15f3454a45ad`.
Execution provenance records source339894 and workspace patch `none`.

## Diagnosis

The raw sequence separates three boundaries:

1. At step61, the worker saved `/files/screenshot.png` (101650 bytes) at
   08:35:42.604131Z. Steps62/63 then rendered and sized the collected list.
   Step64 captured 659987 bytes, but its upload logged `Failed to upload file
   screenshot.png:` at08:38:24.136104Z. No exception detail was retained there.
   `_execute_screenshot` returns success plus fallback `screenshot.png` even
   when upload returns None. This proves a capture/upload distinction, not why
   the upload failed or what any image contains.
2. Final verifier request `5a9baee3a519`, SHA256
   `00c88a9393bd3ff727da72c69314e772789d2fa3b438f51d2168ed66440bbd37`,
   still lists `/files/screenshot.png (101650 bytes)`. Its output explicitly
   **assumes** step64 overwrote that path, assigns score1, and returns it.
   Offline canonical TOOL_RESULT projection equals all four actual verifier
   requests (24/20/15/17 receipts; 71790/91455/74032/76126 chars). Thus this
   finding is not inferred R11 receipt starvation. Raw context and actual
   requests are retained, not reconstructed model behavior.
3. Completion extraction at08:39:21.247144Z receives HTTP400 `Invalid session
   file path` for `/files/screenshot.png`, then extracts0/1. Executed backend
   `service.file-path.ts` allows `/tmp/downloads/`, `/tmp/rose-uploads/`, and
   `/home/oai/share/`, but excludes `/files/`. `service.ts::downloadFile` applies
   that guard before `readSessionFile`; the Steel adapter in `sessionIo.ts`
   explicitly supports `/files/` and strips its prefix. Offline execution of
   the unchanged TypeScript validator rejects this actual path and accepts
   the existing allowed roots; traversal and `/etc/passwd` remain rejected.
   This is a concrete producer/consumer path mismatch, independent of whether
   the older screenshot would satisfy the task.

After extraction, the handler separately uploads `screenshot_final.png`
(503889 bytes, pointer ID4e412d73-a650-492c-a49c-6857160814a0). This is the only
recorded completion attachment. The filename resolver finds no matching
`screenshot.png`, logs the miss, and preserves the partial pointer unchanged.
Replay using the actual response/schema/attachment reproduces that unresolved
result. The generic `Resolved file pointers` log does not prove resolution.

All three original judge request bodies are retained. C2/C3 receive the action
sizes, session-file history, final response and distinct final attachment.
C2 rejects the pointer-only deliverable; C3 rejects its unverified completeness
claim. Judge claims about image content remain judge testimony: no image was
opened in this investigation. The observed mismatch is sufficient without
asserting the unseen screenshot's contents.

Two archive searches followed this trace: `screenshot pointer`, `file unresolved`.
The disabled-code-verifier schema case teaches that an arbitrary attachment
cannot satisfy a particular file field; the mid-run-download case concerns an
actor observation gap. Neither proves this incident's exact cause or a safe
repair. Late actor requests30–59 were skipped for payload size; their complete
encoded inputs are unavailable. That limits actor-choice attribution, not the
captured verifier, extraction, and resolver evidence above.

## Solution

The carrier mismatch has a bounded repair on fresh qualified base
846862883105d0135f24ee07e5348cd209e8a157. Path validation now runs inside
`readSessionFile`, using the same stored provider value as dispatch. Only Steel
may use `/files/`; the pre-existing safe roots and traversal/NUL restrictions
remain. The domain still checks ownership first and preserves the existing
HTTP400 error identity. No second provider lookup, alias or fallback is added.

The permanent auto-discovered blackbox executes the actual route, service,
validator and provider adapter with inert bytes. It fails on the unchanged
baseline with400 instead of200 before a native read; the same control passes
on the candidate. Controls preserve wrong-owner/missing-session rejection,
empty/unsafe paths, non-Steel rejection, native404 propagation, exact URL
encoding and existing Kernel roots. The extracted pure metadata builder and
private-state predicate retain their values and exports; they were moved only
to satisfy the edited service's mandatory line-count limit. All six edited
files pass lint; the author's full backend typecheck passes. Reviewer checked
the exact six-file patch cddcd923d17611fd3bab9063ed0a432dd57dfecd537d4cde6b620dca3ec72e6f
and reported ordinary code/security PASS (manual Golden scope not applicable).
Its environment had identical baseline/candidate missing-global diagnostics;
that is not presented as a passing reviewer typecheck.

This fixes transport admission only. It does not repair the failed latest
screenshot upload, establish any screenshot's contents, or validate the
verifier's stale-file assumption. Original C2/C3 FAIL remains unchanged; full
case status is OPEN until unchanged real-task evidence establishes an outcome.
No retry, timeout, criteria, schema or prompt change was made. No live provider,
model, browser or DB operation was used. The earlier Steel collateral suite
exited0 but had DB attempts blocked by the repo guard; it is not counted as a
clean gate and was not rerun. Local evidence is in `.context/rca-r23/`, with
pinned patch, manifests and original verifier/resolver comparisons. Investigation
token usage is UNMETERED.

## Human feedback

Parent required r2-specific evidence, preservation of the original FAIL and no
assumed R14/R17 recurrence; prohibited viewing images and contacting the owner.
Those restrictions were observed. R1 is not used as a successful control.

## Reusable lesson

Capture success, session-file persistence, and delivered attachment identity are
separate facts; neither a repeated basename nor a generic resolution log proves
that the returned file pointer names the latest captured artifact.
