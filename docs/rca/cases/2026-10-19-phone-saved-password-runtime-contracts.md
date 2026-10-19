---
id: 2026-10-19-phone-saved-password-runtime-contracts
date: 2026-10-19
title: Saved phone passwords used the wrong credential key and omitted funded model pricing
surface: back-end
component: iphone-saved-credential
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Saved credential selection used the Claude integration key while phone verification omitted the existing Foundry user-pricing policy
symptoms:
  - A real Apple password form returned phone_credential_binding_required before typing
  - Production browser password envelopes failed RSA decryption with the selected key
tags:
  - phone
  - credentials
  - pricing
sources:
  - agent bc631ecd-8f7e-42af-8535-ada845f01047
  - task saved cloud iPhone password branch
repro: back-end/src/tests/blackbox/iphone-control.saved-credential.cases.ts
status: fixed
---

## Problem

The first real saved-password pilot reached the configured Apple Account form,
but its protected fill returned a binding error without submitting a password.
The browser password catalog was present. The pilot used an isolated persistent
database containing encrypted copies of the owning production user's catalog;
it did not modify production credentials.

## Diagnosis

Archive searches were `phone credential Foundry pricing OAEP` and
`saved password wrong decryption key Foundry model price`. Related phone history
and credential rotation cases were leads, not reproductions of this boundary.

The path is current broker observation -> fixed-purpose form verifier -> usage
pricing -> owner-scoped BrowserPassword selection -> decryption -> atomic private
input admission -> physical tap/type. At 00:10:44 UTC the actual verifier finished
on `gpt-5.6-luna-foundry`; the next pricing lookup returned no entry. The enclosing
catch incorrectly described this infrastructure failure as a form-binding error.
No physical password operation was admitted.

A separate backend-only availability probe against the copied production catalog
failed RSA-OAEP decryption with `CLAUDE_CREDENTIAL_DECRYPTION_KEY`. The same selector
returned usable=true with the browser store's `PAYMENT_DECRYPTION_KEY`, without
returning plaintext to the operator or model. The frontend encryption contract
and existing browser credential runtime identify that second key as the correct
one. No key was rotated and no ciphertext was rewritten. Synthetic tests had
encrypted fixtures with the same incorrect key the implementation selected.

The existing Python pricing policy charges zero user-facing token cost for
Foundry while retaining the actual model and usage. That policy is distinct from
Azure's expense to Rose; a zero user charge must not be presented as zero provider
cost.

After those repairs, the real verifier returned `allowed=false` for the visible
Apple Account sign-in form with the exact configured identifier and a Password
field. The captured request finished normally; this was not a transport failure.
The purpose did not clearly distinguish permission to fill an existing form from
proof of completed sign-in. The former necessarily accepts an identifier in an
editable sign-in field; the latter correctly does not.

## Solution

The selector now uses `PAYMENT_DECRYPTION_KEY`, preserving the existing browser
store contract. Both phone verifiers share a phone-scoped pricing helper that
applies the established Foundry user-pricing policy and retains actual model and
token usage. Verifier, pricing and billing failures have the distinct sanitized
`phone_credential_verifier_unavailable` code. Form/account binding is unchanged;
no credential from another account is substituted. Default-off eligibility is
unchanged. Full iCloud setup still awaits the separate other-device passcode step.

The credential verifier's fixed purpose now explicitly makes that distinction,
permits an empty or unfocused existing-password field, and retains the wrong
account, signup, other-app and verification-code exclusions. A stronger native
app-attestation boundary was considered; the provider exposes no such primitive.
The accepted boundary remains semantic verification of actual broker observations,
not cryptographic app attestation or a hard-coded OCR keyword classifier.

## Verification

Live evidence is retained privately under `.context/phone-harness/`. The public
progress receipt `saved-password-live-progress.json` contains identifiers and
booleans only.

The normal owning command `bash scripts/run-blackbox-tests.sh iphone-control`
failed 63/65 in run `1792368780-1448270-28264` with independently generated valid
browser and Claude keys (`saved-payment-key-red.log`). The unchanged assertions
pass after selecting the browser key. The final seven-domain command is
`bash scripts/run-blackbox-tests.sh iphone-control,auth-assistance,iphone,iphone-interactions,iphone-rls,phone-harness-capture,attention-requests`.
Run `1792368841-1459632-26497` passes all seven domains, including 66 control cases,
37 authentication cases, 30 queue cases, 13 interaction cases and 32 RLS probes.

The actual canonical verifier wrapper command
`node --experimental-test-module-mocks --import tsx src/tests/unit/phone-harness-client.test.ts`
failed 79/81 before the pricing fix and passed 81/81 after it. The two failures
covered saved-credential verification and setup verification with actual Foundry
model identifiers. Logs are `foundry-pricing-red.log` and
`foundry-pricing-green.log`. Build, scoped lint/format, and 1662 architecture
assertions pass. No production pricing table or unrelated model path changed.

The captured-form canonical model control rejected the valid form before the
purpose clarification (`credential-semantic-before.log`). After clarification,
the same positive form passed and wrong-account, OTP, other-app and signup
controls were all rejected. An explicitly local rerun independently passed the
same five controls (`credential-semantic-local-after.log`). The initial standalone
control accidentally inherited nonlocal database configuration; that separate
isolation incident is recorded in
`2026-10-19-semantic-control-dotenv-used-shared-provider-state` and is not hidden
by the successful form test.

The sanitized captured form, four negative inputs and their recorded canonical
responses are preserved in
`back-end/src/tests/unit/phone-saved-credential.semantic-fixture.json`. The normal
provider test entrypoint loads those cases and verifies exact input forwarding
and output parsing. This recorded replay supplements the executed real-model
controls; it is not represented as a fresh model classification on every run.

Actual cloud operation `44fac800-98d3-42f8-8b45-1a9eb12c0c2d` returned the private
filled acknowledgement. After submission, actual observation
`9a961a00-a03b-427c-8754-fa351f90092b` showed Apple's verification-code screen.
The user's supplied verification code was subsequently accepted and the phone
advanced to the other-iPhone passcode step for protected iCloud data. This was an
operator-assisted live broker check after the root planner was paused, not a
claim of a fully autonomous end-to-end agent pass or completed iCloud sync.

The live secrecy audit found zero exact password matches in 36 log/model-dump
files and 78 persisted messages (`password-secrecy-live-proof.json`). Secrets
remain in encrypted storage; this does not promise protection against arbitrary
transformed or partial secret strings.

Successful tap receipts alone do not establish field focus. A separate harmless
back-button tap changed the actual screen, confirming the documented coordinate
space; no coordinate scaling workaround was introduced.

## Human feedback

The user requested that production phone setup use the passwords already synced
for the browser agent and explicitly asked to complete the saved-password branch.

## Reusable lesson

Reuse the existing credential encryption and actual-provider pricing contracts,
and test them with deliberately distinct keys and real provider identifiers.
