---
id: 2026-07-18-hs256-only-jwt-verification-rejects-supabase-es256
date: 2026-07-18
title: Auth middlewares verified HS256 only, so Supabase's asymmetric ES256 access tokens were rejected with 401
surface: back-end
component: auth-middleware
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end auth middlewares — `algorithms: ['HS256']` with the shared SUPABASE_JWT_SECRET, no ES256/JWKS path
symptoms:
  - 401 on authenticated requests using a token from Supabase signInWithPassword
  - "isFullySignedIn:false" in the ratchet browser session
  - zero realtime bubbles and a red chat-lifecycle-ratchet gate
tags:
  - jwt
  - supabase
  - es256
  - jwks
  - auth
  - prod-gate
sources:
  - PR #786
repro: back-end supabase-jwt-verify unit suite
status: fixed
---

## Problem

The prod `chat-lifecycle-ratchet` gate was red: the browser session stayed
`isFullySignedIn:false`, produced zero realtime bubbles, and the backend returned
401 for its authenticated requests. Reproduced against prod: a real ratchet token
obtained via Supabase `signInWithPassword` was rejected, while a backend-minted
token was accepted.

## Diagnosis

Both auth middlewares verified tokens with `algorithms: ['HS256']` against the
shared `SUPABASE_JWT_SECRET` and nothing else. Supabase had migrated to asymmetric
(ES256) JWT signing keys, so a direct Supabase client login now returns an ES256
token that an HS256-only verifier cannot validate — 401 by construction.

Real users never saw it because the backend mints its own HS256 tokens after
phone-OTP, which masked the defect: the bug was latent for _any_ Supabase-client
login and would have become universal the moment Supabase deprecated the shared
secret. The gate was the first consumer of the Supabase-client login path, which is
why a test surfaced a real production auth limitation.

## Solution

`providers/supabaseJwt.ts` `verifySupabaseAccessToken` now branches on the token's
`alg`: HS256 keeps the shared-secret path (unchanged for backend-minted tokens),
ES256 verifies against the project JWKS via `jose`. Both branches enforce issuer
and expiry. It is wired into `hybridAuth.ts` and `auth.ts` (both now async), and the
duplicated HS256-only helpers were removed so there is a single verification
entry point. Verified against prod: real ES256 ratchet token accepted, backend
HS256 still accepted, garbage rejected. New hermetic unit coverage (7/7) exercises
ES256 via a local JWKS plus HS256.

## Human feedback

None recorded.

## Reusable lesson

Verify JWTs by branching on the token's declared algorithm against the issuer's
published keys — hard-coding a single symmetric algorithm makes any provider key
migration an instant 401 outage.
