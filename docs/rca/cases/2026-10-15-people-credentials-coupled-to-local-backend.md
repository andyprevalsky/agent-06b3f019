---
id: 2026-10-15-people-credentials-coupled-to-local-backend
date: 2026-10-15
title: People credential authority was coupled to the isolated application backend
surface: agents
component: people-search
classification: our-bug
problem_class: other
first_bad_boundary: The worker selected BACKEND_API_URL as the credential authority even when an independent broker origin was configured
symptoms:
  - LANTERN_NOT_CONNECTED
  - Local broker used instead of configured central authority
tags:
  - lantern
  - credential-broker
  - isolated-workers
sources:
  - commit c6117542139ec0256f47de02a53e68a321d8e26a
  - task .context/lantern-broker-rca-c611/.context/broker-rca/red-checkpoint.json
  - task .context/lantern-broker-rca-c611/.context/broker-rca/proposal.json
repro: cd agents && python scripts/run_blackbox_tests.py people-search
status: fixed
---

## Problem

Source inspection found that ordinary isolated DAILY workers route their application
backend locally or to the fleet primary. Without a static bearer, people search
uses that same backend for credentials. A separately activated production grant
therefore does not establish a credential path for those workers. This is a
source-backed configuration gap, not a claim of an observed production exposure
or a failed native benchmark. The existing three-task native pass used an
explicit access-only bearer and remains valid within that scope.

The registered actual-activity fixture uses real configuration loading and the
HTTP transport boundary. Before the fix it observes a local credential GET and
404 LANTERN_NOT_CONNECTED instead of the configured central credential GET and
successful native request. Four new contract cases fail before the runtime fix;
existing cases, blank/default controls and FastMode zero-HTTP controls pass.

## Diagnosis

Credential authority and application backend routing were represented by one
configuration field. Local stack routing overwrites the latter by design.
Copying a rotating refresh grant into isolated database snapshots would create
independent refresh claim domains and does not repair that authority boundary.
Archive searches for credential brokers, isolated seeds and refresh grant clones
found related credential overlay history but no safe rotating-grant clone design.

## Solution

Add an optional PEOPLE_CREDENTIAL_BROKER_URL, independent of PEOPLE_API_URL and
the application backend. A nonblank broker is authoritative even when an explicit
static bearer exists. Validate its HTTPS or loopback origin before machine-auth
HTTP, reject invalid components and ports without including the URL in errors,
and keep native expected-origin validation. Use the existing machine key and
workflow actor; never forward refresh grants or fall back after broker failure.
Blank configuration preserves existing direct-token and local-broker behavior.

The same registered people-search owner passes after the fix, including typed
503 wait details, malformed-origin zero HTTP, default routing and FastMode zero
HTTP. The normal config owner also passes. Deployment still requires explicitly
configuring and propagating the broker origin and a compatible machine key, and
activating the intended server-side grant. These local tests do not assert that
those operational prerequisites have been completed.

## Human feedback

None recorded.

## Reusable lesson

Represent credential authority separately from application routing when isolated workers must share one durable refresh lineage.
