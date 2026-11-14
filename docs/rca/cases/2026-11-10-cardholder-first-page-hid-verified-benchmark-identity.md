---
id: 2026-11-10-cardholder-first-page-hid-verified-benchmark-identity
date: 2026-11-10
title: The first cardholder page hid an already verified configured benchmark identity
surface: harness
component: agentcard-benchmark-float
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: resolveBenchmarkCardholderId treated the default newest-first first50 list_cardholders response as complete org membership and filtered out the configured verified cardholder
symptoms:
  - "AgentCard benchmark cardholder is not KYC-ready (not_started)"
  - "FATAL: setup-benchmark-payment.ts failed"
  - "INFRA STOP: 1/17 scheduled jobs"
tags:
  - agentcard
  - cloudbench
  - pagination
  - deploy-smoke
sources:
  - PR #1682 recurrence, 2026-11-11
  - commit b4cfdc9d11219ba2ae9a76e5d8459670fd36ef1e
  - PR #1865 native smoke attempt42
  - commit 431b7c4cb2aff2af425c95d0f2aedd658e843b9c
  - commit f8c8255003d70ac639facf623b30397d62baf38a (upstream)
repro: existing back-end/src/tests/unit/agentcard-benchmark-float.test.ts plus source-bound encrypted actual-membership/KYC replay; old source selects not-started-0 instead of verified-off-page, candidate passes the same assertion
status: open
---

## Problem

Native smoke42 on431b7c4/a610 failed agent-payment-test-shop setup at06:57:56UTC,
then native infra-stop fired at06:59:00UTC. The provider KYC read succeeded but the
selected cardholder was not_started. No fresh benchmark run/report-card was
produced. The later409unsealed-runtime/cleanup failure is downstream and retains
its separate unknown resource/financial state.

## Diagnosis

Gate: NOT_INTRODUCED. The setup script, cloudbench driver, org runtime, KYC parser
and benchmark-float module are byte-identical to upstream f8c825. Replaying exact
owning function text on both revisions returns the original not_started refusal.
Attribution does not release this assigned repair.

Read-only native MCP tools/list proves list_cardholders is newest-first, default50,
max100 with offset. Its default page returned50/83. Paginated same-credential
sandbox reads found the configured benchmark identity already verified in the
complete list and absent from the first50. Later separate observations retained
84 then85members; in each bounded KYC capture the first50 were all not_started,
while the configured benchmark holder was verified off-page and the alternate
configured holder was pending. No identity, KYC, credentials or provider state
was changed. Membership/state identifiers remain encrypted; redacted receipts
retain counts, hashes, timestamps and the exact read-only schema.

The resolver filtered configured IDs by membership in that incomplete first
page before issuing KYC reads. It then examined only those50new holders and
fell back to not_started. A direct configured-ID shortcut was rejected because
get_cardholder_kyc_status outputs no org-membership identity contract. A legacy
configured org hint differs from authenticated whoami, but both configured
holder IDs were positively listed in the actual OAuth sandbox org; changing
org credentials or KYC is neither necessary nor justified by this evidence.

The existing backpressure RCA was searched and read first. This is a distinct
successful-read pagination boundary; no transient retry or external credential
exception addresses it. A recorded production identity check failing Stripe
livemode does not establish current sandbox KYC state.

## Solution

Prepare bounded native limit100/offset pagination under the existing shared30s
org-read deadline. Require stable safe-integer total, exact raw/extracted item
count, unique IDs, progress and complete enumeration before applying the
unchanged configured-ID membership, email preference, KYC readiness and fallback
logic. Repeated, malformed, empty/truncated or changing pages fail closed;
403/throttle still propagate. No permission, task, timeout, assertion, float or
financial lifecycle condition changes.

The unchanged owning suite with a new101-member off-page regression is RED on
original source and GREEN on the candidate. All original assertions and test
bytes remain intact outside additive regression blocks. The exact encrypted
85-member/KYC snapshot is RED on431 and f8, then GREEN on the candidate using the
already verified configured same-org member. Uncaptured KYC states throw in the
replay. Independent review approved nine data-only boundary groups including
foreign configured IDs, shared deadline,403/429, malformed IDs, duplicates and
changing totals. This proves the resolver repair, not the original benchmark
outcome; actual integration, current-source gates, unchanged full smoke and
production remain pending. No native original result or custody was rewritten.

The native external-provider report helper cannot turn incomplete work into
completed coverage: three unchanged existing cycle tests confirm an external
waiver refuses incomplete/unexecuted cases and cannot authorize execution
recovery. No provider exception, whole-gate waiver, new repair goal, benchmark
retry or KYC operation was performed. Other unexecuted smoke checks still require
native execution after actual custody closure and approved source integration.

Golden reference: not applicable; no model-visible text or approval-gated hunk.

## Human feedback

The actual user requested finishing /deploy and preserves Freedom. The bounded
read-only provider and external-candidate constraints came from the deployment
coordinator; they are not additional direct user feedback.

## Reusable lesson

A first page is not a complete membership proof. Enumerate the native provider
contract before treating a missing configured identity as unverified or asking
for an account change.

## PR1682 recurrence on 2026-11-11

The frozen b4cfdc9 smoke campaign first failed payment-idempotent-abandonment setup at 04:57:12 UTC. It read one cardholder page and made 51 KYC reads, then rejected not_started; the whole campaign ended with one failure and 15 cancellations. All16 adapter outcomes remain UNVERIFIED, incomplete and cleanup-false. These are not passing payment tests.

The inherited benchmark-float bytes match the earlier failure in this case. Root-owned read-only inspection of the current configured organization found123 unique cardholders: the default page contained50, an explicit limit100 page contained100, and offset100 supplied23. All50 default-page KYC responses were not_started. The configured existing verified cardholder was absent from that default page. No credentials, KYC, cardholder or financial state were changed. These captures occurred after the failure; they do not reconstruct missing historical raw provider responses.

The original compiled selector and readiness check replayed the captured responses and failed with the same not_started error after52 recorded calls. The exact previously reviewed pagination candidate passed the identical readiness assertion in4 calls, including two complete membership pages. The replay performed zero network calls and throws on unobserved input. The complete candidate owning unit passed under a native supervisor with exit0, quiescence and no orphans. Runtime candidate SHA25623e776a06335270b2a014078c56dd508915ba1c8341e5cdcc893fa86160c9b2d; test SHA256ef6eb2812a709e092ec12f003cc50eea58976432678b910654c3d1128b9e947a. Root proof references are retained in .context/deploy-session/round12-payment-setup-rca/our-instance-proof.json. Private raw provider data must remain private.

Applied-source native smoke validation is still required. The separate unsealed runtime capture and destroyed-originals failure is not fixed by pagination, and its failure/debt records must remain unchanged.
