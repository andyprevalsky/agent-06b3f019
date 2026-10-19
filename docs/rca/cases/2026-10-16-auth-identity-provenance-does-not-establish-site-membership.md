---
id: 2026-10-16-auth-identity-provenance-does-not-establish-site-membership
date: 2026-10-16
title: Supplied auth identity inventory omits ownership and registration provenance
surface: agents
component: spawn-browser-agent-v3-auth-inventory
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: service_crypto.build_auth_options_prompt_section projects contact labels without identity scope or reader provenance
symptoms:
  - Minted identity is not Andy's membership
  - accepted challenge
  - user_only_verification
  - not_applicable
  - auth inventory loses supplied identity ownership/registration/reader provenance
tags:
  - authentication
  - identity-provenance
  - sms-otp
sources:
  - commit d03c0eed52c696e03ed34eb09d7461f789a1dfa1
  - agent ece33014-be48-405c-8409-f49125857148
  - commit f27a20070f7f74f343959760bd54bb1c0119c3ff
repro: agents/tests/blackbox/browser_credentials.blackbox.py test_supplied_identity_inventory_separates_ownership_registration_and_reader
status: open
---

## Problem

Captured browser step17 declares two supplied contacts not_applicable, with empty evidence_steps, on the rationale that the accepted challenge belongs to a personal phone and the minted identity is not the user's membership. The exact Current Goal already permits authentication using a browser session or minted agent identity. No new task grant is missing. A retained page-state result says conditionally that a code was texted if the number belongs to an account; that does not prove positive account acceptance. No native task verdict was queried or inferred. Both original failures remain unwaived.

The retained step17 dump SHA256 is cae90f8f13bd5be5c7bd1e9a2648aedc12e328fae48c27f24b0c74b06dabdc0f. Full captured message-list SHA256 is c7d82c829c1b67195f9ec6a0322784ff8ec5263f87ca145062776c030eabc542. Private payloads remain outside this case. Generation path is rose-1-ultra, gpt-6-sol-foundry, deadline590s. This investigation did not reconstruct historical wire/deployment or contact a model.

## Diagnosis

Path: task-user AgentIdentity plus realm MintedAccount -> getAuthOptions -> raw minted metadata -> build_auth_options_prompt_section -> actual page-state auth_context -> model assistance assessment -> auth_assistance_assessment_result. The captured goal and rendered source contacts are present. The incorrect acceptance/identity conclusion is in model output; a causal effect of the renderer has NOT been demonstrated.

Source evidence: back-end/src/providers/authOptionsStore.ts74 queries AgentIdentity by userId. authOptions.ts79-83 joins this global user record with a realm record. authOptions.ts148-158 exposes that identity's email/phone and phoneProvider. resolveMintedAccount at authOptions.ts243-270 upserts the realm record before any successful site authentication is demonstrated. Its existence is not registration evidence. service_crypto.py947 currently renders Minted account, email delivery prose and a bare phone; the model does not receive phoneProvider or explicit ownership-versus-registration provenance.

Exact configured SMS reader: repo.py1150 fetch_recent_sms_messages calls the user-scoped agentphone messages route; service_crypto.py457-476 polls it alongside email/iMessage and handles source errors independently. back-end/src/domains/agent-phone/service.ts201-241 looks up the same user's AgentIdentity, requires provider agentphone and a number selector, then uses either the local benchmark stored-inbound source or the configured provider reader. agentPhoneMessaging.ts128 filters conversations by number ID or same phone. Provider metadata is configuration, not delivery health or positive site acceptance.

An offline distinction script executed the exact captured assessment against d03's actual validator with inventory reconstructed only from retained rendered values. It permits handoff; replacing free-text evidence while preserving structural fields also permits handoff. This establishes the validator's semantic boundary, not that the captured task failed. Raw backend phoneProvider was not captured in this reconstruction and remains unknown.

Archive searches: user_only_verification not_applicable; minted identity account registration SMS authentication. The realm-transition stale-context case is a relative, not a demonstrated recurrence: current inventory is already bound to the intended realm. Its useful pattern is preserving source facts without promoting restoration failure into an identity conclusion.

## Solution

Candidate only: append a compact factual JSON projection at the owning inventory renderer. It identifies auth_options.minted as source, ownership_scope task_user, and marks site registration and SMS delivery as not established by this inventory. It exposes only the existing phoneProvider value as agentphone; missing/unsupported provider remains unknown, absent phone not_applicable and disabled identity disabled. No contact, permission, site-member predicate or health grant is invented. Existing labels, secret references, task, tools, receipts, budgets and controller behavior remain unchanged. At10k agents it adds a constant-size local projection; no query, model call, cache state or global coordination.

Owning reproduction, executed before production edit:
`/home/boxes/rose-auth-repair-integration/agents/venv/bin/python .context/check-identity.py`
FAIL: AssertionError auth inventory loses supplied identity ownership/registration/reader provenance.
Identical command after edit PASS, zero socket attempts. This deliberately new representation contract proves the missing metadata is now supplied; it does NOT prove old source violated a preexisting semantic contract or that metadata changes model behavior.

Full existing browser-credentials run_all_tests executed via the same offline launcher with --domain: PASS, zero socket attempts. All182 original assertions remain structurally present; regression is registered in its existing run_all_tests. Actual formatter executes, no expected-output stub. Syntax/diff checks pass. Ruff unavailable in the installed interpreter; no dependencies were installed.

Smallest coherent stronger controller design remains open: separate claims by provenance (explicit task restriction, observed method incompatibility, accepted account binding, channel configuration, profile inference). Bind supporting observation/task references to each disposition; do not treat ownership metadata, a URL, typing ACK, generic code form or missing OTP as positive registration. Observation references alone cannot establish semantic truth: an observation may be conditional, stale, unrelated or anti-enumerating. A controller cannot honestly derive site membership from those facts without an authoritative binding or a separately validated semantic assessment. Do not force another identity or add hidden membership lookups to manufacture proof.

Step5b: the general class of claim/source conflation still admits a coherent source-provenance/controller design. No next-deeper failure is invented. This factual projection is a candidate data-contract improvement, not a completed semantic gate or final prompt prescription. Prior negative explicit-SMS-phrase experiments are not repeated or relabeled as successes.

Golden-reference search: searched Claude Code tools, OpenClaw agents, Codex core and Hermes for provenance/untrusted. Hermes hermes_state_messages.py527 preserves producer metadata rather than classifying content at render time; Codex core/context/guardian_sender_messages.rs49 labels partial history as context, not authorization; OpenClaw agents/transport-message-transform.ts66 preserves result provenance for later pairing. No direct reference implementation of site-registration truth was found or claimed. This candidate follows producer-derived metadata separation, not an invented account verifier.

Native unchanged outcome verification belongs to the parent. The active d03 worktree/run was neither edited, signalled nor duplicated. No API, DB, inbox, provider, site or model calls were made. This RCA remains open until causal semantic and unchanged native outcome proof exist; no deployment or production-review action occurred.

### Subsequent native evidence does not isolate the factual projection

The source-factual metadata projection was included in598, whose SMS still FAILED615.4s while signup PASSED222.3s. A laterf27 run combining that same projection and receipt repair with independent handoff-precondition verification recorded SMS PASS360.8s and signup PASS125.7s, controller0 and canonical clean ownership receipts. The SMS trace shows an actual Sol Foundry judge rejection0.5, ordinary planner continuation, supplied-phone entry, actual injected USER OTP correspondence, completion1.0 and nativePASS. This supports the combined handoff mechanism in that run; it does not establish that this factual projection changed model behavior or that supplied ownership implies site registration.

See 2026-10-16-auth-handoff-preconditions-not-independently-verified for actual native/owning evidence and publication receipts. The planner automatic-OTP contract is not explicitly carried in the handoff verifier packet, but the observed judge correctly rejected the premature handoff; no capability patch is justified from that representational difference alone. The earlier negative extra-SMS-wording factors are not promoted to repairs. This representation-causality case remains OPEN, with full30 regression initially not run, now root-reported RUNNING/result PENDING, and no deployment approval. Historical pending fields remain valid capture-time records; later terminal receipts are additive rather than overwritten.

## Human feedback

The user authorized prompt/context engineering and verification in a separate private worktree, required preservation of the live immutable run, and deferred approval to deployment after proof. They rejected hidden fixture membership, forced alternate identity, hardcoded DOM phrases, fabricated grants and calling scripted output native repair. The exact current goal already permits supplied agent identity. General nonprompt/controller work remains coherent; no failed Step5b rung should be fabricated.

## Reusable lesson

Keep user-scoped contact ownership and configured readers separate from evidence of site registration, accepted authentication and delivery health.
