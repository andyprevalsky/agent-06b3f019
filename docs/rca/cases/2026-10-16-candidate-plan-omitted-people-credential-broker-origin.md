---
id: 2026-10-16-candidate-plan-omitted-people-credential-broker-origin
date: 2026-10-16
title: Candidate worker process plan omitted the authenticated people credential broker origin
surface: cross
component: worker-process-deployment
classification: our-bug
problem_class: other
first_bad_boundary: signWorkerEnvelope omitted peopleCredentialBrokerOrigin from the captured worker plan and candidate bootstrap environment
symptoms:
  - 'PEOPLE_CREDENTIAL_BROKER_URL absent'
  - 'peopleCredentialBrokerOrigin undefined'
tags:
  - worker-process
  - signed-envelope
  - lantern
  - credential-custody
sources:
  - commit cc65de6809344b97fd0c8b08767f470f431b5c42
  - task broker-native-exec-presence-8362
repro: 'node --import tsx src/tests/unit/worker-process-deployment.test.ts fails the registered signed-status broker assertion on the original signer; the same owner passes after the typed plan/envelope/bootstrap change'
status: open
---

## Problem

A read-only native candidate-bootstrap-shaped exec reported the broker environment variable absent. The exact source had no broker field in WorkerProcessPlan or the signed ensure/status envelope. Therefore a candidate could not receive the existing public broker origin through its authenticated deployment handoff. Native activation remained held; this case contains no credential or grant material.

## Diagnosis

The registered production signer regression placed the required public origin in its plan fixture and observed `undefined` in the actual signed status envelope. The unchanged bootstrap also rejected the extended request as unknown fields, and its returned candidate environment omitted the broker. This establishes an application handoff omission rather than a provider authentication failure. Archive searches for signed worker process environments and rotating broker custody preceded implementation.

Whole-plan SHA and semantic bootstrap intent already bind all plan/envelope fields, so no new identity mechanism or environment map is needed. Importing local or inherited settings would bypass that explicit custody boundary.

## Solution

Add one required literal `peopleCredentialBrokerOrigin` equal to `https://navi-j9a9.onrender.com` to the plan and supported capture producer. Sign it in ensure/status envelopes; accept it only through strict bootstrap request keys, HMAC validation and exact public-origin validation. Assign only returned candidate `PEOPLE_CREDENTIAL_BROKER_URL` from this authenticated field. Inherited mappings, parent environment and old primary stay unchanged. Old retained plans cannot be modified in place; missing plans must be regenerated before registration.

The same registered controller regression passed after the change. Its cross-language controls use the actual TypeScript signer and Python authenticate/environment functions, reject missing/foreign/malformed/tampered values before effects, and prove candidate-only assignment. Existing private-GET/recovery identity controls and compact/large transport owners preserve exact field/digest and command-frame bounds. Existing worker blackbox tests exercise real local child environment readback and old-worker preservation. No live provider, native Machine action, grant transfer or deployment was performed. Whole-source integration and native qualification remain the root owner's responsibility; status remains open until that review.

## Human feedback

None recorded.

## Reusable lesson

Candidate-only public configuration must cross the same authenticated, identity-bound handoff as its runtime artifact; ambient environment is not an authorization source.
