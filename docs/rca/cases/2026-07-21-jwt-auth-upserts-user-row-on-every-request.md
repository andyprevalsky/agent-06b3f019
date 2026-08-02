---
id: 2026-07-21-jwt-auth-upserts-user-row-on-every-request
date: 2026-07-21
title: JWT auth upserted the same User row on every request, serializing concurrent authenticated requests
surface: back-end
component: auth-middleware
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: JWT authentication path — an unconditional `User.upsert` write on every authenticated request
symptoms:
  - repeated stalls on authenticated requests for a single user
  - concurrent requests for the same user serialize behind one row write
tags:
  - jwt
  - auth
  - prisma
  - row-lock
  - write-amplification
  - concurrency
sources:
  - PR #837
repro: back-end structural coverage for hybrid authentication and user sync
status: fixed
---

## Problem

Authenticated requests stalled repeatedly for a single signed-in user. Every JWT
request performed a `User.upsert`, so concurrent requests for that user queued behind
writes to the same row rather than proceeding in parallel.

## Diagnosis

The auth middleware treated "sync the user record" as something to do on every
request instead of only when the record actually needs to change. That turns a
read-mostly hot path into a write on a single row keyed by user, and row-level write
contention then serializes all of that user's in-flight requests. This is a
fan-in-per-user pattern: cost grows with the concurrency a single user drives, so the
more parallel work a user has, the worse each request gets — the opposite of the
required per-request isolation at 10k agents.

## Solution

JWT authentication is now read-only for existing users. A write happens only for
first-user creation or an actual phone-number change, with race-safe first-creator
semantics so two concurrent first requests cannot both create. Structural coverage
for hybrid authentication and user synchronization was expanded to cement the
read-only invariant, and the gate suite recorded the change with backend structural
971/971 and 94/94 blackbox domains passing.

## Human feedback

None recorded.

## Reusable lesson

Never write on a read-mostly auth hot path — make user synchronization conditional on
an actual change, or every concurrent request for one user serializes on that row.
