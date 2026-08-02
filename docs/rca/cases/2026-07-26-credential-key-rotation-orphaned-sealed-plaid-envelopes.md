---
id: 2026-07-26-credential-key-rotation-orphaned-sealed-plaid-envelopes
date: 2026-07-26
title: Rotating `CLAUDE_CREDENTIAL_DECRYPTION_KEY` permanently orphaned 41 of 46 prod Plaid access-token envelopes
surface: back-end
component: plaid-credentials
classification: configuration-error
problem_class: other
first_bad_boundary: back-end/src/providers/plaidCredentials.ts getPlaidAccessTokenPublicKeyPem() — envelopes are RSA-OAEP sealed under a key derived from CLAUDE_CREDENTIAL_DECRYPTION_KEY, which was rotated after the items were linked
symptoms:
  - "SYNC_FAILED :: Failed to decrypt Plaid access-token envelope"
  - "error:02000079 rsa routines::oaep decoding error"
  - zero ACTIVE PlaidItems in prod (36 ERROR + 10 DISCONNECTED)
tags:
  - plaid
  - encryption
  - key-rotation
  - credentials
  - data-loss
sources:
  - memory:project_plaid_key_rotation_orphaned_items
repro: none-recorded
status: wontfix
---

## Problem

A prod Plaid audit on 2026-07-26 found zero ACTIVE `PlaidItem` rows: 36 in ERROR
and 10 DISCONNECTED. 41 of 46 items failed with
`SYNC_FAILED :: Failed to decrypt Plaid access-token envelope`, underneath which
OpenSSL reported `error:02000079 rsa routines::oaep decoding error`. Only items
created on or after 2026-07-02 decrypted at all.

## Diagnosis

`encryptedAccessToken` envelopes are RSA-OAEP sealed under a public key _derived
from_ `CLAUDE_CREDENTIAL_DECRYPTION_KEY`
(`back-end/src/providers/plaidCredentials.ts`,
`getPlaidAccessTokenPublicKeyPem()`). That key was rotated after those items were
linked, so the private half that could open the older envelopes no longer exists
anywhere. The plaintext Plaid access tokens are gone; no code fix recovers them,
and affected users must re-link. The deeper owned cause is a rotation procedure
for a key that is simultaneously an _encryption_ key for at-rest data: rotating it
is a destructive migration of every sealed row, but nothing in the process
re-wrapped existing envelopes or refused the rotation while unre-wrapped rows
existed.

## Solution

The orphaned items are unrecoverable and were classified as such — affected users
must re-link their institutions. The durable requirement this exposes: any
rotation of a key that seals at-rest data must re-wrap existing envelopes under
the new key (or keep the old private key available for decrypt-only) before the
old key is discarded. Re-audit recipe: query `PlaidItem` grouped by
`status`/`errorCode` and probe decryptability by calling
`decryptPlaidAccessToken` with the Render key — the local `back-end/.env` does not
carry `CLAUDE_CREDENTIAL_DECRYPTION_KEY`.

## Human feedback

None recorded.

## Reusable lesson

Treat any key that seals at-rest data as un-rotatable until existing envelopes are
re-wrapped — rotating it is silent, permanent data loss that only surfaces on the
next decrypt.
