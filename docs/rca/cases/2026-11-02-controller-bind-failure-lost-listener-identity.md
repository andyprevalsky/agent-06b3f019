---
id: 2026-11-02-controller-bind-failure-lost-listener-identity
date: 2026-11-02
title: Controller Hub bind failure lost the original listener identity
surface: harness
component: cloudbench-controller
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Hub stub server_bind returned EADDRINUSE; original port and conflicting owner were not captured, so attribution is unproven
symptoms:
  - 'OSError: [Errno 98] Address already in use'
  - 'FAIL: hub stub must publish an exact owner record'
tags:
  - cloudbench
  - port-collision
  - attribution
sources:
  - PR #1662
  - commit 7be0644bb164763af1526ead7b426e2d5e909f4a
repro: none-recorded
status: open
---

## Problem

Occurrence 5b87e32a8845407eb6159a61edc03563 had two failed native local
controller rows; the outer result was UNVERIFIED. Multi-workstream stopped at
an EADDRINUSE traceback in its Hub stub, then the absent exact-owner assertion.
Its native result was exit 1, quiescent true, with no remaining child processes.
The other failure was independently reproduced as a nested Python environment
error and is recorded in the existing interpreter case.

## Diagnosis

Gate: UNKNOWN for the multi-workstream constituent. Compared frozen 7be0644bb164763af1526ead7b426e2d5e909f4a
against baseline bf92cbd98ab436af20f9a8d647c32e748c67e93a. The multi-workstream
script, fleet script and environment helper are identical Git blobs. The new
runner launches twelve suites concurrently with separate TMPDIRs, but that
alone does not prove the conflicting listener's owner or why the bind failed.
No shared cause with the seven Python import failures is established.

Worker ph7dr8sexrfwqqprpv6m6m0byd8heees supplied the 17-file native archive
and a read-only supplement. The failed inner tmp.JtfDJHeFRk directory no
longer exists. The outer fixture has only an empty port-claims directory.
Actual HUB_PORT_A/B and a contemporaneous listener/socket/PID-birth snapshot
were not recovered. A hash-derived first candidate is not proof of the chosen
port, and the earlier intentional probe of port 42000 is not this failure.
The original inherited PATH was also not separately recorded; current probes
are identified as current rather than historical evidence.

A private controlled replay extracted the original hub_stub heredoc byte-for-byte.
The real absent-listener probe returned success. A controlled competing listener
then bound the selected endpoint; the original stub failed at line 158 with the
same Python3.12 socketserver EADDRINUSE traceback. A socket-reservation control
kept the bound descriptor open across handoff to the stub; the competing bind
was rejected and the same exact-owner HTTP startup assertion passed. Results:
`/var/tmp/rca-5b87-cloudbench/bind-{probe,held}/result.json`.
This proves a probe-to-bind race can produce this symptom; it does not identify
the original competitor or prove that new parallel orchestration introduced it.
No merge-ready change to the original shell/FD protocol is claimed.

## Solution

Open investigation. Capture the selected port, exact bind exception, listener
socket identity, PID birth, owning command, port claim, and active case before
fixture cleanup in a future controlled owning-boundary replay. Compare the
same valid source/environment pair on baseline and frozen source. Do not
change deadlines, weaken exact-owner assertions, assume an external outage,
kill an unidentified listener, or call a generic bind-collision replay proof
of this occurrence. A later passing full run does not establish the original conflicting owner or close this attribution gap. No fix has been applied. Parent owns all source/deployment
changes; this case is a private draft for its archive integration.

## Human feedback

User explicitly restricted this task to evidence, private narrow reproduction
and exact fix drafting; parent retains source/deployment ownership. Preserve
Freedom, do not launch full gates, and do not waive unknown work.

## Reusable lesson

Preserve the chosen endpoint and exact conflicting listener identity before fixture cleanup so a bind failure can be attributed without guessing.
