---
id: 2026-11-11-free-shop-account-inherited-annual-plan-label
date: 2026-11-11
title: Free shop account inherited an Annual plan label and triggered a second browser audit
surface: back-end
component: auth-test-site
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: renderAccountPage emits Annual for zero-fee commerce membership; owner-directed5fb normal parent turn exposes the inherited false plan after verified purchase
symptoms:
  - "Tool 'spawn_browser_agent' exceeded its exact root call limit during execution: expected 1, got 2"
  - "Plan Rose Shop Annual Status Active on membershipFeeCents0"
tags:
  - auth-test-site
  - member-discount
  - account
  - browser
  - fixture
sources:
  - commit 527c30ab6f6c122cda7346464218355c87712ce2
  - commit f8c8255003d70ac639facf623b30397d62baf38a
  - agent b9fecd3e-dc11-40b7-8ca3-bb0d53929d38
repro: back-end/src/tests/blackbox/auth-test-site.signup-shop.cases.ts member_discount_purchase accountterms assertions; pure actual renderer replay proves local boundary only
status: open
---

## Problem

Actual source527 vsupstreamf8. Native unchanged task failed because a second root browser was started (expected1, got2). The first browser had already placed the one tote order at the correct member price and returned both required parent fields. The normal parent then audited whether the reported Annual/Active plan was an unrequested subscription.

The deepest owned data contradiction is in renderAccountPage: commerce behavior explicitly declares membershipFeeCents0 as free, and the shop/checkout already says a free account, but account output unconditionally says Rose Shop Annual. Captured browser context sees this before purchase completes; its returned notes expose it to the root.

Source attribution distinguishes layers: the false Annual label is inherited unchanged fromf8. Owner-directed5fb removes the former completed-child synthetic completion/acceptance shortcut, so527 runs the normal model turn and dispatches the captured audit. Offline actualf8 helper+caller AST routes the same completed child to attempt_completion; current routes the captured secondspawn. Preserve the intended removal. This is an introduced routing exposure of an inherited contradictory fixture, not evidence of a provider outage or model-intelligence limitation.

Candidate is one runtime value: free shop accounts display the alreadyexisting phrase a free account. Positive-fee shops and nonshop memberships retain Annual byte-for-byte. Two assertions join the existing member-price API blackbox test; every original9 test body remains identical after removing those exact3added statements, retaining71oldassertions. No task/schema/evaluator/prompt/timeout/roottoolcount change.

Executed owning renderer replay: current RED, upstreamf8 RED, candidate GREEN on the same free-plan assertion. Actual renderAccountPage/layout/escapeHtml/siteUrl code is compiled directly; no mock renderer/model/provider/DB. Positivefee999, nonshop, guest/auth output remains byte-identical. Complete freeHTML delta is only the Plan value. This proves renderer correction, not the unchanged full benchmark outcome. Routing replay is a separate actual-source counterfactual, not a proposed forced-completion fix.

OPEN verification: full isolated auth-test-site API blackbox suite and unchanged canonical local benchmark oncandidate remain unexecuted. Native prescribed retry belongs to coordinator; preserve both results regardless. Root publisher subsequently completed actual verified durable FE and globalLASTLLM publication; its manifest is now hash-bound in terminal-binding.json. Six native recording references and exact fully reconstructed root requests remain private. The factualUIhunk received independent boundedGROUNDED review; normal source-scoped approval workflow and fullAPI/task proof remain required.

Archive searches: literal spawn_browser_agent/exactrootlimit; memberdiscount/secondbrowser/paymentapproval; Annual/freeaccount/membershipFeeCents. The seatmap double-spawn and lost-checkout fixture cases are relatives, not the same cause. Their rejected symptom-hiding fixes are not adopted. No report_bug row exists in captured fullroot transcript.

Step6a: remove the false annual claim only for the existing free-shop branch; use existingfee state as authority, no synthetic terminal routing, retry cap, task change or subscription classification from strings. Factual existing fee0/shop terms ground the candidate; independent reviewer is checking explicit UIhunk.

Human feedback: current user asks to finishdeploy; root operational directions require no forcedcompletion restoration, no count/timeout/assertion weakening, no sharedsource edits while healthy native work continues. These root constraints are not invented user quotations.


## Diagnosis

See the criticalpath and distinct inherited data/introduced exposure attribution above; exact sources and localRED/GREEN logs are bound in RCA.json. Root firstcohort15PASS1FAIL retains all16verified lifecycle releases. No infrastructure stop.

## Solution

External candidate only: free commerce account Plan derives from the already existing zero fee. Positivefee/nonshop remain unchanged. FullAPI and unchanged benchmark outcome proof remain OPEN; no fixed claim.

## Verification

Pure owning renderer current/f8 RED and candidate GREEN; actual native routing counterfactual oldcompletion/currentaudit reproduced locally with no modelcall. All71old assertions retained. Root must execute fullowningAPI and unchangedtask after quiescentintegration; independent factualUI review is boundedGROUNDED, with normal source-scoped approval workflow still required.

## Human feedback

User requested finishingdeploy. Root explicitly preserves owner-directed noforcedcompletion behavior, task/evaluators/rootcount1, healthy native jobs and source freeze until quiescence. No other direct human feedback recorded.

## Reusable lesson

Render membership terms from configured billing truth before asking an autonomous shopper to reason about side effects; do not invent a subscription label or hide it with synthetic completion.


## Terminal occurrence and retry

Native occurrence56fc83b47f074adabebf969da927347d on527 is complete FAIL/cleanuptrue/exit1. Originalcohort15PASS1FAIL and prescribedretry1FAIL retain the identical exact2-versus1 error; all16+1 resource releases/lifecycles are verified with no infra stop. Retry root0b3530fe-7430-4ace-8e2c-339fe239687c also started review_annual_plan as its second browser. No candidate fixcredit. Native triageentry is INTRODUCED/blocking without postmerge/waiver. Actual source/token/request/result/receipt and both run/summaries hashes are in terminal-binding.json. Rootpublished verified FE/globalLASTLLM evidence is bound there; no duplicatepublication. FullAPI and exactunchanged postcandidate benchmark verification remain OPEN.
