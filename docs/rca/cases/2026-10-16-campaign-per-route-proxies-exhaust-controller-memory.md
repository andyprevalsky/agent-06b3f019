---
id: 2026-10-16-campaign-per-route-proxies-exhaust-controller-memory
date: 2026-10-16
title: Persistent per-route Fly proxies exhausted controller memory
surface: infra
component: cloudbench-shared-transport
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: each primary controller starts persistent Fly processes for status and metrics plus optional backend transport
symptoms:
  - "controller kernel killed flyctl processes"
  - "status proxy lifecycle HTTP000"
tags:
  - cloudbench
  - transport
  - memory
  - concurrency
sources:
  - plan:/tmp/pr1525-original600-resume/attempt57-1792186561060381949/run/failed-provider-logs-8d99dd4ce3e968-1792190548464856153.private.json
  - plan:/tmp/pr1525-shared-transport-integration/.context/shared-relay-proof
repro: python3 scripts/tests/cloudbench-shared-transport-integration.test.py
status: open
---

## Problem

Attempt57's controller kernel killed four flyctl processes at 22:39:57,
22:40:24, 22:41:20, and 22:41:52 UTC. Recorded victim anonymous resident sizes
were 260096, 276992, 284160, and 293376 KiB. These measurements establish OOM
victims, not the memory baseline of every proxy. Earlier status failures near
22:20 remain unresolved because their guest logs were unavailable after
owned destruction; the later OOM must not be backdated into those failures.

## Diagnosis

The ordinary primary path owns one status proxy and one metrics proxy, plus
one optional backend proxy. Six hundred primary controllers can therefore
retain 1200 to 1800 Go client processes. Each client manages a separate route
although all routes use the same application network and local agent protocol.
The pinned CLI accepts one local-to-remote mapping per proxy invocation.
This multiplies transport processes independently of actual task execution.

Related archive searches covered status proxy HTTP000, controller memory,
client packaging, and startup process amplification. The client packaging and
status argument cases explain earlier independent startup faults; neither
accounts for these actual kernel OOM records.

## Solution

A campaign parent starts one canonical proxy bootstrap with one private
isolated agent and one asyncio relay broker. The broker multiplexes listeners
through the pinned agent's Unix RPC protocol. Each route binds an exact
controller PID and birth, token, native publisher Machine/IP identity, and
remote port. Independent release closes only that route. Route PID variables
stay empty; existing cleanup must never signal the shared broker as a route.

Cold route registration and release use bounded control messages. Frequent
liveness checks use exact broker/agent births and keyed live markers in Bash,
without Python imports or process-table scans. Existing authenticated HTTP
health checks remain authoritative for endpoint readiness. Historical-owner
recovery retains its existing real-PID transport and join contract. Ordinary
non-campaign transport remains compatible.

The parent joins task controllers before requesting broker shutdown. It then
joins its single bootstrap and observes the private agent's EOF retirement.
Preexisting default agents are untouched. Failed startup records agent
retirement as pending when no sealed agent identity was obtained. Original
campaign deadlines, task profiles, concurrency, and failure accounting remain
unchanged. No task batching or larger-memory prerequisite is introduced.

Owning regressions exercise real broker framing, streaming, backpressure,
route ownership, independent cleanup, parent death, actual shell callers for
all three roles, and parent bootstrap/join behavior against local fixtures.
This validates the source mechanism, not production throughput or successful
completion of the original600. The RCA remains OPEN pending the unchanged
funded workload crossing the affected boundary.

## Human feedback

The user requires fully parallel reservation and transport without artificial
batches, while retaining bounded retries and correct disposable teardown.
The operator authorized this isolated repair after actual OOM evidence and
kept attempt57's active source and cleanup immutable.

## Reusable lesson

Share network transport at the campaign boundary; increasing worker concurrency
must not multiply heavyweight persistent clients for every local endpoint.
