---
id: 2026-10-29-bu072-cdp-tls-hostname-validation-failed
date: 2026-10-29
title: BU072 browser initialization rejected a CDP certificate hostname mismatch
surface: infra
component: tilion-session-initialization
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: CDP TLS validation for east.back.tilion.dev received certificate SANs for smartling domains; exact origin of endpoint or certificate mismatch is unrecorded
symptoms:
  - "Hostname/IP does not match certificate's altnames"
  - "Browser initialization failed before readiness"
  - "Native browser task did not complete successfully"
tags:
  - polar
  - bu072
  - tilion
  - tls
sources:
  - commit d1b1062cfd420832467d4e2b7e10c770a0318157
  - agent ff050c96-933a-47b9-a45e-4e7460fc4fcd
  - plan:.context/r65/tls-proof.json
repro: none-recorded
status: open
---

## Problem

It19 BU072 r2 nativeFAILED63.2s, canonicalFAILED/infra_failure=false. Original
worker error at18:06:27.512479Z reports action_count0, session_id null,
current_url empty and last_action initialization. The absence of browser work
is established by this record, not by the root's zero token counters.

## Diagnosis

The original backend allocated sess_98241cebb8b64302a4ab59fb6fdde1c0 at
18:05:33.225Z (request50650471b70f41ce). CDP validation first failed at
18:05:39.935Z: expected east.back.tilion.dev, but certificate alternative names
were DNS:*.gdn.smartling.com and DNS:*.sl.smartling.com. Three validation
attempts failed; DELETE returned204 at18:05:51.099Z (request8f6263c3d2b84fac).
A second session, sess_0351ecaacd244836b7ed8b46c5fd65f7, repeated three TLS
failures and DELETE204 at18:06:07.299Z (requestc5e44e71e0924407).

Exact source tilion.ts createRemote validates the connection, cleans failed
sessions and allows one replacement. The durable initialization owner then
records FAILED; later worker initialization retries encounter that failed
readiness receipt and do not allocate further sessions. This is distinct from
r1's completed task and C3 semantic rejection. The TLS trust boundary correctly
refused the mismatched certificate. No evidence establishes whether DNS,
network interception, endpoint issuance, or provider routing caused the mismatch.
No TLS bypass, retry expansion or credential change is justified.

The campaign reader marks infra only for native INFRA_ERROR/ERROR; this root
arrives as generic FAILED after exception conversion. That explains the stored
false flag, but does not establish a safe general typed-classification fix:
the original structured certificate error is only retained in backend logs,
not propagated as a typed original task outcome. Operational classification
was escalated to the parent with exact lines/hashes; stored grades remain intact.

Archive SHAac75f40319ddd11bf6a1de696014435154696066f3147090f06dc5c2f7c61839;
manifest7d173ad2f6cb18e84729f8d0e93ee4a65a86f5d6c714c68b6b8f16eddcc859ca;
backend d6376471d51014f6e3483b12a8c00235adab3a207e32f60c41ad70bf82bee79a;
worker c32152d25bfe09fcf9a8b7208a6fdc71a90447e28fd0625ef3dc1b51af74e523.
All seven original members and exact source/no-patch provenance verified.

## Solution

OPEN: no runtime candidate or native repro. Both allocated session DELETE204
records are retained as historical cleanup evidence. The terminal normal
cleanup snapshot reports root_deleted/tree_sealed and no errors; its provider
receipt list is empty because allocation cleanup had already occurred. Do not
invent another release receipt or treat an empty list as a missing DELETE.
Existing regional-CDP multiplexing and gateway-key cases are relatives only;
neither establishes this certificate mismatch's origin.

## Human feedback

The coordinator required immediate escalation of positive TLS infrastructure
evidence for operational stop handling, while preserving the producer's original
infra_failure=false and forbidding TLS disablement or unsupported attribution.

## Reusable lesson

Preserve certificate identity failures and allocation cleanup receipts separately
from generic task failure, without weakening TLS trust to manufacture readiness.

## Operational stop classification

The coordinator treated the positive CDP certificate mismatch as grounds for
operational TLS stop handling. This operational decision is separate from the
producer's stored infra_failure=false; no original row, grade or failure flag
was rewritten, and no TLS validation bypass was introduced.
