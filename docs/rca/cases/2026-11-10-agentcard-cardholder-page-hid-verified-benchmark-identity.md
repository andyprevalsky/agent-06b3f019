---
id: 2026-11-10-agentcard-cardholder-page-hid-verified-benchmark-identity
date: 2026-11-10
title: The first cardholder page hid a verified benchmark identity
surface: back-end
component: agentcard-benchmark-readiness
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: resolveBenchmarkCardholderId discards total and applies preferences to one default page
symptoms:
  - AgentCard benchmark cardholder is not KYC-ready (not_started)
  - a verified preferred identity exists outside the default cardholder page
  - payment fixture setup fails before the startup barrier
tags:
  - agentcard
  - pagination
  - benchmark
  - provider-contract
sources:
  - PR #1916
  - commit a60d57d2b7caff115c73e74bb017f3fee3b080d7
repro: back-end/src/tests/blackbox/agentcard-org-runtime.blackbox.ts
status: mitigated
---

## Problem

The PR1916 recovery campaign stopped after a payment fixture rejected `not_started` KYC. Its native record remains one infrastructure failure, twelve cancellations and thirteen UNVERIFIED outcomes. Two captured drivers report KYC rejection; three other payment tasks share the fixture dependency but have no captured KYC rejection. The other eight checks have no demonstrated KYC failure. Missing historical raw provider responses, selected identity and runtime originals prevent an unconditional reconstruction of that original guest's complete source/configuration boundary.

A subsequent bounded, read-only diagnosis reproduced an owning defect on the current intended sandbox principal. The provider returned 50 cardholders while advertising 56. Neither preferred benchmark email appeared in that page. The omitted six included a preferred identity whose actual KYC response parsed as `verified`. No account, KYC, credential, card, funding or payment change was made to obtain this result.

## Diagnosis

The captured primary `tools/list` contract specifies newest-first offset pagination, default limit 50 and maximum limit 100. The resolver called `list_cardholders({})` once, ignored `total`, filtered explicit preferences against that incomplete array, and searched preferred emails only within it. It then queried the returned identities and fell back to an unready identity. The readiness predicate and response parser correctly rejected `not_started`; relaxing them would hide the selection defect.

The resolver, parser and whole backend tree are identical at base `f8c8255003d70ac639facf623b30397d62baf38a`, frozen `77b17bbc168d713037b8edbdcf9c208e646febb5` and recovery `a60d57d2b7caff115c73e74bb017f3fee3b080d7`. The unchanged actual read-only resolver/predicate command failed with the exact KYC error after 52 logical calls. That RED trace returned 50 of 57 records; the earlier head/tail observation covered 56. The later GREEN trace returned all 58 records. The provider inventory grew between observations, so these real reads do not establish a frozen provider environment. Offline replay of the unchanged RED tool arguments and actual response envelopes reproduces that failure on all three revisions. This establishes `Gate: NOT_INTRODUCED` for the current reproduced pagination mechanism. It does not manufacture the earlier guest's missing principal/list trace or prove historical environmental equivalence.

Archive searches covered the exact KYC error and payment-fixture verification behavior. The existing org-backpressure and production/sandbox identity cases were read as related leads. Actual open-PR/file and thread searches found no minimal legacy pagination implementation to duplicate. PR1864's broader REST-v2 fixture migration changes the callers, not this enumeration defect.

## Solution

Enumerate the complete offset inventory using the provider's maximum page size before applying the existing preference order. Advance by the number actually returned and honor an explicit total even after a short page. Duplicate/nonprogress pages, changed totals and incomplete empty pages fail rather than silently selecting from an unproven inventory. The resolver forwards its original shared retry deadline to page and candidate-KYC reads. A check before each page also stops successful nonterminal pagination when that existing deadline expires; retry forwarding alone would not bound successful responses. The separate downstream wallet/final-readiness budgets are unchanged, as are accepted readiness statuses, identity preferences, task definitions, timeouts and financial behavior.

The existing registered AgentCard org-runtime blackbox now exercises the real runtime envelope parser with a verified preferred identity beyond the first 100 records. It failed on the original resolver (`inventory-0` instead of `inventory-100`) and passes with complete pagination. Neighboring malformed-inventory controls require failure before any identity/KYC selection. Review identified successful pages escaping the deadline; a fake-clock regression failed before the explicit deadline check and passes afterward. The unchanged actual read-only resolver/predicate command passed with three logical calls and `verified`; this is a real provider read, not a benchmark outcome or permission for a paid action. Initial stability receipts remain separate from the final deadline-guard verification.

Private evidence is under `.context/rca-pr1916-kyc/`: captured schema/head/tail/KYC responses, immutable current read-only RED/GREEN traces, real-source offline replay, original driver snapshots, source hashes, owning regression logs and stability receipts. Raw identity/auth/log/trace content is not published. The original thirteen UNVERIFIED outcomes, cleanup debt and financial unknowns remain on record. Full current-source smoke, normal semantic acceptance and production verification are separate required gates; this local mitigation grants none of them PASS.

## November 11 recurrence during PR1919

The native `agent-payment-setup-resume` driver for run
`20261111-003553-4136907`, source
`e9a1565dc2ed4ba1391484629e23d6d0f4d9aced`, reached stack healthy at
00:46:51 UTC and rejected `not_started` KYC at 00:47:06 UTC. Its setup,
resolver and provider-runtime blobs match baseline
`1f1e176a4736b2f948ba2fa5ffb2b119a7edbbc9`. This is an additional
`Gate: NOT_INTRODUCED` setup defect encountered while deploying the chat
profile repair; all thirteen native smoke outcomes remain UNVERIFIED.

A separate current read was bound to the original guest's exact source/run
and injected backend payload SHA256
`5b30265216e9bd1f0f9502ae48c7e32ab76fec02bf45966735b27fa473e47a7e`.
The actual default inventory contained 50 of 115 records. Complete offset
reads returned 100 and 15. The unchanged resolver selected an unready row;
the exact published pagination repair selected the existing verified preferred
email identity outside the first page. Both actual source versions also replayed
the same memoized response set with the same respective selections. The bounded
status-only capture completed in 18.601 seconds with 55 unique HTTP requests.
No identity, KYC, account, credential, card, funding or payment write occurred.
The original historical selected-ID/raw-list trace is unavailable, so the current
capture does not establish identical historical provider inventory.

The deploy owner reused both published commits `10f8292237e44bb4507ead090edc0da6cc519310`
and `d713a8d8c66c89238eb2e896ccbcc37147cf5668`. Before applying runtime code,
the unchanged existing registered regression failed on current source:
`inventory-0` instead of `inventory-100`. It passed after the exact runtime
patch. Native smoke, cleanup and production verification remain separate gates.
Private redacted capture and executable commands are retained under
`.context/rca-pr1919-smoke-startup/`; owning regression logs are under
`.context/rca-e388d514/pagination-current-{red,green}.log`.

## Human feedback

The user prohibits paid AgentCard actions and production auth/environment mutation. Diagnosis used status-only tools and the existing identity; no KYC, account or money action was used as a workaround.

Golden reference: not applicable to the provider pagination contract. The repair preserves the existing ready-state predicate and identity preferences.

## Reusable lesson

Enumerate the complete provider inventory before applying identity preferences and readiness checks. Keep historical observation gaps separate from a reproduced current defect.
