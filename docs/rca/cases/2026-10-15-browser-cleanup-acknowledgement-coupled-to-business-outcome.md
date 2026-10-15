---
id: 2026-10-15-browser-cleanup-acknowledgement-coupled-to-business-outcome
date: 2026-10-15
title: Browser cleanup acknowledgement was missing and its failure was coupled to business outcome
surface: agents
component: spawn-browser-agent-v3-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: close_browser_session awaited an HTTP response without inspecting status, so callers proceeded after an explicitly failed cleanup request
symptoms:
  - Steel browser lifecycle is already in progress for task
  - HTTP500 close returned None unexamined
  - FINISHED Browser Session Closed after failed cleanup
  - Successful task or auth refusal replaced by BrowserSessionCloseError
tags:
  - browser-cleanup
  - lifecycle-claim
  - business-outcome
  - cancellation
sources:
  - commit 897bf3a80e77ab0dc54aa288495939e3f3b2561b
  - commit d6acc0df6f453b5daaf1c3b751c1db77c839bf3f
  - commit 455698cb9adbf76dfeb72ee8850c8357abfaea60
  - plan:.context/option-a-corrected-contract-three-way.json
  - plan:.context/combined-nested-sealed-replay.json
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_browser_cleanup_failures_are_explicit_at_actual_caller_boundaries
status: open
---

## Problem

Review finding4277623266 identified a close-versus-replacement claim race at exact897. An owning offline lifecycle replay held actual replacement creation while real close/pause calls both rejected at the task claim; replacement then published ACTIVE. The backend reported failure, not an accepted close intent. The Python helper nevertheless returned None without examining HTTP500. Cancellation could then emit FINISHED; background cleanup could also claim Browser Session Closed. No production leak, duplicate purchase or native sealed-generation incident was observed or asserted by this review.

## Diagnosis

The first incorrect boundary is the caller treating transport completion as cleanup acknowledgement. Terminal-agent reconciliation independently retries ACTIVE/PAUSED/ERROR rows only for terminal agents, so this is not universal cleanup loss; nonterminal task completion/pause is outside that guarantee. Missing-row arbitrary native release would violate exact custody and was rejected.

An initial private candidate d6acc propagated cleanup failure into general task failure, which was a second defect: verified goal success or an explicit auth refusal could be lost after business work had already finished. Its exception-expecting controls encoded an invalid desired contract and are preserved as rejected evidence, not proof of a correct fix. Later full-activity controls also exposed a verifier catch retrying after cleanup failure and a background exception fallback overwriting ERROR with FINISHED.

Two archive searches covered Steel browser lifecycle already in progress close session and terminal browser cleanup concurrent rotation close claim. October14 Steel profile writer-release cases define relevant custody invariants; terminal archive cases are relatives only. None establishes recurrence of this exact acknowledgement/business coupling.

## Solution

Prepared in an isolated review preview, not approved for deployment: inspect the exact-ID close response and propagate factual typed cleanup failure. One activity-local capture boundary records cleanup failure separately for all five callers while preserving completed goal, declined-auth refusal, cancellation, maxstep and original-error semantics. Main and fallback FE-only resource terminals retain ERROR plus the exact failure receipt. Keep one existing10s request, no successor retarget, no new API authority/durable intent or native404 change. Request cancellation preserves cancellation and unacknowledged resource state without a duplicate attempt. Plain409 is not invented generation sealing; preserve only actually thrown sealed exceptions.

The same corrected full-activity control fails on897 (missing failure visibility), fails on rejected d6acc (business outcome flip), and passes on the private correction:16 actual body/finally/background scenarios including HTTP200/500 business equality, fallback failures, ordinary lookup fallback and request cancellation. Direct helper12 phase controls pass with a hard network guard. A memory-only combined snapshot with the independent OTP local_only patch passes three genuine sealed-exception controls; this is not standalone sealed safety or adoption. Previously admitted realtime messages may flush later; payload hashes bind them to preseal entries, with zero new enqueue/terminal/native effects. No global foreign-queue cancellation.

Exact source hashes and complete proposed diff are in .context/option-a-final-checkpoint.json and option-a-complete.patch. The close-only checkpoint prompt and trajectory guards passed; its behavior guard remained exit1. The combined preview uses the corrected handler-watching behavior guard and requires exact human classification. Neither test success nor the earlier AUTH-OTP-1 eleven-line approval authorizes these additional stop semantics. Combined integration, lint/full gates, source adoption and deployment remain open.

## Human feedback

Parent chose failed API close with honest unresolved cleanup, not a queued durable-close promise or new successor authority. Parent rejected erasing verified success/refusal on cleanup failure and required business/resource separation. Parent required actual full-activity/finally tests, positive controls, fallback failure injection, plain409 versus genuinely thrown sealed distinction, and preservation of original cancellation/error behavior. Parent prohibited timeout/retry-budget changes and approval overrides. The corrected case does not claim a production incident from injected sealed exceptions.

## Reusable lesson

Acknowledge resource cleanup explicitly while preserving independently completed business outcomes and exact resource custody.


## Review-preview qualification

The combined preview preserves the corrected business/resource contract. Its activity result includes browser_cleanup, but the existing manager projection initially dropped that field. Parent authorized a minimal factual receipt-forwarding correction at the existing manager metadata boundaries. The same registered six-path actual-manager control (success/refusal/cancellation, each with and without cleanup failure) fails on exact455698cb9adbf76dfeb72ee8850c8357abfaea60 with KeyError browser_cleanup and passes on the preview. It uses the native ToolEvent serializer, preserves business statuses/messages and starts one activity per case; hard network attempts are zero. The command is agents/venv/bin/python .context/manager-receipt-owning.py, with the baseline using the preserved exact455 source overlay. Logs are manager-exact455-before.log and manager-final-after.log. Final immutable combined verification and approval remain required. This proves manager event metadata forwarding, not a default UI warning, parent-model consumption or guaranteed provider closure. Native resource shutdown, production rollout and the three current auth-choice benchmark failures remain separate and unverified by these offline controls.


### Golden-reference qualification

Parent independently read OpenClaw src/infra/outbound/delivery-queue-recovery.ts:833-859, separating post-send finalization failure and unknown-after-send from proven omission. Hermes tools/browser_tool_lifecycle.py:713-742 logs close failure and releases local resources; it does not prove durable remote closure. These are architectural analogies for preserving business outcomes while reporting cleanup uncertainty, not provider shutdown proof.


The adjacent cancellation and Task Failed completion writers now preserve a genuine typed native seal through their existing best-effort context. Actual full-activity HTTP409/ordinary500 controls cover both. Ordinary business error/cancellation behavior is preserved; a dead generation's stop signal remains authoritative. See the separate sealed-owned-cleanup case for exact before/intermediate/after evidence.


## Approved snapshot and first full-gate test corrections — 2026-10-15

The user conditionally approved sound, general corrections, and the coordinating parent accepted AUTH-STABILIZE-1 exact942d4bce98c9e6cfd0c2f8270bf0533a7fb5c86a at2026-10-15T21:43:48.470892Z. Final source b5475e5be1f98e48e709298c0afcd2ea2e550ce7 incorporates exact main a94120e17f0ed2acaa4f91aa783a9179f49bce2e with the four approved runtime files byte-identical942. This approval does not waive the three earlier canonical auth-choice failures or establish deployment/production success.

The first fresh agents coverage run failed107/110 domains. Its spawn-browser domain retained two contradictory legacy controls: a source-string maxstep test inspected only400characters after the status field, and the close transport test expected an exception to disappear without asserting any acknowledgement. The added cleanup receipt moved an existing return field beyond that arbitrary string window; actual maxstep results still contain best-effort text and final verifier structured output on BOTH897 and b547. The source-window failure is a test defect, not a newly proven maxstep runtime defect.

The private correction executes the real activity through its existing native startup/finally adapters: final DOM context and one maxstep verifier invocation produce the exact structured result, retained prior reasoning reaches best_effort_response, and no additional model action runs at an exhausted action budget. Separate missing-best-effort and missing-verifier source mutations each fail this same observable control. The second corrected control calls the actual imported repo function with12 combinations of200/500/plain409/transport/genuinely thrown seal/cancellation and close/pause. It verifies the exact session request, one existing10s attempt, exact failure receipt and original cause/exception identity. On897 it fails because500 returnsNone; on b547 it passes. No runtime, numeric cap, prompt, evaluator or benchmark catalogue changed.

Private replay commands and complete bound file hashes are in `.context/legacy-control-repair/REVIEW.md` and `proof.json` in the deployment preview. Measured current both-controls PASS2.10s, old-close FAIL1.14s, old-maxstep PASS2.27s, negative-field FAIL2.01s and negative-verifier FAIL2.10s; every final replay asserts zero actual transport/socket attempts through owned cleanup. An incompatible mixed-version import and an overbroad send-level mock guard are retained as failed preflights, not causal proof. Parent reviewed exact test-only patch f9735ea20b67528321d862d98ac704528727c1a6f74fd309579b47ef1eedde7d. Full canonical post-adoption coverage remains required; this addendum does not change the case's deployment status or claim the original auth-choice benchmarks fixed.
