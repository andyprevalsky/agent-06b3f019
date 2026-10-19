---
id: 2026-10-17-incomplete-machine-list-crashed-reservation-image-check
date: 2026-10-17
title: Incomplete Machine list record crashed reservation image verification
surface: infra
component: original600-admission
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: verify_reuse_images dereferences a selected Machine configuration before validating that the fresh list contains a configuration object
symptoms:
  - AttributeError on current config get after reservation reconciliation
  - stopped Machine list records contain null config and an empty image reference
tags:
  - cloudbench
  - admission
  - native-observation
sources:
  - commit 1cec8c1cb20c85e66e10cd49446b44c5e85101f1
  - fleet run original600-1792274758905856974
repro: python3 scripts/tests/original600-portable-operator.test.py
status: open
---

## Problem

Original75 completed its first reservation pass with544 confirmed candidates and7 holds. The existing acknowledgement observer recovered5, leaving549 confirmed and2 held. The fresh inventory image check then dereferenced a null configuration and raised AttributeError before any controller or task started. The original admission owner joined with exit1; its original23:35:58.9059207UTC deadline and all journals remain preserved.

## Diagnosis

The retained failure packet SHA256 is4b6ed0e1deaba309dd77500687d4b23e7ae261511fdbcf44ed6f2ea0d460d8ee. Four fresh list entries contained null config, empty image references, and a zero updated timestamp while reporting stopped and a nonempty instance ID. One,83d59dfd95e728, was in the549 confirmed rows. Both held candidates,874234f6255018 and8ed04df3602758, had the same incomplete list shape. These records do not establish deletion, valid ownership, or an image match.

The confirmed candidate has a retained successful configuration POST, exact full leased readback and lease release. The later list retains its new instance ID but omits its configuration. The two held attempts stopped during initial lease acquisition; neither reached a configuration request. Their lease outcomes remain unknown. No old request may be replayed or treated as successful on this basis.

Three subsequent bounded read-only individual GETs each reached the original20-second deadline before receiving a response. Their retained diagnostic archive SHA256 ise188a4c23a03913c1b7a7b086f3a7bf6f70c8e31b680c88dca72c623e1d64a02. No configuration was recovered and no request was retried. Fly documents that `host_status: unreachable` means its API could not contact the resource host and may return incomplete information. Its [host-status announcement](https://community.fly.io/t/host-statuses-for-machines-and-volumes-added-to-the-api-and-flyctl/19548) and [Machine recovery explanation](https://community.fly.io/t/minimizing-impact-of-dead-hosts-new-features-and-recovery-techniques/21341) explain that full configuration resides on the host and may be unavailable in this state. This matches the saved records. The underlying reason those hosts were unreachable and whether they recover remain unproved.

## Prior archive search

Searches for `native Machine list null config incomplete image verification` and `null configuration partial native inventory` found related observation/admission failures, including2026-10-04-worker-inventory-unknown-became-capacity-failure and2026-10-06-live-inventory-freshness-miss-aborted-autoscaler. These concern different readers; they reinforce preserving unknown observations as uncredited rather than inventing capacity denial or success. This incident is a related contract failure in the original600 image verifier, not proof that those earlier fixes regressed.

## Solution

The normal admission and existing incomplete-admission continuation share a selected-candidate configuration observation. Preserve the original list bytes and capacity count. Only a selected row with an incomplete configuration can receive an additional exact GET. A complete response must match the listed identity and incarnation, the expected full configuration, image, volume, marker and inactive state. Each request is retained. Only a typed read deadline can be re-observed, fairly across pending identities, within one fixed monotonic110-second phase and the unchanged original90-minute deadline; each GET retains its20-second maximum. Identity mismatch, malformed data and cancellation do not retry. The capacity proof and host provenance bind observation intent, completion and full response hashes.

The existing continuation accepts the exact known1cec failure and stack, original544 and observed549 partitions, all original input hashes and closed history. It carries old verified rows only subject to fresh validation and uses fresh leases and first configuration CAS operations for the two pre-config holds. The old49 and724 histories remain distinct and unchanged. No new launcher, old request replay, incomplete-config substitution or assumed capacity credit is introduced.

Eight incomplete-admission controls, eight recovered-archive controls and two focused public-operator controls passed. The unchanged public-operator control `Portable.test_selected_null_config_requires_one_full_current_get_and_preserves_raw_list` reproduces the old AttributeError, tests successful complete observation and retained raw data, and exercises transient/persistent read deadlines, backward wall time, changed identity/configuration and cancellation. The actual provider configurations remain unresolved after the three diagnostic timeouts; these local controls are not a live600-task result.

## Scope and references

Deleting image or native ownership validation would admit unproven resources, so it cannot resolve this failure safely. The unifying change is one complete-observation helper used by normal and recovery admission; the pure validators retain their existing requirements. Historical source variants preserve already recorded request and outcome identities rather than creating a new launch path.

Local reference reads: `claude-code-src/src/services/api/filesApi.ts:97` bounds retry attempts and surfaces exhausted download failures; `openclaw/src/provider-runtime/operation-retry.ts:40` treats read-like operations differently from create, while its operation loop checks cancellation; `hermes-agent/agent/retry_utils.py:132` bounds and spaces transient retries; `codex/sdk/python/src/openai_codex/retry.py:12` retries only classified transient failures and rethrows others. None supplies Fly ownership validation. This repair keeps that stricter native proof and the original phase/deadline limits rather than copying their retry counts. Exact local file hashes are retained in the private reference-read receipt; no unverified upstream revision is asserted.

## Human feedback

The user asked to simplify startup and explain repeated full-parallelization failures. This failure occurred during admission, before600 task controllers existed. Repair the observation boundary in the existing admission path; do not change tasks, concurrency, timeouts or ownership rules.

## Reusable lesson

A partial provider observation is not an absent resource or an empty valid configuration. Keep the original observation, resolve missing fields through bounded authoritative evidence, and fail closed if complete identity cannot be established.

## Later live observation

The normal same-admission continuation later obtained complete list configurations for all three affected identities, retaining their prior instance IDs. Its final capacity check and both fresh first-CAS reservations succeeded. The selected-row additional-GET path was not needed in that observation because the list itself was complete. Original75 then failed at the separate workspace-volume read boundary before Machine creation; it is not a passing task run. The original incomplete observations and three diagnostic timeouts remain unchanged.
