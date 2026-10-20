---
id: 2026-10-17-cleanup-diagnostic-pipe-misclassified-provider-failure
date: 2026-10-17
title: Cleanup diagnostic BrokenPipe was classified as provider release failure
surface: agents
component: owned-cloud-batch-finalization
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: _finalize_owned_cloud_batch placed diagnostic success print inside canonical provider cleanup exception scope
symptoms:
  - Errno 32 Broken pipe
  - Cloud cleanup failed
  - cloud_provider_cleanup receipt present with provider error
  - owned cloud evidence finalization failed
tags:
  - benchmark
  - cleanup
  - diagnostic-output
  - provider-receipt
  - verdict-preservation
sources:
  - commit a96f02ebd680950729df2cbce8cb7da6f4ba45f5
  - plan:.context/auth-deploy/repair-native-original30-a96f02e-20261017/interrupted-finalization-recovery/diagnostic-sink-owner
repro: agents/benchmarks/cloud_batch_cleanup_test.py::test_owned_cleanup_diagnostic_pipe_failure_preserves_provider_evidence
status: open
---

## Problem

The original a96 auth run had an interrupted finalization. Root's genuine saved
export reports28PASS2FAIL,32owned roots including two fixtures, and a failed normal
benchmark cleanup ACK. Controller exit and loss of its output pipe remain UNKNOWN;
no normal join or Results-saved marker is invented. Earlier29/1 card observations
are preliminary, not the final export.

Parent's exact magic-link evidence contains a canonical provider cleanup receipt
alongside provider Errno32Brokenpipe. Parent also reports an actual R2 archive read
bound to that root/task finalized historicalPASS while the final export isERROR.
These distinct records remain preserved: neither archive status nor this local fix
regrades the actual final28/2 export. This author did not query R2, parse the large
export or reconstruct a controller cause during the private owning experiment.

## Diagnosis

On exact sourcea96, `_finalize_owned_cloud_batch` awaits
`close_exact_root_sessions`, stores `logs.cloud_provider_cleanup`, then prints
“Verified cloud root provider cleanup” inside the same provider try. A diagnostic
BrokenPipeError is caught as a provider error, appends failure evidence and changes
`result.passed`/`benchmark_status` although the canonical cleanup receipt already
returned. An archive-warning print can also throw during error handling and abort
processing later roots. Output delivery and resource-release evidence are separate
owners; a failed sink must not supply or negate provider authority.

Two canonical archive searches were retained: `BrokenPipe provider cleanup
diagnostic print` and `stdout logging failure changes task verdict finalization`.
The initial working-archive search covered857cases and is retained as incomplete.
Both SAME searches were then repeated on the exact111260 archive of937cases.
All937 case bytes plus the canonical archive script were checked against immutable
Git blobs, establishing exact source coverage. The searches returned203 and139
matching cases respectively; no different same-boundary case was found. Related Solution/Human feedback were
read: October13 payment cleanup retains evaluator outcomes while compensation is a
separate owner; August3 SMS logging normalized optional fields so observability did
not throw. Neither is the same print-after-receipt exception boundary, so this is
a distinct OPEN case rather than an append to an unrelated auth incident. Both
related cases record no case-specific human feedback. The newly surfaced October15
sealed-generation cleanup case was also read through Solution/Human feedback: it
concerns stop-new-work after sealing and exact native custody, not stdout failure
after a completed provider receipt. It therefore does not supersede this new case.

## Solution

A private candidate on exact reviewed tree111260b2bb7444e27ce8e0beb479cfe55c29343b
adds a six-line local `emit_cleanup_diagnostic` function and replaces exactly two
finalizer print call sites (provider success and archive warning). It catches ONLY
BrokenPipeError and appends a per-root diagnostic warning. Actual provider,
delete/seal and payment errors remain errors; unrelated ValueError is not ignored.
No global builtins print override, output framework, runtime policy, task/schema,
model, evaluator, clock, timeout or cap changes are introduced.

The SAME real finalizer receives two roots with external boundaries mocked at their
existing seams. One original result isPASSED, the otherFAILED with its original
reason. The injected module-local output sink throws only after the valid exact
provider receipt or at the archive warning. Baseline exact final tests exit1 with
both roots falsely labelled provider errors; identical candidate tests exit0.
Both roots retain receipts, original verdicts and payment cleanup, and later roots
complete. Additional permanent controls retain genuine provider/payment errors and
unrelated ValueError failure. Existing deletion-seal, foreign/unknown/duplicate
custody and fixture controls remain exercised.

The new two `@async_case` tests live in cloud_batch_cleanup_test.py, automatically
registered by the existing benchmark.blackbox cloud_cleanup enumeration. All163
original test assertion AST occurrences remain,173now. Runtime's two original
assertions remain. Full necessary owner:44PASS0FAIL,4.35s,EXIT0. The full benchmark
domain was NOT run privately because it includes funded judges; no paid model,
provider, DB, native or production API call was authorized or made.

Exact command (same final tests before/after) uses the existing verification venv:
`agents/venv/bin/python <private-owner>/run.py`. Full necessary owner:
`agents/venv/bin/python <private-owner>/run.py --all`. The runner pins the physical
private benchmark module, reuses read-only dependency modules and denies nonowned
Python sockets/DNS; the whole owner uses an explicitly owned local HTTP test server.
No broad OS/browser egress guarantee is claimed. Full run includes an existing
intentional localhost39999 denial; network.json was overwritten by the final
selected run and reports that selected run's zero attempts only, not a full-run
attempt count. All setup attempts remain: first40PASS4setupFAIL lacked two private
scripts and owned-loopback admission; second43PASS1guardFAIL mishandled bytes
localhost in DNS. Exact immutable scripts and bytes decoding corrected only the
private setup; final44PASS is separate, not a relabel of earlier failures.

Important boundary: nested `finalize_archive_and_score_world_model` still prints
its trace archive message and may throw after R2 success before returning the ref.
This candidate does NOT guarantee archive-ref continuity or all stdout availability.
It prevents resource misclassification and next-root abort at the two selected
finalizer sinks. It does not establish why the original controller disappeared,
restore old failed ACKs, erase real provider failures, promote native outcomes or
prove whole-class elimination. Direct recovery archive without new WMH calls is a
separately root-owned operation, not part of this test candidate.

At10k roots the local change adds one small closure per finalized root and only
allocates a short warning when its diagnostic write breaks. It adds no external
request, persistence schema or periodic work. Existing warning-driven worker-log
capture remains bounded by its owner and may occur for this new warning. Diagnostic
warning storage and output failure are not evidence of resource success; only the
unchanged provider/payment owners supply that proof.

Private patch382d620064cff10c5a67c3cc22db547196cc63ac10d8e3b7cf98825de8ba6fe6
and proof954ed62e2b7cc4e99edfafcb25cc212deebfd02d35b0bff5ca5c729a0025a79e
bind exact code, logs and attempts. Parent scoped source review accepted this
mechanism. Status staysOPEN pending adoption and fresh source verification; no
native repair or deployment permission follows. Original28/2/failedACK and all
resource/archive records remain immutable.

## Human feedback

No new case-specific end-user feedback was recorded. Parent explicitly required a
local diagnostic sink catching only BrokenPipeError, real owning RED/GREEN,
preservation of actual provider/payment/unknown-root failures and original verdicts,
no global print wrapper or funded benchmark run, and truthful controller/archive
limitations. Parent coordination is not represented as a new human instruction.

## Reusable lesson

Classify failure at its owner: a diagnostic output exception after a canonical
resource receipt is an output-delivery failure, not proof the resource release
failed. Preserve the receipt and remaining cleanup while retaining the diagnostic
error separately and never masking genuine resource failures.


## Recurrence: history output can abort persistence after a successful write

A private adjacent owner check on immutable a96/9c33 found the same diagnostic
output class in BenchmarkRun._record_history. Its documented best-effort/per-task
contract is violated when the span-success print raises BrokenPipeError and the
error-warning print raises again, or when a real recorder failure is followed by
a broken warning sink. Local real save writes its JSON first but stops before
the second task and Hub caller. This is NOT evidence that the interrupted native
run encountered this exception: no retained native BrokenPipe trace exists, and
the original28PASS2FAIL/failedACK/unknown controller remain unchanged.

Two permanent functions are registered in benchmark.blackbox beside existing
fast/cold history controls. They use real BenchmarkRun.save/_record_history,
actual temporary attempt/pass JSONL and actual span-history writer. Only embedded
log parsing is substituted with a synthetic observation producer, and Hub upload
is a mock caller edge; no real Hub availability is proven. A module-local output
sink breaks only after history persistence. Unchanged selected command
`python3 .context/auth-deploy/results-history-diagnostic-review/run_selected.py`
observed2FAIL4PASS before production edit and6PASS after it. New healthy recorder
failure and unrelated sink ValueError controls preserve existing error semantics;
original fast-cache/cold-cache controls pass. Original assertion AST occurrences
are preserved. A first runner attempt replaced socket.socket itself before
unittest imports and caused4 setup TypeErrors; corrected connect/DNS denial
retains that attempt separately, not relabelled as owning RED. No full funded
benchmark domain, provider/model/API/DB/native call was made.

The private change adds a local BrokenPipeError-only diagnostic emitter and routes
seven history prints through it. Real recorder errors remain per-task best effort;
unrelated diagnostic exceptions are not suppressed. No global print wrapper,
result schema, verdict, task, model, evaluator, clock or cap changes. This protects
the history owner only: Hub or other diagnostic sinks may still fail, and the
change does not prove whole-run durability, native causality or native cure.

Both literal and behavioral archive searches were repeated against exact9c33
archive938, and this case's Solution/Human feedback was read. This is recorded as
an adjacent recurrence of diagnostic output interrupting an already owned effect,
not a new case. Status remainsOPEN pending adoption and source verification; no
deployment permission follows.

Final selected registration proof also executes the exact immutable BlackboxResult
class and the six actual r.record statements extracted from the owning registrar.
Only clear_captures is a no-op edge because no provider captures are used. Same
`python3 .context/auth-deploy/results-history-diagnostic-review/run_registered.py`
is baseline4PASS2FAIL and candidate6PASS0FAIL. This is selected owning coverage,
not a whole benchmark run or an actual Hub upload. A first private assembly AST
selector was too broad; assertion-preservation verification rejected it before
any final artifact was accepted. The selector was narrowed to exact new functions,
and final all2531 original assertion occurrences are preserved (2537now).
