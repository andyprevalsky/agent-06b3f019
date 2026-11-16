---
id: 2026-11-16-iphone-setup-verifier-single-sample-outlier-verdict
date: 2026-11-16
title: The iPhone setup verifier decided each verdict from one low-effort rose-1-mini sample, so a rare outlier failed iphone-control 180/181
surface: back-end
component: phone-setup-verifier
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/phoneSetupVerifier.ts verifyPhoneSetup returned the status of a single rose-1-mini completion (served by Azure Foundry gpt-5.6-luna at the pool's low waterfall effort), so one outlier sample (confirmed on a receive address checked only under Start New Conversations From; disabled on a FaceTime page) became the verdict
symptoms:
  - "RERUN: iphone-control failed"
  - "FAIL live setup verifier: recorded proof screens and controls"
  - "receive phone unchecked only under Receive"
  - "FaceTime page with another Apple Account is not evidence"
  - "Passed 180/181 iphone-control test(s)."
tags:
  - iphone
  - setup-verifier
  - live-llm
  - flaky
  - majority-vote
  - gate-observability
sources:
  - PR #2230 (backend-coverage-blackbox run https://github.com/Rose-Ai-Labs/rose/actions/runs/43805814766, FLAKY caa4e37997914a68b620f7100777c972)
  - PR #2289 (backend-coverage-blackbox run https://github.com/Rose-Ai-Labs/rose/actions/runs/43814587111, 180/181)
  - PR #2355 (fix, merged 99ca195f9c273c4715391f81e8a2e8d8118786c6)
  - PR #2293 (backend-coverage FLAKY 4cb7636d7f1d4792b51743551e888478: positive "Saved to iCloud: Passwords & Keychain On" returned unknown; boxes thread ph7193zbgchqaaz524rn3e69858jb1k9)
  - PR #2261 (author's local run 1794783548-1221733-803 in boxes thread ph7860cdzmbjs2k81pn3q6fkhh8j9h2b captured the FAIL line)
repro: back-end/src/tests/blackbox/iphone-control.setup-verifier-replay.cases.ts (live replay, in iphone-control) and back-end/src/tests/unit/phone-setup-verifier.cases.ts (majority contract)
status: fixed
---

## Problem

The `backend-coverage-blackbox` deploy gate failed the `iphone-control` domain
180/181 on its first attempt and passed the rerun (PR #2230, FLAKY
caa4e379; again on PR #2289's head). The failing case was never captured: the
domain's 72 MB log exceeded the gate result bundle, and the progress row kept
only the last 2000 characters, which ended in later PASS lines.

The only captured failure (a teammate's local run of the same domain, 1 of 6
runs) was:

`FAIL live setup verifier: recorded proof screens and controls: recorded setup screens must verify exactly as expected`
with `[{ name: 'receive phone unchecked only under Receive', expected: 'not_confirmed', status: 'confirmed:gpt-5.6-luna-foundry' }]`.

Local evidence (2026-11-16, main 829a581643, test env routing):

- Running that case alone 40 times: 1 failure, a different check:
  `FaceTime page with another Apple Account is not evidence` expected
  `unknown`, got `disabled:gpt-5.6-luna-foundry`.
- 44 direct `verifyPhoneSetup` calls on the "receive phone unchecked only under
  Receive" OCR: unknown 20, disabled 23, **confirmed 1**. The unmodified
  Send & Receive screen gave confirmed 44/44.
- 20 samples of each of the 22 checks: every check has a stable correct
  majority; the failures are rare single-sample outliers.
- About 19 full-domain runs under gate-like load (concurrent isolated copies,
  CPU burners, `NODE_V8_COVERAGE`, shard-1 neighbours at domainConcurrency=4)
  were all 181/181. No timing, DB or cross-domain failure appeared.

## Diagnosis

Critical path: recorded `screen.text` OCR → `verifyPhoneSetup(target)` →
`createStreamingCompletion(rose-labs/rose-1-mini)` → pool waterfall (no Claude
or GPT token; the Anthropic key is backed off with `RosePaymentRequiredError`)
→ Azure Foundry `gpt-5.6-luna` at the pool's `waterfallReasoningEffort: 'low'`
→ `parseSettingsResult` → status. Prod setup verification takes the same path:
the 2026-11-15 setup-verifier case records `gpt-5.6-luna-foundry` replays.

The first wrong data is the verifier's verdict. On an ambiguous OCR screen
(the phone row's checkmark glyph removed under "You Can Receive", still present
under "Start New Conversations From"), the model's answer splits across
unknown and disabled, with a rare `confirmed`. `verifyPhoneSetup` returned
whatever one sample said, so one outlier became the product verdict: a false
`confirmed` marks an unselected receive address as set up in production. The
live replay case asserts all 22 checks exactly, so one outlier among 22
single samples fails the domain a few percent of the time.

Why ladder:
1. Why did the domain fail 180/181? One of the 22 live checks returned an
   outlier verdict (the captured FAIL line, plus the 1/40 local case repro).
2. Why could one outlier fail it? `verifyPhoneSetup` made one completion and
   returned its status, so the outlier was the verdict (1/44 false confirmed
   per call on the captured screen).
3. Why was that possible? The verifier is a safety-relevant
   readiness gate built on a nondeterministic, low-effort model call with no
   corroboration. Its prompt says ambiguous evidence must remain unknown, but a
   single sample cannot enforce that. This is the deepest owned rung: the pool
   routing (low effort, Foundry fall-through) serves every rose-1-mini caller
   and is a separate decision.

The gate could not name the case because `run.ts` put the last 2000 characters
of the failed attempt's output in the progress row; the domain's single FAIL
line was printed tens of MB earlier. That observability gap is fixed in the
same change.

Independent review: a fresh sub-agent given only the symptom and evidence
named the same first bad boundary (the single completion in `verifyPhoneSetup`)
and the same class (a product defect, not a test bug or timing). It also found
that the Foundry body drops `temperature`. Its findings on the first draft of
the fix were resolved as follows:
- A joined model label on one usage line: fixed with per-sample usage items.
- `Promise.all` turned one failed sample into an outage: fixed with
  `allSettled` and 2 agreeing completed samples.
- Field-wise runtime votes: fixed with whole-tuple votes.
- Missing residual-rate math and 5x proof: added below.
- Comment precision: fixed.
- Sibling verifiers: recorded below.

Archive searches: `iphone-control flaky blackbox in-flight reservation cleanup
proof`, `iphone-control RERUN failed rerunning once`, `iphone flaky concurrent
blackbox shared table sweep another domain`, and grep of `docs/rca/cases/`
for `iphone-control`. This is a novel case.
Relatives:
- `2026-11-15-iphone-setup-verifier-ocr-only-evidence-rejected-visible-proof`:
  it added the replay case and measured `receive_address confirmed 1/3` in
  replays. Its lesson (name the OCR-visible proof) applies to prompts. It did
  not address single-sample variance, and its 10/10 stability check was too
  small to see a roughly 2% per-run flake.
- `2026-11-11-live-latency-ratchet-judged-one-provider-sample`: the same class
  (one live sample judged as truth). Its lesson applies, but here the fix
  belongs in the product verifier, not the test, because the outlier is a
  wrong production verdict.
- `2026-11-08-phone-revocation-fixtures-reused-a-fixed-unique-phone`: does not
  apply. The gate ran one iphone-control process per database. The fixed
  `+15550008888` write in `iphone-control.view.cases.ts` is a latent sibling,
  noted below.

## Solution

Shipped in PR #2355 (merge `99ca195f9c`, 2026-11-16). Every deploy gate passed
on `e0dfd07c92`: backend-coverage-blackbox 283/283, with iphone-control's
domain passing on its first attempt; smoke 7/7. Production Render, backend
probes and semantics PASS. A third occurrence surfaced the same day on
PR #2293: a positive check (`Saved to iCloud: Passwords & Keychain On`)
returned `unknown` in one sample. It is the same class, and the 2-of-3 vote
covers it, because one `unknown` sample is outvoted by two `confirmed` ones.

1. `back-end/src/providers/phoneSetupVerifier.ts`: `verifyPhoneSetup` settles
   `SETUP_VERIFIER_SAMPLES = 3` independent samples in parallel. It votes on the
   whole parsed verdict (`identityConfirmed`, `status`, `runtime` tuple) and
   needs at least 2 of 3 to agree, else `unknown` (`false`) with no runtime. A
   runtime is therefore always one sample's own observation, never assembled
   field by field. A single failed sample is not an outage when the other two
   agree; fewer than 2 completed samples throws, as one failed call did before.
   `usage` carries totals plus `samples`, and `billSetup`
   (`domains/iphone/repo.setupFinish.ts`) writes one `usageItems` line per
   completed sample at the model that actually served it. Prompts, schema,
   timeout and the requested model are unchanged.
   Cost and scale: each setup verification is 3 rose-1-mini calls instead of 1.
   Funded Foundry is billed at 0; a paid leg costs 3x, and there are a handful of
   verifications per phone setup. Latency is the slowest of 3 parallel calls.
   At 10k agents the work stays O(1) per verification with no shared state; LLM
   request volume for this call site triples.
2. `back-end/src/tests/blackbox/run.ts`: a failed attempt's progress-row
   `detail` ends with its first 5 `FAIL`/`❌`/`✗` lines (bounded), and a FLAKY
   domain prints them in the runner log. A log larger than the result bundle
   still names its failing case.

Proof (identical commands before → after):
- Live whole-case driver (`npx tsx verifier-repro.ts N`; the case alone with
  the domain's env and local DB): before, 1/40 failed (FaceTime-other-account
  returned `disabled`). After, 0/100 on the final code, and 0/57 on an
  intermediate version of the fix.
- `verifyPhoneSetup` on the captured screen (44 calls): before, confirmed 1,
  unknown 20, disabled 23. After, confirmed 0, unknown 25, disabled 19.
  Positive control: 44/44 before and after.
- Expected residual: with a per-sample outlier rate p ≤ 1/40 on the two
  unstable checks, a wrong 2-of-3 majority is about 3p² ≈ 0.2% per check, so
  well under 1% per domain run, compared with a few percent before.
- Full `npm run test:blackbox -- iphone-control` on the final code: 181/181 in
  5 consecutive runs.
- Unit `phone-setup-verifier.cases.ts` (run by `phone-harness-client.test.ts`,
  lane backend-unit) asserts outlier rejection, a negative control (2 agreeing
  samples decide), 1-failed-sample tolerance, 2-failed throws, whole-tuple
  runtime, and per-sample usage. It fails on the old verifier (`1 !== 3` sample
  calls) and passes 5/5 on the fix; the full backend unit suite is 465/465.
- Unit `gate-progress.test.ts`: the new FAIL-line assertion fails on the old
  runner and passes 5/5 on the fix.

Not changed, recorded as follow-ups: the other one-shot rose-1-mini phone
verifiers on the same route are `phoneAuthLoss.ts` `verifyImessageAuthLoss`,
`phoneMessageVerifier.ts` `verifyPhoneMessage` and `phoneCredentialVerifier.ts`
`verifyPhoneCredential`. They return tap points, bindings or verdicts with their
own result shapes, have no live replay in any gate and no measured outlier
rate, so a vote rule for each needs its own measurement first. Also noted: the
Foundry Responses body does not carry `temperature`, and rose-1-mini's
fallback effort is pinned `low` (`pools.ts`, `foundry.ts`). The vote does not
depend on either.
`iphone-control.view.cases.ts` still writes the fixed unique phone
`+15550008888` (sibling of the 2026-11-08 case). It is harmless while one
iphone-control process owns a database.

## Human feedback

None recorded.

## Reusable lesson

A safety verdict from a nondeterministic LLM must not rest on one sample: take
a small odd number of independent samples and require a majority (else
unknown). Measure per-check outlier rates with tens of samples before calling a
live replay stable; 10/10 runs cannot see a 2% flake.
