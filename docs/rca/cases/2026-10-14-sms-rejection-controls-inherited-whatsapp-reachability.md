---
id: 2026-10-14-sms-rejection-controls-inherited-whatsapp-reachability
date: 2026-10-14
title: SMS rejection controls inherited shared-user WhatsApp reachability
surface: back-end
component: send-sms-blackbox-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: two SMS-only rejection controls used the shared default user without fixing its WhatsApp reachability precondition
symptoms:
  - notify does not rewrite auth, routing, or rate-limit rejections expected status 500 got 200
  - notify does not retry ambiguous gateway failure expected status 500 got 200
  - Results 60 passed 2 failed 62 total
  - Surge 401 or 502 followed by WhatsApp 200 and notification success
tags:
  - sms
  - whatsapp
  - fixture
  - channel-selection
sources:
  - commit a6ae9954c6d93ef1008811775f5750181bf036f1
  - commit b4a926834f4fa79f03b534ad7b96fa8882037015
repro: back-end/src/tests/blackbox/send-sms.blackbox.ts
status: mitigated
---

## Problem

Full backend coverage failed only the send-sms domain: 60 passed, 2 failed. Both new controls expected HTTP 500 but received 200 with success true. All 267 unit files passed according to the parent gate report. The retained full failure is .context/test-runs/backend-coverage-failed-20261014-232806-1951575; the original domain log is retained there and under back-end/coverage/blackbox-run/send-sms.log at investigation time.

## Diagnosis

The actual failing requests did reach the intended fake provider boundary. For agent 134990da-f6f2-4c7d-9a54-69fd6ab8c7be, request 764f440cd8fa, Surge returned 401 at 23:22:49.567 after exactly one SMS attempt. For agent dcf8f0cc-35b1-4cad-b510-81831874775d, request bdd845c89f49, Surge returned 502 at 23:22:49.618 after exactly one SMS attempt. Neither rejection triggered a rewrite. In each case the selected WhatsApp mirror then returned 200, and the intended ANY-success channel aggregation returned notification success. The service was not swallowing the Surge error or retrying ambiguous SMS delivery.

The first bad boundary is the owning test's precondition: setTestUserPhone pinned only the shared default user's phone, while both SMS-only rejection controls inherited whatsappReachable=true. Native dispatchNotification selects SMS plus configured WhatsApp for that state; outboundEvents intentionally treats any delivered channel as success. Actual sent bodies and statuses were decrypted locally from the original encrypted provider archives into .context/sms-original-provider-captures.json without exposing credentials. Notification fixtures and exact body markers were not missing.

Two archive searches were `SMS WhatsApp fixture channel reachability notify` and `Expected status 500 got 200 mirrored SMS`. Earlier searches used `notify does not retry ambiguous gateway failure` and `SMS transport mock status fixture marker rewrite notification`. The October 14 raw-task-kickoff provider-limit case is a relative, not a recurrence: its production message-correction and certainty contract is behaving correctly here; this case fixes only the test's channel precondition. Existing SMS/WhatsApp mirroring tests explicitly use owned user state, but the send-sms phone helper and supervisor provisionUserWithPhone helper do not provide an explicit SMS-only precondition.

## Solution

Adoption b4a926834f4fa79f03b534ad7b96fa8882037015 gives exactly the two rejection controls unique fixture users/phones with whatsappReachable=false, and binds both their agents and request user_id to those owners. Exception-safe cleanup deletes only the owned fixture/agent/user. The shared user is not modified to disable WhatsApp; runtime channel selection, ANY-success semantics, transport fakes, prompts, correction policy, deadlines, and every existing status/count assertion remain unchanged.

Canonical before/after proof used a private export of a6ae production source, an owned database victoria_sms_owning_2994bfec91 and backend port 43185. The shared fixture reachability was deliberately pinned true identically for both runs. Only the two after-run controls used the dedicated SMS-only fixture. The same command was executed before and after:

```bash
cd .context/sms-owning-export/back-end
npm run test:blackbox -- send-sms
```

Before: native exit 1, 60 passed/2 failed, domain 1910ms. After: native exit 0, 62 passed/0 failed, domain 1793ms. Case concurrency remained 30 and domain timeout 900000ms. TypeScript AST comparison verified both owning controls' assertion expressions byte-for-byte identical. The non-content control passed 401, 403, 404, and 429 with one Surge call each; the ambiguous control passed 502 with one call. Canonical positive control `npm run test:blackbox -- send-sms-whatsapp-mirroring` exited 0 in 662ms, preserving the intended mirrored-delivery contract. No real SMS/model/provider call was authorized; the canonical fake transport flags owned the boundaries.

Private evidence: .context/test-runs/sms_owning_2994bfec91/{before,after,positive-mirroring}, native-exit.json and summary.json in each, and recovery-proof-and-cleanup.json in their parent. The private zero-external replay .context/sms-channel-custody-replay.cjs independently failed/passed the extracted unchanged owning functions by changing only mocked User.whatsappReachable; it supplements rather than replaces the canonical proof. .context/sms-owning-assertions-proof.json records the assertion comparison. Native cleanup found no listener on port 43185 and zero DB connections; the owned DB/export were retained for evidence. Full post-adoption backend coverage on exact b4a926834f4fa79f03b534ad7b96fa8882037015 exited 0: 267 unit files and 196/196 blackbox domains passed, including send-sms and mirrored-delivery controls. Coverage was 89.60% statements/lines, 81.03% branches and 92.63% functions. Canonical receipt: .context/deploy-runs/20261014-231509-1930784/logs/backend-coverage-blackbox-20261014-234213-2394190.log. Exact native cleanup confirmed three Steel allocations released and seven Kernel allocations deleted. Original failure evidence remains retained. This case records a mitigated fixture-only defect, not a production SMS fix, all-gate completion, or closure of the separate auth/handoff/credential ownership case.

## Human feedback

The parent required actual sent-body/status evidence, both owning controls failing and passing with unchanged assertions, positive mirrored controls, and a unique local DB/backend with canonical fakes. The parent explicitly approved only the test fixture adoption after this proof, preserving runtime/product source and all provider/timeout contracts. No shared-user channel toggles or manufactured HTTP errors were accepted.

## Reusable lesson

Give SMS-only rejection controls owned users with explicit channel reachability instead of inheriting mutable shared-user delivery state.
