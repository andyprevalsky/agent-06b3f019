---
id: 2026-10-17-closed-capacity-failure-had-no-admission-recovery
date: 2026-10-17
title: Closed capacity failure could not use the existing admission recovery path
surface: infra
component: original600-reservation-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the incomplete admission reader accepts its historical ENOSPC case but not a fully joined capacity-shortfall admission with closed reservation and observation records
symptoms:
  - fresh capacity after reserved native readback is insufficient
  - no controller or task launched
tags:
  - cloudbench
  - admission
  - recovery
sources:
  - commit 49b792dcc2ea983325c6a25801da6c982f29c206
  - commit c9d4817832720cc2b1bc6a212383973a77baf004
  - fleet run original600-1792279176545861179
  - fleet run original600-1792271666901142356
repro: python3 scripts/tests/cloudbench-incomplete-reservations.test.py
status: fixed
---

## Problem

Original74 completed its initial reservation pass with 501 confirmed and 50 held rows. The existing positive-ACK observer recovered 27 more, yielding 528 confirmed and 23 held. The fresh organization snapshot allowed 51 new objects but the original600 request required 73. The capacity guard correctly refused to create a controller. The public recovery path accepted an earlier unclosed ENOSPC journal shape and could not consume this closed capacity-shortfall shape.

## Diagnosis

The retained 533-member packet is SHA256 7fd4d2d31601c0e74499cfabf48e0c47cc704bc95d51a239ecd7d39ac369e410. All 530 mapped original files were verified. Eleven failures happened during the first leased GET: no config POST or config-dispatch artifact exists. Twelve have one uncertain config request, eleven recorded HTTP499 responses and one missing response. Their saved native versions/configurations match the prior state. None of those facts alone grants current capacity credit or proves the uncertain requests had no effect.

The provider/network causes of the read failures and uncertain responses remain unproven. This change addresses the missing recovery state, not those upstream causes. Original errors, old requests, old observation records, and the 90-minute admission clock must remain unchanged.

## Solution

Extend the existing incomplete-admission mechanism with an exact closed-capacity-failure proof. Carry the 528 confirmed rows unchanged. Classify only the 23 held IDs. Any new configuration attempt uses a new private journal and a fresh lease, verifies the exact prior native version/configuration, and performs a version-fenced update. A competing late old update must make the new attempt fail or remain held. No old configuration request is replayed with its old nonce, and no uncertain old response is relabeled as an ACK.

The normal fresh capacity check and controller launch remain after verified recovery. The original task set, concurrency, deadlines, exclusions and protected resources remain unchanged. Seven incomplete-admission controls, five recovered-reader controls, and the focused public-CLI continuation control pass. The same valid capacity-failure fixture is rejected by the old public planner and accepted by the new planner. Controls also reject altered carried rows and late old-CAS winners, and validate the full recovered archive and dependency bindings. The exact69aa live continuation then verified all23 new reservations, retained the528 original confirmations and returned551 rows with zero holds. The original 90-minute clock and all prior failures were preserved. This closes the admission-recovery defect; it does not certify the later controller launch or task outcomes.

## Human feedback

The user asked to simplify startup and explain the repeated failure to reach full parallel execution. Preserve all 600 tasks and original timing limits while making this recovery an explicit state of the existing admission path.

## Reusable lesson

A closed partial admission needs an explicit state transition into the same recovery mechanism. Preserve the old operation history while obtaining fresh proof for any newly credited state.

## Original77 recurrence

Original77 on `c9d4817832720cc2b1bc6a212383973a77baf004` closed its initial reservation pass with 542 confirmed and eight held rows. The normal acknowledgment observer added five, leaving 547 confirmed and three held. The fresh capacity guard refused launch before any controller or task was created. The same recovery planner recognized the earlier 49 and75 source families but rejected this later source before classifying the otherwise supported closed admission.

The 209-member selected evidence packet is SHA256 `45809e6aaf4fae8da12d855fb57707483509975e6c8071593333ee268449ddff`. Two rows have one uncertain configuration write each (HTTP499 and missing response); saved stopped native records retain their prior exact instance/configuration. These are historical eligibility evidence only. A fresh lease and prior-version read must precede any new version-fenced configuration write. The third row has a positive HTTP200 acknowledgment, but its saved native observation still has the old version/configuration in replacing state. It is eligible only for fresh leased read reconciliation against the acknowledged identity, with no second configuration write. The original 547 confirmations, all uncertain writes and the original 23:19:36.5459259 UTC epoch remain unchanged.

The bounded repair adds the exact c9 source family to the existing planner and recovered-history consumer. The public CLI and native-effect implementations stay unchanged. The consumer binds the new planner and existing CLI bytes, all other original c9 dependency bytes and its existing observation helper closure. This is not current capacity credit; the complete plan still needs validation on the executor's original files, and execution still requires fresh native proof and the unchanged final capacity guard.

Nine incomplete-admission owners, ten recovered-reader owners and the unchanged public-CLI owner pass. The same valid capacity-failure fixture is rejected by the original c9 planner and accepted by the extended planner. Existing late-old-CAS conflict and acknowledgment-only read controls remain passing. The selected three-row calibration grants zero live capacity credit; the full original plan and any native recovery remain executor checks.

### Full-history validation follow-up

The actual zero-provider full-plan check on the first extension (`2477583b27e84d1213c099718528b29d1e7a3bb8`, session18487) then exposed a second reader defect: `I.closed_plan` rejected the retained `8edd224c74d478` observer directory as an unknown namespace. The canonical observer creates that directory after proving the old positive acknowledgment but before its leased read. When the read differs from the acknowledgment, the observer deliberately retains its wire records and adds a failure diagnostic. The reader admitted only successful added IDs. Its previous fixture did not include a failure after directory creation.

The correction must accept only a diagnostic-bound, still-held original ID, parse its canonical read/lease wire namespace, reject any configuration write or foreign ID, and bind every retained file into the immutable plan. It must not credit the failed observation, remove its directory, or weaken successful-observation validation. Ten incomplete-admission owners and ten recovered-reader owners pass. The causal owner runs the canonical reservation producer and observer, proves the original 247 reader rejects their failed-read output, and verifies the corrected full planner accepts it without adding a reservation. Raw tampering, hidden configuration writes, foreign artifacts and missing diagnostics are rejected. The actual 18 failed-observation files are hash-bound during local calibration. The executor's repeated full-plan check and native continuation remain pending.
