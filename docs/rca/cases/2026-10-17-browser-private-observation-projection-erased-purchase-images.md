---
id: 2026-10-17-browser-private-observation-projection-erased-purchase-images
date: 2026-10-17
title: Private browser observation filtering erased operational purchase images
surface: agents
component: spawn-browser-agent-v3 / typed operational result and approval projection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "service_actions.execute_action visible() applies DOMService model-visible image/media suppression to the validated operational payment receipt; handler wrappers repeat that view projection"
symptoms:
  - Five original authentication-purchase tasks failed because Canvas Tote imageUrl was null
  - Parsed browser actions and actual tool arguments contained the expected image URL
  - Backend approval-request bodies and evaluator receipts lacked that image
tags:
  - browser-private-input
  - payment-approval
  - operational-projection
  - image-url
sources:
  - fleet run 35c109a9-92a5-4e30-bbcf-0aefacfe277a
  - commit 0a74e8d555c9f793360c5ca2c78f5950939ecc0a
  - memory:purchase-image-rca/attention-body-facts.json and additional-two-facts.json
  - memory:purchase-image-rca/owning-red/payment-final-result.json
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py operational_source_activity_manager_json_hydration
status: open
---

## Problem

The unchanged original30 campaign finished 23 PASS /7 FAIL. Five failures share a deterministic purchase-image symptom: member-discount-purchase (root58237271,163.1s), member-discount-signup-fails-purchase (root3f573313,211.6s), signup-purchase (roota4017e69,154.8s), signup-purchase-no-subscription (root9f3cba3e,156.7s), and session-expires-at-checkout (rootf0b35949,108.2s). All five retained parsed actions and actual tool arguments contain the expected product image URL. Actual backend attention-request bodies contain `requestPaymentCard.lineItems[0].imageUrl:null`; the native evaluator reports the same missing value. These are receipt-body and evaluator observations, not a fresh database-row read.

The accompanying ACTIVE-versus-COMPLETED error is secondary in this trace: the benchmark detects the invalid approval receipt and returns its receipt error before approving/resuming the purchase. No separate agent-terminalization cause is established here. Original task verdicts, durations, fixtures, assertions, money and clocks are retained unchanged.

## Diagnosis

Archive searches used the literal missing imageUrl/payment/lineItems symptom and the behavioral purchase receipt/projection/private-credential media symptom. The earlier 2026-09-29 browser-payment-approved-request-omitted-from-verifier case is related by purchase/resume family, but its first bad boundary was omission from verifier action history. This incident loses a typed operational field before approval transport. It is a distinct boundary, not evidence that the earlier history fix failed.

Critical path: model-selected receipt with image → existing service schema and product-link validation → generic page-observation projection after secret use → safe result history/fork → payment pause/activity return → manager normalization → backend attention request → unchanged evaluator. DOMService intentionally suppresses image_url/media/raster keys after private credential use. Applying that page-observation policy to the operational receipt erases its declared line-item image field. The existing manager cannot reconstruct a field already removed.

Initial source notes identified handler line10975 as the loss. Subsequent real-entry reproduction exposed earlier service_actions.visible() and activity _execute_action projection, so10975 was not the first projection. The private source must survive those local wrappers while their ordinary dictionary views remain observation-safe. No global DOM filter change or image allowlist is justified.

The exact native flag value was not independently sampled through an API. Retained traces contain prior secret-ref input actions; the owning reproduction restores actual secret-used state through the normal activity resume path and executes the real service, DOM policy, activity, manager normalization and approval packing. It deterministically loses the image before the change and retains it after. This supports the transport mechanism; it does not substitute for the unchanged native after outcome.

## Local reproduction and evidence

Three private captured receipt cases fail the same real activity→manager image assertion before the change. Permanent synthetic fixtures use an unrelated stationery product and image, with ordinary quantity, shipping, tax, subtotal, total and fingerprint checks. A source-asserted original-runtime counterfactual fails the permanent activity→manager image assertion, while the typed-source policy control passes. The candidate passes the same activity→manager assertion.

The fixture uses real ActivityEnvironment activity entry, real execute_action validation/redaction, real manager payment normalization and approval packing. External model, session, storage and financial edges are fixtures. No desired post-fix receipt is supplied to the manager: it receives the actual activity return through JSON hydration. The real Temporal JSON converter also excludes private source attributes. Browser disconnect occurs before final result construction. Actual notification normalization and page-preview fallback are exercised before masking; data:image remains withheld after private credential use.

Two initial full attempts failed only new fixture registration/binding errors and remain retained. A third full pass used mutable donor provider dependencies and is explicitly qualified as mixed-source evidence. A fourth standalone run with original provider files physically pinned passed owning+credential domains in113.8s. The explicit b793+payment merged full run is PENDING at draft creation; its source manifest and terminal result must be appended before reporting that merged verification passed. No earlier pass is relabeled as proof of a different source.

## Solution

The private candidate separates one producer-owned validated operational model from its observation view. A local typed result envelope retains the source as a nonserialized attribute across existing local wrappers. The model/history/fork still receive the same observation-safe dictionary. Final payment and notification fields derive once from the validated source with the existing scalar secret mask, without reparsing masked numeric references. Wrong-schema, untyped, foreign attribute-like and unknown fields do not gain source authority. This is a trusted in-process producer boundary, not cryptographic provenance or an attestation that any supplied image URL is public.

A discarded provisional approach reparsed an already masked numeric amount and raised schema validation errors. It is preserved as blocked evidence. The selected design does not restore numeric amounts: a coincidental numeric secret still becomes a reference and normalizes to zero in both baseline and candidate. This is NOT proven fail-closed behavior, NOT a numeric fix, and NOT a new privacy exception.

No new model call, synthetic instruction, credential access, URL fetch, schema/evaluator change, timeout/cap increase, fixed delay, fixture/site classifier, or image-specific exception is introduced. Unknown/Any values retain page-observation policy. Existing encrypted resume ownership remains unchanged; raw operational models are activity-local and are not added to public resume, history or LLM input. Holding an already validated model extends its local lifetime; this adds no new durable storage pipeline. Image-bearing approval metadata grows by the actual previously omitted strings; no paid-token or invoice estimate is inferred.

## Golden references and generalization

Read references: OpenClaw payload-redaction.ts1–35 and session-tool-result-guard.payload.ts1–95 distinguish typed payload/diagnostic projection; Hermes browser_tool.py900–918 and agent/display.py308–326 separate operation data from display projection; Codex redacted-string/lib.rs11–52 provides typed presentation separation. These are relevant owner/projection patterns, not proof of an identical purchase contract or cross-harness consensus. No exact Claude purchase projector was found.

The coherent C+1 change shares the existing operation source across its two consumers rather than teaching the model a fixture sentence. It covers payment and notification siblings at the same owner while leaving observation secrecy intact. No failed Step5b rung is invented and no whole-class elimination is claimed. Native unchanged after verification and deployment approval remain parent-owned and unproved in this packet.

## Human feedback

Parent review required source/view separation, preserved ordinary human approval, unchanged global media/secret protection, and no numeric unmasking. The user authorized local proof before deployment approval. Those instructions do not constitute deployment approval or a native PASS. All five original image failures remain unwaived; this RCA stays OPEN until exact unchanged-task proof and remaining gates are satisfied.

## Superseding local verification, 2026-10-17

The exact private merged patch (SHA2567e84c880fce7df0efc4298ebf5dbfa357893d1f4f4c49d467a3eb2b14399a1e6) retains all3354 validation-owning assertions,441 Rose assertions, plus39 synthetic assertion nodes in three new registered controls. The correctly imported merged full run passed the owning and browser-credential domains. Its overall exit1 is retained: two Rose dump-location checks failed because an unchanged observability helper was symlinked to the donor and computed its diagnostic root there. After materializing identical helper bytes privately, the whole99-check Rose domain passed in2.0s. No assertions or runtime code were changed for this setup repair;227 recorded source inputs remained unchanged during each run. This is cumulative local proof, not a relabeling of the original combined exit.

Earlier mixed-source and invalid-bootstrap attempts remain preserved. The standalone physically pinned-provider two-domain run passed in113.8s. Independent peer review of the exact merged patch found no concrete introduced blocker within the typed-source/normal JSON boundary; it did not independently run tests or certify a native result. All five native image failures remain unchanged, and this case remains OPEN.

## Reusable lesson

Keep validated operational data separate from its observation view, and derive each consumer projection once from the owning source.

The corrected forward adoption patch is SHA256 `2745f88ea261432b07e6734ba3f982cdf90efc888dd78192b2934a7ea932c348`. The earlier payment-only patch incorrectly represented an existing service file as a new file; its failed apply check is retained. Regenerating the diff against immutable Git blobs changed only patch metadata, and all five target files matched the previously tested source bytes.
