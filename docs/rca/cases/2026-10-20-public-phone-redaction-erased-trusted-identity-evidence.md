---
id: 2026-10-20-public-phone-redaction-erased-trusted-identity-evidence
date: 2026-10-20
title: Public phone redaction erased configured identity evidence needed by internal verification
surface: back-end
component: iphone-private-observation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: finishCommand persisted the lossy public projection before trusted internal account binding
symptoms:
  - credentials.fill_saved returned FAILED after USER entered the configured account identifier
  - Fresh screen.text identity became [private] before savedBinding and setupEvidence
tags:
  - phone
  - privacy
  - credentials
sources:
  - agent bc631ecd-8f7e-42af-8535-ada845f01047
  - task connected-password boot validation
repro: back-end/src/tests/blackbox/iphone-control.identity-binding.cases.ts
status: fixed
---

## Problem

USER input.text correctly remembers submitted values durably. When that value is
the configured account identifier, subsequent public OCR must mask it. Applying
that same lossy projection before encrypted persistence also prevented trusted
saved-password and setup verifiers from seeing the identifier already supplied
to them separately by server configuration. This does not mean the saved
password was wrong. Integrated live follow-through remains parent-owned.

## Diagnosis

Archive searches were `configured identifier private saved binding` and
`vault redaction phone account masking`. Read the related saved-password runtime
contracts and unregistered private-input disclosure cases plus process-feedback.
This is a distinct internal/public projection boundary, not recurrence of wrong
key/pricing or raw public disclosure; those protections must remain intact.

Hypothesis — What: account binding loses a configured identifier. Where:
finishCommand masks before sealing; savedBinding/setupEvidence repeat public
masking. Why: one public projection served consumers with different authority.
Proof: the unchanged normal-route regression failed 86/87 before the fix and
passed 87/87 afterward while public identity/password masking assertions stayed.

```text
USER text -> encrypted private vault -> handback (vault retained)
provider AGENT screen.text -> bounded internal projection -> encrypted receipt
  -> public receipt/status: full privateResult masking
  -> savedBinding/setupEvidence: configured-identity projection only
```

## Solution

Preserve exact current server-configured nonsecret account identifiers only in
successful AGENT screen.text internal projection, with privacy inactive. Omit
only exact matching vault values; other secrets, longer values and substrings
still mask conservatively. Use the same bounded helper for encrypted storage and
the two trusted internal consumers. Public serialization remains unchanged;
message verification retains its public-mask boundary. No vault mutation, raw
OCR duplicate, caller override, placeholder restoration, schema or prompt edit.
Historical already-masked receipts require a fresh observation.

## Verification

Normal isolated runner: `bash scripts/run-blackbox-tests.sh iphone-control`.
Red run1792466830-2435886-16144: 86/87; green run1792466911-2455764-10224:
87/87. Registered case exercises USER identifier/password input, handback,
public status masking, saved fill and Gmail setup verification with fresh actual
stored fake-provider OCR. Provider ownership tests cover active phase, USER,
non-success/non-text, historical masking, overlaps and unchanged durable vault.
Provider units 93/93; layers1679/1679; build, scoped ESLint, format and diff check
pass. Final unchanged eight-domain run1792467010-2480291-12974: 8/8 domains.
Logs and exact source hashes are in
`.context/phone-harness/identity-binding-backend-full-result.json`.
Parent independently reviewed helper and three internal paths. Parent reports
canonical synthetic AppStore controls passed; this worker made no model/provider
or live calls. All work used isolated local normal fixtures, not the pilot.

Limits: an exact identifier/password literal collision reveals no literal beyond
what the trusted verifier already receives as configured identity, but this is
not an unknown-secret guarantee. Other overlaps can intentionally refuse binding.
No cloud typing-mode claim or speculative keystrokes change was made. Cached
clipboard advice belongs to macOS mirroring and does not prove cloud secure-field
behavior. No new generic-app support is claimed. The local boundary repair is
verified; deployment and live autonomous boot completion are not claimed.

Independent review found that non-Gmail setup calls separately supply only the
Apple identity to their verifier. The owning route assertion reproduced the
broader internal projection in run 1792467181-2520651-17583: `Non-Gmail verifier
received the privately entered Google identifier`. Setup evidence now preserves
Google only for the Gmail target, while saved-credential binding retains both
configured identities supplied to its verifier. The identical normal control
command passes 87/87 in run 1792467254-2540266-1798
(`identity-target-scope-green.log`); build, scoped lint and formatting pass.
The redundant concurrent worker run is excluded from proof. No public leak was
observed at this followup boundary.

At 10,000 agents this adds no query, subscription or shared fan-in: projection
uses the already-loaded device profile and the existing bounded 64-value,
16-KiB vault. Existing traversal limits and per-device serialization remain.

## Human feedback

The user required boot to use available saved passwords automatically. Freedom
must remain untouched. Technical reviews from parent agents are review evidence,
not additional human feedback.

## Reusable lesson

Separate public lossy privacy projection from narrowly authorized internal evidence without restoring arbitrary secrets.
