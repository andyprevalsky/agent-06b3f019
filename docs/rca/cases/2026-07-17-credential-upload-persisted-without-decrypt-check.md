---
id: 2026-07-17-credential-upload-persisted-without-decrypt-check
date: 2026-07-17
title: Credential upload stored client ciphertext without verifying it decrypts, silently degrading users to the paid waterfall
surface: back-end
component: integrations-credentials
classification: our-bug
problem_class: other
first_bad_boundary: the claude/gpt credential upload routes persisted the client-supplied envelope without round-tripping a decrypt against the server key
symptoms:
  - "oaep/parse decrypt errors flooding logs with no key rotation having occurred"
  - affected users' chat silently falls back to the paid OpenRouter waterfall
  - "CONNECTED integration rows whose ciphertext cannot be decrypted (10 claude_code rows in prod)"
tags:
  - credentials
  - encryption
  - integrations
  - claude-token
  - validate-at-write
sources:
  - PR #783
repro: back-end/src/tests/blackbox/integrations.blackbox.ts
status: fixed
---

## Problem

Logs showed a flood of `oaep/parse` decrypt failures with no key rotation to
explain them. The users behind those rows had `CONNECTED` integrations whose stored
ciphertext could not be decrypted, so their chat silently degraded to the paid
waterfall instead of using their own credential. In prod, 10 `claude_code` rows were
undecryptable; after cleanup, CONNECTED was 11/11 decryptable.

## Diagnosis

The credential-upload path accepted the client's ciphertext and persisted it
**without verifying it decrypts with the server key**. A client whose keypair did
not match the server's therefore inserted garbage that the database happily marked
CONNECTED — the write succeeded, the failure was deferred to every later read, and
the per-user decrypt failure was logged without naming the user or integration, so
the flood looked like a global key problem rather than a set of specific bad rows.
Nothing at the write boundary asserted the invariant that a stored envelope must be
readable by the server that stored it.

## Solution

`verifyCredentialEnvelopeDecryptable()` round-trips the envelope against the server
key before persist; the claude and gpt upload routes now return **400 "Invalid
credential envelope"** instead of storing unreadable ciphertext. Per-user decrypt
failures now name the user and integration, so a future flood is attributable
instead of ambiguous. Undecryptable stored rows are quarantined
(`SYNC_FAILED`) and no longer produce an access token; the 10 bad prod rows were
cleaned. Regression: an `integrations.blackbox` reject-undecryptable test — which
also exposed two existing happy-path tests that had themselves been uploading
garbage strings.

## Human feedback

This PR amended `docs/root-cause-analysis.md` to state that adding observability is
never the stopping point (log, then keep going deeper) — the record presents that
as a constraint on this RCA, i.e. naming the user/integration in the log was not
accepted as the fix.

## Reusable lesson

Validate at the write boundary that stored ciphertext can be decrypted by the key
that will later read it — otherwise every bad write becomes an undiagnosable read-time
flood, and a "decrypt failure" without a key rotation means bad rows, not a bad key.
