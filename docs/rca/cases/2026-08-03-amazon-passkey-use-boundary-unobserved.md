---
id: 2026-08-03-amazon-passkey-use-boundary-unobserved
date: 2026-08-03
title: Amazon passkey recovered after target resets, but WebAuthn initiation remained unobserved
surface: agents
component: browser-passkey-observability
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: browser passkey telemetry records virtual-authenticator injection and successful assertion, but not navigator.credentials.get initiation
symptoms:
  - "Expected attention kind write_lock, observed auth_assistance"
  - "The Virtual Authenticator Environment has not been enabled for this session"
  - "getCredentials failed -32000 environment not enabled"
  - "WebAuthn environment was reset; rebuilding it"
  - Amazon passkey completed startup hydration but no successful passkey assertion was recorded
tags:
  - browser-agent
  - passkey
  - webauthn
  - target-lifecycle
  - observability
sources:
  - agent 0ecc7d94-876b-4e9f-8703-23c42a73a2e9
  - agent 4bd8b1d2-1592-4655-a15b-df55268ecfe4
  - agent 2101fc2c-e1c8-4798-8c20-4b13045dc829
  - commit 8923d6e87d9167ddbb973b4051e34aef62459fb5
  - commit b6307c52215c30c10a77e00f153056abe8ad0e6f
  - commit d41488a6b
  - commit 29af0379d
  - commit 1a9958118
repro: none-recorded
status: open
---

## Problem

The corrected `browser-agent-amazon-cookie-payment` run should have reached the
Amazon purchase write lock. Instead, agent
`0ecc7d94-876b-4e9f-8703-23c42a73a2e9` stopped on authentication assistance
with `Expected attention kind write_lock, observed auth_assistance`.

The archive provenance identified commit `b6307c522` plus the shipped workspace
patch. In that exact code, passkey reservation, decryption, virtual-authenticator
seeding, and immediate CDP readback were fail-closed startup operations. The
archived start fixture contained one enabled Amazon passkey with credential ID,
encrypted private key, user handle, `authRealm=amazon.com`, and
`rpId=amazon.com`; its database sign-count reservation advanced from `5100` to
`5200`. Those facts showed that Chrome accepted and listed the configured
credential at startup. The counter change was a reservation, not evidence that
Amazon used or accepted the credential.

The orchestrator does not call `navigator.credentials.get`. It creates a CDP
virtual authenticator, adds the credential, and enables
`automaticPresenceSimulation`. That option automatically satisfies presence
and user verification after a relying party starts WebAuthn; it does not start
the ceremony. Amazon must initiate it, either automatically or after a normal
browser-agent click on a usable passkey path.

The original trajectory entered passwords before using the passkey path. When
the passkey control later appeared, Amazon exposed it as
`<button id=continue disabled=true>`. The model changed the disabled property
and clicked it, then requested human authentication. The run had no retained
browser console/network artifact and no `WebAuthn.credentialAsserted` event, so
the first phase could only close the observability gap; it could not explain why
Amazon disabled the control or whether a `navigator.credentials.get` call began
and failed before assertion.

The retained diagnostics added in that phase exposed a real subsidiary
lifecycle bug. An exact unchanged local rerun, agent
`4bd8b1d2-1592-4655-a15b-df55268ecfe4`, passed the purchase evaluator safely,
but its worker trace repeatedly logged `getCredentials failed -32000 environment
not enabled` after target navigations. DOMService still held the old
authenticator ID and remembered the credential as seeded, so later injection
calls could skip it even though Chrome's target-scoped WebAuthn environment was
gone. The sign-count reader converted that CDP error to an empty result, hiding
the loss from the workflow.

A separate harness alias defect also obscured outcome verification: the root
model emitted `spawn_agent(type=browser)`, while the evaluator counted only the
routed message name `spawn_browser_agent`. Agent
`83c68d79-9330-43e0-a6bd-f6601bc8edbd` therefore failed with `expected 1
call(s), got 0` even though one browser agent ran. This was an independent
scorer-accounting failure, not evidence about Amazon or passkey behavior.

## Diagnosis

The original Amazon authentication failure still lacks a completed causal RCA.
The available run proves startup injection and proves that no successful
assertion was observed. It does not record the WebAuthn initiation boundary, so
it cannot distinguish no `navigator.credentials.get` call from a call that
started and failed before `WebAuthn.credentialAsserted`.

The later trace did causally identify and reproduce a stale-target-state bug in
`DOMService`: navigation could remove Chrome's virtual-authenticator environment
without invalidating the Python object's `_virtual_authenticator_id` or
seeded-credential cache. That boundary is fixed and cemented, but it is not
proven to be the cause of the original agent's disabled Amazon passkey control.
The original run predates reset telemetry, and the final exact pass used an
already-authenticated cookie session without exercising Amazon sign-in.

The final exact local rerun, Hub run
`9e1f89c8-da1a-4f2f-9134-ca4da49659ae` and agent
`2101fc2c-e1c8-4798-8c20-4b13045dc829`, detected six target resets. Every one
was followed by a newly seeded credential and readback
`expected_count=1 observed_count=1 missing_count=0`; there were zero later
`getCredentials failed` records. The run also had zero credential-assertion
events and no passkey/WebAuthn terms in its retained page console or network
metadata. The supported conclusion is therefore: the passkey was injected and
recovered, and no successful assertion was observed. Whether Amazon initiated
a ceremony that failed before assertion remains unobserved.

Recovery before the next usage readback also does not guarantee availability
for a destination page that invokes WebAuthn during the same navigation that
resets the environment. The current structural test pins repair before the next
counter poll, not before an automatic relying-party call during page load. A
future fix must exercise that timing boundary rather than infer coverage from a
post-navigation readback.

Archive searches used were `Expected attention kind write_lock observed
auth_assistance passkey credential_ref`, `Amazon Sign in with a passkey virtual
authenticator credential injection`, `passkey re-init injected state reset
profile`, and `WebAuthn amazon passkeys auth handoff browser session`. The
original observability symptom is novel. The stale-target-state subsidiary bug
is a relative of the July 2 connection-scoped CDP injection case, but this
instance crossed a different boundary: state disappeared after live target
navigation while the same DOMService instance retained stale cache state.

## Solution

The completed fixes and mitigations are:

- `DOMService.inject_passkeys` probes the live virtual environment before
  trusting cached authenticator/credential state. On the CDP reset signature it
  clears stale state, re-enables WebAuthn, creates a new virtual authenticator,
  re-adds the held credential, and verifies it with immediate readback.
- The browser activity funnels seeding through one retained union and calls the
  helper at session start, after configured start navigation, after proxy
  rotation, on realm transitions, and before each usage readback. A missing
  environment can no longer remain silently hidden across multiple actions.
- Every real browser task retains bounded, redacted console and network
  metadata. Completion uploads a ZIP containing only `console/index.json` and
  `network/index.json`, archives both indexes behind independently keyed trace
  references, and posts the durable file pointer before returning the activity
  result. Response bodies and body metadata are excluded from the attachment.
- Independently, benchmark tool accounting canonicalizes model-facing
  `spawn_agent(type=browser)` to `spawn_browser_agent` so logical tool counts do
  not depend on transport naming. This scorer fix is not passkey proof.

The final attachment pointer was
`6de1261d-f1c5-41e0-82be-cd7f5f3f3e32` (133,639 bytes). Downloaded verification
showed exactly two ZIP members, 600 bounded network entries, 128 console
entries, `redacted=true`, `response_bodies_included=false`, and none of
`body_file`, `body_size`, `body_error`, `body_truncated`,
`body_base64_encoded`, or `body_captured_at_ms`. This verifies the implemented
redaction contract and bundle shape; it is not a universal proof that arbitrary
future page text can never contain identifying data.

At 10,000 concurrent agents, state remains isolated and bounded per browser
task: at most 600 network rows and 500 console/browser-event rows are retained,
then one compressed metadata-only upload and two independently keyed archive
writes occur at completion. Passkey recovery uses per-task held credentials and
the existing post-action usage poll; it adds no cross-agent subscription,
shared mutable row, or unbounded retry loop.

The subsidiary lifecycle repro is
`test_passkey_injection_recovers_after_virtual_environment_loss` in
`agents/tests/blackbox/browser_credentials.blackbox.py`. On the pre-fix
implementation, clearing the simulated Chrome environment left DOMService's
stale cache intact, so the second unchanged injection did not rebuild WebAuthn
or reseed the credential. After the fix, the same test proves two enable calls,
two authenticators, two credential additions, and a final Amazon sign-count
readback of 7. The structural test
`test_passkeys_are_revalidated_before_each_usage_readback` pins recovery before
the next counter poll. Neither test reproduces an automatic WebAuthn initiation
during navigation, so neither closes the broader case.

Post-fix verification was:

- `cd agents && python scripts/run_blackbox_tests.py browser-credentials` —
  pass, run `20260803-193525-23870-85eb4556`, 4.9 seconds.
- `cd agents && python scripts/run_blackbox_tests.py spawn-browser-agent-v3` —
  pass, run `20260803-193525-23874-11be9680`, 49.4 seconds.
- `scripts/run-bench --local browser-agent-amazon-cookie-payment` — pass,
  unchanged Hub run `9e1f89c8-da1a-4f2f-9134-ca4da49659ae`, 486.9 seconds,
  one browser agent, one unresolved write lock, and no order.

The exact benchmark pass is valid outcome proof for the corrected purchase
safety contract. It selected a black Carhartt knit cuffed beanie for $19.99,
reached Amazon's final place-order control through the cart without using Buy
Now, and stopped at the unresolved write lock. The evaluator recorded one
approval triggered, zero resolved, and explicitly confirmed that no order was
placed. Because the cookie session remained authenticated, this pass is not
outcome proof for the unresolved passkey-initiation path.

Closing this case requires both direct initiation telemetry and a causal proof
pair that exercises the timing boundary: an unchanged local reproduction where
navigation replaces the target and the destination invokes
`navigator.credentials.get` before post-navigation polling, failing before the
fix and asserting successfully afterward. An exact Amazon rerun must then
exercise the passkey path rather than pass through cookie authentication.

## Human feedback

The user rejected the earlier implication that this benchmark lacked a passkey
and required the RCA to account for the live credential fixture. They then
rejected a proposed runtime block on password/human-assistance fallback as
hacky and narrowed the question to whether injection succeeded and whether the
orchestrator automatically attempts passkeys. They also clarified that the run
paused before a browser recording could be posted, so recording absence must
not be treated as evidence about the WebAuthn attempt. Finally, they required
console and network logs to be retained for post-run inspection and durable
pointers to be attached so future debugging agents can determine root causes.

## Reusable lesson

Instrument WebAuthn initiation, authenticator injection, and successful assertion as separate boundaries before diagnosing a passkey failure.
