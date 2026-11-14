---
id: 2026-10-28-temu-challenge-browser-timeout-unresolved
date: 2026-10-28
title: Temu challenge and rejected search responses precede browser timeout
surface: agents
component: browser-recovery
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Unresolved challenge recovery and search response rejection before native StartToClose
symptoms:
  - BU037 run2 remains at security verification without five names and prices
  - Search responses include codes 54001 and 40001
  - Native browser activity reaches its existing 50 minute deadline
tags:
  - polar
  - temu
  - challenge
  - timeout
sources:
  - commit ca562dd8b9a259800980bbdc2205d873bc657d5e
  - agent 6e883514-7777-4b8e-b56f-0bff68e41468
  - fleet run 20261028-051014-17538
repro: No causal local reproduction; original captured failure retained
status: open
---

## Problem

It8 R11c BU037 run2 isFAILED after3011.5s, infrafalse. The root agent is
6e883514-7777-4b8e-b56f-0bff68e41468. The task requires the first five names and
prices after a lowest-price wireless-earbuds search. No criterion is changed.

## Diagnosis

Normal shard01 export SHA256
9ecd2ac44e3602f13b5958239c967b0c775c17c876285e2c19f229790837966d.
Run JSON SHA25662e2cf4fd5bb0c012f959fa15ebc38ebe2055ec564f1b1d9080a9c519f5ec295;
worker SHA256383d56dd66024257d06038b044abdae1dee0fee3598afc55130f5c76253e79dc.

Eight failed recoveries occur at05:20:25,05:26:34,05:28:58,05:33:23,05:39:46,
05:45:02,05:54:40 and06:00:34Z. The06:03:53 verifier reports0%: the page is at
SecurityVerification, search responses contain54001/40001, and no five product
names/prices were obtained. The actor continues after feedback. Browser manager
fails with native StartToClose at06:06:42.212108Z. A05:37:06 completion attempt
also reaches its180-second deadline; neither deadline alone identifies the
upstream recovery cause. No Polar declared evaluator runs after terminalFAILED.

The passing run1 sibling (cc2030b8-6cf0-4e5a-8d78-68aa8afbed44) completes in128.8s
with search, sort, five cards and a final answer. Sibling success does not prove
this run's challenge could be bypassed or that a local code defect caused it.
The BU025 verifier admission defect is separate; do not group these incidents
by their common terminal timeout.

## Solution

No patch is justified by the captured evidence. The root cause remains open.
Native configuration maps the recorded100-step setting to50 minutes; its
existing deadline fired. No cap, prompt, task, retry or criteria change is made.
A valid next step would require original provider/challenge failure evidence
sufficient to reproduce the first bad recovery boundary. No new provider or
browser probe was performed in this bounded RCA.

## Human feedback

Parent required separate R11a/R11b/R11c families, original grades and infrafalse,
normal local exports only, and a causal red/green plus exact independent review
before any protected fix. Zero call-count telemetry is not evidence of no calls.
No deployment, paid benchmark or active frozen checkout change is authorized.

## Reusable lesson

A shared terminal timeout does not establish a shared upstream cause. Keep
challenge state, provider response failures and evidence-admission defects
separate until original evidence and a causal reproduction connect them.
