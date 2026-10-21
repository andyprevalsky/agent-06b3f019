---
id: 2026-10-20-direct-claude-http400-error-body-unrecorded
date: 2026-10-20
title: Recovered direct Claude HTTP 400 requests lack the provider error body
surface: agents
component: rose direct Claude transport / failure capture
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: "Direct Claude transport rejects with HTTP 400; retained transport records and winning dumps contain status/body length but not the rejected provider body"
symptoms:
  - "rose.transport.anthropic.error"
  - "rose.claude_auth.invalid_request"
  - "status=400 body_len=326"
  - "status=400 body_len=216"
tags:
  - claude-auth
  - provider-error
  - observability
sources:
  - agent fad65dad-5d2c-4202-b1e4-37a4dd96101e
  - benchmark run 2023ea15-dba3-4455-bc3e-4d104d3e4d96
  - agent fad65dad-5d2c-4202-b1e4-37a4dd96101e evidence .context/rca-915ab997/resume-incidental-triage.txt
  - agent fad65dad-5d2c-4202-b1e4-37a4dd96101e evidence .context/rca-915ab997/resume-incidental-evidence.json
repro: none-recorded
status: open
---

## Problem

The unchanged payment task passed in 254.1 seconds, while eleven direct Claude
attempts returned HTTP 400: nine body lengths of 326 and two of 216. Every
request ID subsequently completed through Foundry. These are recovered attempt
failures, not eleven task failures or failures fixed by receipt preservation.

## Diagnosis

The original isolated worker log spans 04:11:37–04:15:17 UTC. Request
69243b82 rejects at worker lines 100–103 and completes through Foundry at line
130; the remaining request IDs and exact source hashes are indexed in the
source reports. The winning dumps retain invalid_request metadata, but not the
rejected error bodies. Equal body lengths do not establish equal causes.

Literal and behavioral archive searches found prior Claude version, conversion,
refusal and completion-summary cases; their Solution and Human feedback were
read. The direct-compute-auth-401 case is a relative, not this HTTP 400 incident.
No captured body establishes token expiry, request shape, client version, model
availability or billing as the cause. The two body-length groups may differ.
No local reproduction of the underlying rejection was performed.

## Solution

Not implemented; retain this OPEN capture gap. Capture redacted provider error
JSON/request ID, actual route/model, failed payload/schema hash, advertised client
headers and selected credential identity before choosing a fix. Split incidents
if those bodies identify separate causes. Foundry recovery and the task PASS do
not restore direct provider health. No account, prompt, runtime or concurrency
change is justified by these records; 10k-agent impact is unmeasured.

## Human feedback

None recorded.

## Reusable lesson

Retain the actual rejected provider response before assigning a cause to an HTTP 400 or treating fallback success as a repair.
