---
id: 2026-10-06-fleet-live-mirror-kept-superseded-proxy-port
date: 2026-10-06
title: Fleet live mirror kept a superseded status proxy and delegated results skipped publication
surface: harness
component: cloud-fleet-live-outcome-publication
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-cloud background mirror retained its fork-time LOCAL_STATUS_PORT after the owning parent published a replacement
symptoms:
  - actual Hub API showed ten running outcomes while seven of those tasks had captured evaluated results and guest shutdown receipts
  - all eight independently captured stale mirrors kept their initial local proxy port after the owning parent rotated it
  - delegated task returned a graded result without the inner evaluation callback and its report card had no outcome signature
tags:
  - cloud-fleet
  - live-publication
  - proxy-rotation
  - evaluated-outcome
  - delegated-task
sources:
  - commit c214f5199646cb3bb51a81ef243df8ee01991536
  - plan:.context/independent-daily50-control-20261006/trial2-fe-upstream-stale-projection.safe.json
  - plan:.context/independent-daily50-control-20261006/trial2-fe-live-mirror-original-port-binding.safe.json
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_data_plane_mirror_reads_current_owner_port_before_publishing_evaluation
status: open
---

## Problem

The ordinary LIVE trial used fifty distinct DAILY tasks in one owned group,
`20261006-205741-10814`, on source c214 and its exact fetchable marker 1c557.
An independent normal authenticated Hub GET at UTC epoch 1791347861.217 returned
28 PASS, 12 FAIL and ten running rows, with lifecycle counts of 47 teardown and
three running. Seven Hub-running rows already had original captured terminal
cards, validated run records, child-finished and guest-shutdown receipts. These
were three evaluated PASS and four evaluated FAIL, not missing grades inferred
from root lifecycle. The original group timestamp remained
`2026-10-07T03:57:41+00:00`, and the API contained the same fifty distinct tasks.

The unchanged actual aggregation fragment reproduced the stale projection
offline at epoch 1791347928.307. By then eight original terminal cards existed,
three PASS and five FAIL, but the aggregator still read their older running
`cloudbench-live/report-card.json`. Original bytes, hashes, API responses,
ownership correlations and the source fragment are retained privately. No live
source, task, resource or provider state was changed. Whole-run final aggregation
later published 31 PASS and 19 FAIL naturally; that does not repair the earlier
live publication gap or authorize native-release credit.

## Diagnosis

The normal path is `evaluated callback -> guest report card -> current owned
status proxy -> host live mirror -> fleet aggregation -> original Hub group ->
exact guest outcome ACK`, independently of browser, service and native cleanup.

All eight affected mirrors retained initial ports ending in 51 while their
owning parents had atomically published replacement ports ending in 52. Five
last live cards were written near epoch 1791346903, before their proxy pointers
were republished near 1791346916. Three others stopped near 1791347274–7284,
before pointer publications near 1791347288–7289. The mirror is a forked shell
loop; its inherited `LOCAL_STATUS_PORT` never changes when the parent restarts
the proxy. The parent, collector, ACK sender and barrier can consume the new
pointer while that mirror silently polls the old port.

Seven affected signed original drivers recorded the existing outcome-ACK
unavailable warning and no successful outcome ACK. Their emit/write warning
counts were zero. Six original cards in the earlier seven-row snapshot carried
signatures that recomputed exactly against their original task, root agent,
run token and Machine owner; ACTIVE and PAUSED root states did not change the
captured benchmark grades. The later hotel row also carried its exact signature.
The remaining delegated minted-account result had no signature and no ACK-wait
message: its delegate returned without the inner callback, while the owning
`_run_reported_task` wrapper simply returned that result. This is a second
publication ingress gap, not an invented task failure.

Archive searches used "terminal archives populated live stale" and
"evaluated teardown outcome callback". The September 9 terminal-artifact
split-source case is a relative: it repairs complete owner EXIT projection,
which correctly published this trial's final results, but does not repair a
forked live mirror or a delegate missing the inner evaluation callback. The
terminal-group badge case is another consumer relative; no badge or group
identity change is needed here. Proxy replacement itself remains a supported
transport recovery. No cause is assigned to the original transport disruption.

## Solution

The boot-launch mirror reads the existing current-owner `status-proxy.port`
on each observation, retaining the existing exact task-count and task-name
validation. Unknown, malformed or symlinked pointers cannot fall back to an
old inherited port. Before publishing a fetched card it checks the pointer
again, discarding an old proxy response that arrived after replacement. Legacy
SSH mirroring is unchanged. No process kill, sealed-bundle polling, new receipt,
release latch, model call or source-provider request is added.

The admitted wrapper invokes its existing evaluation callback on a returned
graded result only when that occurrence has not already been evaluated. An
already delivered callback is preserved, even if cleanup returns a different
result; the return object, exception and cancellation behavior remain unchanged.
The same original callback prepares the exact packet for a nonempty root,
forces the card and waits for the existing best-effort ACK. A credential-SKIPPED
result that never created an agent retains its actual SKIPPED grade and card
without inventing an agent packet or acknowledgment. The sixty-second warning
for real agent packets remains unchanged and never becomes a task rejection or
permission to retain owned resources.

The permanent mirror control executes the actual shell mirror against two local
HTTP owners. It covers rotated PASS and FAIL, a response arriving after pointer
replacement, foreign-task and partial-JSON refusals, and an absent current
pointer. The permanent wrapper control compiles the actual nested function and
coordinator execution/finally block. All rooted cases use the contract-present
normal packet preparation helper and verify the original parent, token, Machine,
root, grade and signature before the actual owning batch-finalizer call. It covers
delegated PASS/FAIL, an already evaluated callback with a different returned
result, cancellation, an ordinary exception and the actual empty-agent credential
SKIPPED result. Existing actual fleet-to-Hub group/timestamp publication, rotated
barrier and before-agent/phone-cleanup controls remain part of qualification.

The exact final fifteen-control command was run with identical test bytes
on unchanged c214 and the private candidate. Original: seven FAIL, eight PASS,
exit 1 in 10.084 seconds. Candidate: fifteen PASS, exit 0 in 7.819 seconds.
Both native pytest owners (PIDs 42201 and 43830, with observed births) were
absent after their exits, and all local HTTP server threads were closed. The
full command, timestamps, source/test hashes and private logs are sealed in
`outcome-projection-c214.private/frozen-final15-owning-{original,candidate}.safe.json`.

Both new families are in the existing Cloud Benchmark Lifecycle suite. The
normal compact deploy selector explicitly includes them and the existing
fleet publication owner; no new framework or paid gate is introduced.
At 10,000 tasks the mirror still performs one existing bounded request per
owned child per cadence, adding two tiny local pointer reads. The wrapper adds
one dictionary membership check and at most one already-supported callback.
There is no additional central channel, large-bundle rehash or per-root provider
fan-in. The packed recipe changes only the existing run-bench-cloud input; its
exact standalone source fingerprint has 38 unchanged inputs and this one changed
input. The combined integration recipe must be recomputed and independently
reviewed before its exact entry is committed to the existing two pre-service
phases. This private candidate adds no policy entry or phase; no phase expansion
is needed.

## Human feedback

The user requires genuine evaluated outcomes before teardown, the original
single fifty-task group and timestamps, unchanged task grading, and full native
release. Root required original captured grade/owner evidence, actual owning
RED/GREEN, an already-callback inverse and a superseded-response inverse. Root
explicitly prohibited an aggressive ACK timer, new grading gate, late-result
fabrication and active-trial changes. Private source qualification and review
do not claim deployed behavior, task success or LIVE acceptance. This case stays
open pending final qualified-source deployment and ordinary live observation.

## Reusable lesson

Forked observers must consume the owner's current transport pointer; every
admitted completed occurrence must enter the existing evaluated-result path once.
