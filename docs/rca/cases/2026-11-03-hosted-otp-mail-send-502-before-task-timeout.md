---
id: 2026-11-03-hosted-otp-mail-send-502-before-task-timeout
date: 2026-11-03
title: Hosted OTP sign-in recorded mail-send HTTP 502 before the original task timeout
surface: cross
component: auth-test-site-primitive-email
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Saved guest Primitive client received HTTP 502 while issueEmailCode requested the sign-in email; origin and whole-task attribution remain unknown
symptoms:
  - "Primitive send failed"
  - "status=502"
  - "code_delivery_failed"
  - "Timeout after 903s (task timeout=900s)"
  - "Agent status: PAUSED (expected COMPLETED)"
tags:
  - authentication
  - email-otp
  - primitive
  - provider-response
sources:
  - PR #1662
  - commit 4c6a06800ea01d847c01ce98067bb44b0933a425
  - commit 93d2fbc224ff8b78e5b78ad0ad0eccd3ccd2d34c
  - commit 3a94552828156ac2de594697f95f990006268ead
  - agent 987001d1-4f37-4382-9ddb-e0a174e5e5c0
  - benchmark run 52896336-fca3-4aa8-9287-a63aa3faafee
  - task fe353dc3d3a24ca092b764cd0fa430e3
repro: none-recorded
status: open
---

## Problem

Frozen93d2 focused campaign f8543f3ac8c43cfb97e6e49a78b77edbd243025abfff1a0e31831efc850e75e5 job r001-j0015 executed the original browser-auth-email-otp task. Native benchmark status is FAILED, duration909.2s; error is Timeout after903s with original task timeout900s and Agent statusPAUSED expectedCOMPLETED. Guest result contract identity1/pass0/relay1/benchmarkexit1 confirms a real task failure, not missing identity/provenance or infrastructure cancellation. Agent987001d1-4f37-4382-9ddb-e0a174e5e5c0 has native browser/session cleanup acknowledgement and a provider cleanup204 receipt. The failed outcome publication hash is ba6df91756fe18ac6cf3d78da61c7ca9d9098de9a0d7cc34fe261eb9d6b8a187. Preserve the failure and all other task claims unchanged.

## Diagnosis

Saved guest runtime-evidence/logs/backend.log2581 records Primitive send failed status502 at00:29:43.598Z. Line2582 immediately records the hosted fixture code_request/code_delivery_failed. The resend repeats at4021/4022 at00:31:22.299/300Z. The fixture report contains those two failures and zero authenticated sessions. The HTML response prefix is truncated to200characters by the existing client logger; no historical response headers/effective PRIMITIVE_BASE_URL were captured. This positively establishes the failed client operation, not independently verified Primitive origin, credits or a service-wide outage.

Whole-check Gate: UNKNOWN. Conditional response-handling boundary Gate: NOT_INTRODUCED compared with actual merge-base4c6a06800ea01d847c01ce98067bb44b0933a425 to93d2fbc224ff8b78e5b78ad0ad0eccd3ccd2d34c, with latestmain3a94552828156ac2de594697f95f990006268ead as another control. Provider client, hosted auth fixture, exact task/evaluators/900second budget, benchmark runner, agent loop and browser spawn repo/handler are byte-identical. Existing env digests verified agents892f4393e0e2/backendf93cd450921b. This parity does not establish the origin of a historical upstream502 or a whole-task counterfactual.

Private evidence-only replay node /var/tmp/pr1662-93-email-otp-rca/replay-provider-response.cjs executes actual transpiled sendPrimitiveEmail/requestSignInCode modules from all three immutable revisions with fully intercepted fetch and a fake key. Simulated captured502 returns code_delivery_failed with no session on every revision; simulated200 returns code_sent only. The success control does not prove real delivery, authentication, completed task or repaired native outcome. No provider request or task retry occurred. Whole-task attribution stays UNKNOWN until occurrence-bound endpoint/response/configuration evidence or an appropriate causal comparator closes that gap.

Archive searches for literal Primitive send failed, code_delivery_failed, Primitive502 and HTTP502 found related auth-handoff and lost-response cases, but no proven same-boundary recurrence. The earlier intentional no-code fixture and native inbox-drain cases concern different first failures and are not grouped here. Independently saved member-discount j17 records two502 signup sends; that dependency evidence was delivered to its separate parent-designated owner. Its native subtotal1350vs1500/ACTIVE failure is not regraded or fully attributed by this case.

## Solution

Evidence-only investigation remains OPEN. No source/provider/production/environment change or task retry was authorized or performed. Preserve original FAILED status,900second task budget, task/evaluators and publication/cleanup receipts. Missing evidence is the historical effective email endpoint and occurrence-bound response origin/headers/cause sufficient to compare routing/configuration; conditional response replay alone cannot route a completed whole-check attribution or exception. No waived assertion, provider-outage or credit exception is established.

## Human feedback

The user-authorized deploy owner explicitly scoped this investigation to evidence collection, required an honest comparison against immutable main revisions, prohibited retries and changes, and retained the original failed task separately from infrastructure failures. No task criterion or timeout override was granted.

## Reusable lesson

Separate a native failed mail-send response from its downstream timeout and retain whole-task attribution as unknown when endpoint and historical provider causality are uncaptured.

## Same campaign member-discount occurrence

The independently retained browser-auth-member-discount-purchase job
r001-j0017 failed with `subtotalCents mismatch: expected 1350, got 1500 |
Agent status: ACTIVE (expected COMPLETED)`. Its saved backend log records
Primitive HTTP 502 at 00:42:31.293Z and 00:44:06.796Z, each immediately
followed by signup_verify code_delivery_failed. The account remained
unverified without a session; the recorded agent then chose guest checkout.
The payment approval quoted subtotal 1500, tax 124, shipping 499 and total
2123 cents. The unchanged validator rejected the subtotal before auto-approval
(one approval triggered, zero resolved); ACTIVE is an observed fail-fast
state, not a claimed timeout.

Actual TypeScript fixture controls on 4c6a06800, 93d2fbc22 and 3a9455282
reproduce the 502/no-session guest quote. Simulated accepted mail followed
by actual sign-up verification creates a member session and a quote of
1350/111/499/1960 cents. The actual Python validator rejects the native
guest quote and accepts that member control on each revision. These bounded
mechanism controls do not establish the historical effective upstream origin
or a full baseline task counterfactual. Whole-task attribution remains
UNKNOWN and the original native FAILED remains separate from the OTP timeout.
No service-wide outage, exhausted-credit exception, provider fix or task PASS
is claimed. The parent keeps both blocking failures and re-executes their
bound gates; no attribution is relabelled to obtain a waiver.

Independent j17 report SHA256:
66b0f768aed1c08ad4e3ee7f11249ec36738ddde4f90b963f6c107cd9e82a25c.

## Parent input-provenance follow-up

The existing guest Temporal serializer independently reconstructed both
recorded guest env digests exactly: agents892f4393e0e2 and backendf93cd450921b.
The reconstructed backend file contains no PRIMITIVE_BASE_URL override.
A paginated read through the native Render env helper confirmed that the
current authoritative Primitive key matches the local/reconstructed key,
and that production also uses the source-default endpoint. Values were
compared privately and never printed, committed or changed. This narrows
the file-level stale-key/routing hypothesis; it does not establish the
historical process environment, full upstream response origin or a whole-task
counterfactual. The original failures remain UNKNOWN and blocking.


## Next-execution provenance instrumentation

The provider now captures its actual send-mail URL once and, on the existing
non-OK response path, logs only the parsed `URL.origin`. URL userinfo, path,
query and fragment are excluded; invalid metadata is ignored without changing
the existing `false` send result. The registered Primitive blackbox control
covers a fake 502, redaction, an environment change during fetch, one request
only and an invalid URL. This is observation hardening, not a repair claim:
the two original native failures and whole-task UNKNOWN attribution remain.
A new unchanged task execution must supply the next result.


## c492 recurrence: occurrence-bound external service qualification

The later unchanged tasks retained their original failures: OTP agent
3a51a2f8-6915-4dc9-b1e9-8a57feb3d525 timed out at the original900-second
budget; member agentdf42da90-be6b-4769-a9e0-8243d4090fa5 failed
subtotal1350-vs1500 before approval. All four native mail-send errors now
recorded requestOrigin=https://api.primitive.dev, at03:46:11.883,
03:48:03.582,03:57:40.494 and03:59:25.392 UTC. The unchanged documented
request construction and the actual guest input-construction chain exclude
an inherited Primitive key or full-base override: saved donor configuration,
image ENV, boot environment, shared secret names and both guest script hashes
lead to the verified serialized backend blob. No raw credential was exposed.
A read-only ordinary-client probe with that same credential returned200,
data.ready=true and the sendable sender domain at04:16:57 UTC. A separate
Python-client Cloudflare1010 response was preserved as a client-signature
refusal, not misclassified as credential rejection.

This closes the new occurrence's configuration gap. Gate: NOT_INTRODUCED for
the observed external outbound-mail operation failure. The controlling policy
qualifies these exact two failed checks as external-provider warnings, never
PASS, without claiming a service-wide outage, internal upstream root cause
or that the full task would succeed if delivery were available. Earlier
historical whole-task gaps remain unchanged. No source/provider change, send
retry, budget or price-assertion change was used to obtain this disposition.

Immutable closure packet SHA256:
9c677fbd2343a5cfe739f9cf8ae4da1a4936d29ca06a2cffe6ec2f8894b05a45.
Native OTP artifact SHA2562e3abef8aa76e9704e4b0ed519215c821428fe0f8080c9369e4fd9034c7dd316;
native member artifact SHA2567d92d31d24d41cb799fe769a44f3d4f4a04d6933c3f3dc71d52d8c3f15c3aaa0.
