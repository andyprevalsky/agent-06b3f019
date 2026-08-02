---
id: 2026-07-10-gate-cta-opened-a-pre-minted-stale-oauth-url
date: 2026-07-10
title: The Connect-Gmail gate CTA opened a pre-minted OAuth URL with a stale state and a benchmark-internal redirect_uri
surface: front-end
component: gate-cards
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: gate CTA — window.open of an authUrl minted at gate-creation time instead of starting a fresh OAuth flow at click time
symptoms:
  - '"Invalid link" when clicking Connect Gmail on a gate card'
  - "OAuth redirect_uri points at localhost:61100 from a benchmark run"
  - stale OAuth `state` rejected on callback
tags:
  - front-end
  - oauth
  - gmail
  - gate
  - deep-link
sources:
  - memory:project_gate_benchmarks_fe_verification
  - PR #755
repro: front-end/src/tests/blackbox/gate-connect.blackbox.ts
status: fixed
---

## Problem

Clicking "Connect Gmail" on a `source_connect` gate card produced an **"Invalid
link"** error. The URL being opened carried a stale OAuth `state` and a
benchmark-internal `redirect_uri` of `localhost:61100`.

## Diagnosis

The gate CTA did `window.open` on an `authUrl` that had been **pre-minted** when
the gate was created. OAuth URLs are not durable artifacts: the `state` expires and
the `redirect_uri` is baked from whatever host minted it — in a benchmark run, the
box's localhost. So the link was guaranteed to be wrong by the time a human
clicked it, and worse in benchmarks than in prod. A related defect from the same
review: `sourceStatus` was pre-minting a throwaway Gmail `EmailCredential` on every
probe, so the pre-mint pattern was generating garbage as well as bad links.

## Solution

Added a shared
`terminal-component-group/.../attention-inbox/gateConnect.ts` exposing
`runGateConnectAction(gate, { requestId, agentId })`, wired into all three gate
render sites (`GateStack` — extracted to `terminal/components/GateStack.tsx` —
plus `GateMessageWrapper` and `RequestListItem`). Behavior by source:
gmail/email start a **fresh** `startGmailOAuthApi(returnUrl)` (same path as the
integrations `useGmailConnect`; Mac app via `window.api.openExternal`, web via
`location.assign`); imessage/sms/whatsapp/telegram deep-link
`roselabs://connect-source?source=&gateId=&agentId=`; subscription/kyc keep
`window.open` because Stripe/KYC links are fresh and stable. `openExternal` was
added to the `MacAppBridge` type, and `sourceStatus` stopped pre-minting the
throwaway credential (the FE re-mints on click). Tests:
`front-end/src/tests/blackbox/gate-connect.blackbox.ts` (5 cases).

## Human feedback

None recorded.

## Reusable lesson

Never persist a pre-minted OAuth URL in a UI payload — mint the authorization URL
at click time, from the host the user is actually on.
