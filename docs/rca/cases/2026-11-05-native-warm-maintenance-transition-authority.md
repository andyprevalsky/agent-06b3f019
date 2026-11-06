---
id: 2026-11-05-native-warm-maintenance-transition-authority
date: 2026-11-05
title: Native image activation had no before-and-after authority for retained isolation
surface: harness
component: cloudbench-maintenance
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Native setup changed warm image and incarnation without producing a transition receipt consumable by pinned isolated admission
symptoms:
  - current shared partition changed; native maintenance authority required
  - round16 warm identity/state changed
  - legitimate published image activation cannot retain the old pinned partition unchanged
tags:
  - cloudbench
  - maintenance
  - native-ownership
  - retained-debt
  - image-reuse
sources:
  - commit 460e026e0f08d2ab65cbac836084c972eab3b021
  - commit 21945a032b2c3e858e97ce0982ef8eb917957c49
repro: scripts/tests/cloudbench-maintenance-authority.test.py NativeTransition Quiescence
status: open
---

## Problem

Round21's matching immutable image was published in one 264-second native build from clean source460e. It has not been activated. Existing native image-activate delegates to setup, stages environment secrets, updates owned machines, prepares/starts the warm donor, performs native clone/fetch and parks it. Existing isolated admission rightly rejects a changed warm incarnation/config against its original pins. A build receipt proves publication, not a current ownership transition. Replacing historical pins would erase evidence rather than authorize maintenance.

## Diagnosis

Gate: NOT_INTRODUCED — frozen460e's round16/19 observers already require exact original warm id, instance, stopped state and config hash. The reviewed21945 repair preserves that refusal. Code comparison and the unchanged original nested match predicate demonstrate the boundary. This classification does not release the assigned blocker or waive the required deploy validation.

Archive search for maintenance/pinned warm/configuration transition identified existing maintenance-env/lock incidents and warm patch/fingerprint authority, but no existing producer/consumer bridge. The exact original match rejects a synthetic new image/config and incarnation. A local native shell harness using the actual extracted maintenance functions, original script descriptor, real app PID lease and real cycle flock records intent before a synthetic provider transition. The consumer then accepts only the recorded positive transition; all HTTP is stubbed and socket connections are blocked in this harness. Synthetic old-debt grants in this harness are explicit; they do not manufacture production provenance. The separate cycle suite exercises the unchanged seven-debt and clean-successor contracts.

Independent draft review reproduced two owning defects. Quiescence named cloudbench-campaign.py instead of the actual run-bench-campaign.py and broadly exempted ancestors. The permanent synthetic process control now rejects that entrypoint and fleet/other setup processes, even among ancestors; only the previously verified native setup parent can be exempt. Secondly, raw native exit0 was counted as a successful transition even when config validation rejected. Result records now retain raw native_exit separately from qualified. Both nonzero exits and invalid-zero attempts stay recorded; a fresh, independently qualified new nonce can follow without deleting failed history. An unfinished intent remains blocking.

The first harness draft patched the imported module rather than its __main__ HTTP function. Three read-only GETs to synthetic nonexistent machine IDs reached the provider and returned404; no mutation was performed. This error log is preserved, and the harness now stubs urllib directly and prohibits socket connections. System Python lacked pytest, and a first venv invocation used the wrong relative file path; both environment failures are retained separately from the actual98-pass image CLI result. The worker suite's sole error is the already reviewed missing26a664 fixture repair (KeyError patch), absent from this preserved21945-based branch, not a new worker/runtime repair.

## Solution

Opt-in setup capture uses the original app lease, not a second app-lock wrapper. The native shell also holds the coordinator's existing nonblocking cycle flock throughout capture. Before any setup mutation, the helper verifies the actual parent PID/start, bash script descriptor and committed source, exact requested ref, current failed-cycle source, all existing native debt admission, original warm pins and exclusive native process guards. It records a fresh nonce, original intent and its digest in the original coordinator state before proceeding. The consumer requires these original state anchors and result digests; an orphan registry file cannot grant authority.

This first reusable contract intentionally supports only the existing stopped warm singleton with an absent/empty declared pool. Every batch of native targets is checked. Pool, omitted/extra targets and changed inventory require separate ownership authority; they are never ignored. Final authority permits exactly the published immutable image and the existing default parked shared1CPU/2048MiB shape with sleep infinity. All other config, environment/file content hashes, retained mounts/volumes and foreign machine inventory must remain unchanged. Native setup's existing secret-staging behavior is preserved. Receipts persist hashes instead of config env/file contents. The original native exit is retained even if verification fails. Successful qualification requires final stopped GET/volume evidence bracketed by identical GETs and fresh process guards. Admission repeats current native GET/process/Hub/resource checks and every original static/local debt validation. No old proof, pin, cleanup flag, task assertion or clean_isolated_successor implementation changes.

Image reuse is not HEAD equality. A versioned, explicit recipe-input closure compares clean recorded build source to the current producer source, including Docker recipe/config, ignore policy, installer helpers, manifests/locks, frontend verification/postinstall inputs, Prisma and vendored wheels. Unknown recipe semantics or changed/uncommitted inputs fail closed. The immutable old image's source and timing remain unchanged; the new runtime code still requires the normal full sealed workspace patch. This does not claim a new image build or dependency snapshot qualification.

The new owning suite is registered in scripts/test.sh, the structural GATES registry and deploy Step4s. It covers original-pin rejection/native capture acceptance; parent/lease/source/nonce/debt/config/volume/target refusals; no orphan receipt authority; failed17 and invalid-zero followed by a fresh successful nonce; and reused old image inputs versus changed dependencies/unknown recipe. Final exact commands, logs and hashes are recorded in the maintenance repair report. Status remains open pending independent final review, real authorized native maintenance and full deployment validation. No live activation/retry/provider mutation was performed here.

## Human feedback

The user required preserving independently reviewed21945, isolated work only, no new agent/worktree, no old pin/debt rewrites and no provider mutation, money/DB/Freedom or Kernel actions. The parent required first executable native controls, explicit reuse of the published460e image using input equivalence, authentic before/after process/lease capture, preserved failed attempts, exact actual campaign entrypoint exclusion and structural registry registration. The parent owns integration, mutation authorization and complete final gates.

## Reusable lesson

A legitimate maintenance change needs its own original native before/after authority. A published image, changed config, empty process inventory, successful shell exit or operator assertion cannot replace that authority or settle historical obligations.


## Recurrence — prospective capture required the state it was meant to replace (2026-11-06)

Gate: INTRODUCED by the f7d482 native maintenance bridge. Its begin function reused complete isolated admission and then required the historical warm incarnation/config before recording any new generation. Source4bd retained that implementation. After the original native setup exited0 but qualification correctly failed on changed foreign inventory, a later legitimate image owner changed the warm incarnation. The bridge could no longer record another attempt, even though the cycle still owned the same exact Machine/name/mounts/nonimage config. Earlier strict guest admission was correct; reusing it as the prerequisite for prospective setup was the first bad boundary.

The original native failed intent/result remain unchanged. Received peer native artifacts identify the foreign82d1 cleanup controller and current image's producer, but do not supply a missing historical after-receipt or turn our failed transition into success. Archive searches for `original warm pin changed before mutation` and `maintenance prospective retained admission` found this existing case: this is a recurrence of the same producer/consumer boundary, not a new incident.

The unchanged new owning control fails when only begin is reverted to its original implementation, emitting `original warm pin changed before mutation`; it passes with the new native observer path. The fixture runs real bash parent incarnation/script descriptor/app PID lease/cycle flock and forbids provider mutations/network sockets. An actual seven-debt cycle COPY also refreshes from4bd to d58 through the unchanged native refresh function, retaining all598 original failures, all7 debts and every old native record; it lands in quick with next_after_quick=needs-focused-plan. No phase or quick PASS was fabricated. Historical-only replay then validates all seven shapes and their complete ancestry while returning no admission/source coverage.

The candidate separates a prospective native operation from final isolated admission. Only a changed guest pin selects this path, and it requires a sealed original native intent bound to the original pinned resource plus unchanged historical file/process/socket/resource proofs. Native GET/GET under the actual setup lease must show the same stopped Machine/name/mounts/nonimage config, a nonempty incarnation and sleep-infinity command. No peer packet, archive, caller boolean, new donor or fixed resource allowlist grants authority. A first draft treated an internally consistent received tar as authenticated authority; independent review fabricated one successfully. That rejected draft and failure evidence are retained. The packet interface/helper were removed rather than blessing fabricated records with more hashes.

Setup uses skip-start env/image updates and resize. A new native prestart observation after those operations, before require_machine_ready, verifies the exact intended immutable image/digest, original build/source/input closure, native PID/lease/state/source seal, retained volumes and unchanged foreign inventory. A CLI0 stale image fails before the fixture's first-start marker. The immutable prestart record is sealed into the new result and required again by the consumer. Finish still verifies the complete foreign inventory, final stopped target, parked shape, retained volume, original native exit and source. Failed records remain false-qualified; old debts, Hub pins, cleanup and task-credit flags are untouched. The previous pinned-generation behavior and assertions remain intact.

Status remains open pending independent review, combined-source validation, genuine authorized native setup and full cloud gate. The matching d58 image build is only publication evidence; no live activation/provider write/cloud retry was performed during this repair. Human feedback required removing invented archive authority, adding positive image verification before the first guest start, preserving all failure history and proving the refresh entry path without manufacturing quick results.

Independent review also replaced the prestart file after capture and obtained false qualification in the draft. The correction anchors the in-memory prestart digest into the original cycle pointer before the first start is permitted; finish and the consumer require that same prior digest. The unchanged reviewer control now returns native1, qualifiedfalse and refuses admission, with the old failed record unchanged. The permanent deterministic replacement control preserves raw native_exit0 and rejects qualification. Read-only file mode alone is explicitly insufficient.

End-to-end source refresh exposed a second circular prerequisite: the generic debt candidate retained its original validation_source, so even a new qualified native maintenance generation could not reach isolated admission on the refreshed source. The consumer now obtains coverage only by fully validating the new current-source native maintenance record, without changing any old labels. A later clean PASS or clean FAIL uses unchanged clean_isolated_successor; owned/incomplete/cancelled successors still refuse. The added source-coverage regression was executed red (native successor current source) and green through isolated_admissions and isolated_request. Historical-only mode also validates any later clean successor execution before auditing old ancestry, so it cannot hide a newly unresolved owner.
