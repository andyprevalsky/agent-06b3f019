---
id: 2026-10-16-worker-process-exec-assumed-payload-transport
date: 2026-10-16
title: Worker process bootstrap assumed native exec delivered stdin and oversized commands
surface: back-end
component: worker-process-transport
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: workerProcessTransport submitted the signed source envelope through native Machine exec stdin without verifying delivery
symptoms:
  - PayloadTooLarge
  - MethodNotAllowed
  - stdinBytes 0
  - Worker runtime receipt is not JSON
tags:
  - deployment
  - existing-machines
  - transport
  - source-integrity
sources:
  - PR #1518 development stabilization
  - commit 5701c26bc80857218fa329dc5adde0589e03a83f
repro: back-end/src/tests/unit/worker-process-transport.test.ts
status: open
---

## Problem

Native qualification on one explicitly owned existing worker found that the exec
endpoint returned an empty stdin to a harmless reader supplied with 131072 bytes.
Commands of 72246 and 25146 bytes returned outer exit code zero but empty stdout
and a provider rejection containing `PayloadTooLarge` and `MethodNotAllowed`.
Neither result was a successful worker receipt. The requested qualification
resource was positively absent and the original worker remained served.

The independent memory/SDK prerequisite subsequently passed with a small command
and a benign child. That result proves neither bulk source delivery nor actual
candidate startup. No candidate worker, activation marker or queue pointer was
created by these probes.

## Diagnosis

The adapter modeled a provider request field as delivered process input. Its
local fake parsed that field directly, so it could pass without exercising a
Python process whose stdin was empty. Putting the complete source in command
arguments encountered a separate measured native size boundary. A successful
outer exec status did not establish that the command produced its expected
receipt.

Archive searches used `PayloadTooLarge MethodNotAllowed stdin Machine exec` and
`worker runtime payload ignored stdin command size transport`. The October 7
direct-exec archive case and September 11 complete-boot-payload case are relatives:
both require a fixture that models the actual transport. Their shell/config
boundaries differ from this endpoint's stdin delivery and command-size failure.

## Solution

Keep only one compressed copy of the pinned bootstrap in a bounded native
command. Retrieve the complete unchanged signed envelope over authenticated
production-backend HTTPS, from the retained immutable plan. Reject redirects,
unexpected status, oversized response, missing key and canonical digest mismatch
before executing the bootstrap. Feed the verified bytes through an in-process
stream; do not depend on native API stdin. Preserve exact Machine/boot identity,
the bootstrap's own signature and archive checks, and the existing recovery
lease. The source endpoint reads retained state without acquiring that same
deployment lease or invoking Fly, avoiding a controller-to-backend deadlock.

The permanent transport fixture executes the actual generated Python loader
with external HTTP and native API facts controlled. It models ignored API stdin
and rejects oversized command frames. The same large and compact fixtures fail
with assertion bodies on actual5701 and pass with the loader. Negative controls
cover authentication, redirects, response identity and size, pinned source drift
and missing capsule. This is a source-scoped external-boundary proof, not an
actual production payload or eight-worker qualification claim.

The private endpoint's owning tests exercise real local Express HTTP and the
production source issuer with external store/platform facts mocked. Internal
authentication, no-store headers, exact plan/host/envelope digest and configured
backend service/database/source custody are required. Copied local records and
foreign requests cannot publish source. No secret value is embedded in a URL or
native command.

Full composed-source gates, actual production full-payload delivery, candidate
startup, coexistence, independent backend recovery and eight-worker activation
remain required. The case stays open until that verification is complete.

## Human feedback

The user required finishing deployment by reusing existing Machines. That does
not authorize fresh allocation, weakening credential isolation, interrupting real
work or treating mocked transport results as production qualification. The
transport correction follows measured native behavior under those constraints.

## Reusable lesson

Test the actual process input and complete command frame at a remote exec
boundary; an accepted request field and outer success code do not prove delivery.
