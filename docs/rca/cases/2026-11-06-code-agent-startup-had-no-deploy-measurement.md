---
id: 2026-11-06-code-agent-startup-had-no-deploy-measurement
date: 2026-11-06
title: A Rose-repo code agent took ~5 minutes to start in prod and no deploy gate measured or bounded it
surface: cross
component: code-agent-benchmark
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: agents/benchmarks/tasks.json had no benchmark whose root agent runs in the Rose project, so no /deploy gate observed the code-agent create (back-end/src/providers/e2b.ts createClaudeCodeSession) or the project startup before the CLI
symptoms:
  - "Restored project workspace" source=remote ~140 s after "Using sandbox: … (new)"
  - three ClaudeCodeSession rows for one spawn_claude_code_agent call
  - "Rose-in-Rose preview autostart failed" "[deadline_exceeded] the operation timed out"
  - "Project repo not granted to owner; cloning without credentials"
tags:
  - claude-code
  - e2b
  - projects
  - startup-latency
  - benchmark
sources:
  - agent 1a3d495c-826c-4eca-afe0-382fcbf72e82
  - agent acad4658-ebe4-4d9f-b26d-f9503b7f29d5
  - agent 657427ef-e7ab-47c8-9c6d-0adb5a32753d
repro: agents/benchmarks/code_agent_checks_test.py
status: open
---

## Problem

Andy asked a root agent with the Rose project attached to look at the Rose
repo (prod root 1a3d495c, 2026-11-06). The spawn_claude_code_agent call went
IN_PROGRESS at 04:16:33.6 and its code agent was handed the goal at 04:19:24.
Render logs for that create: request 04:16:34.709, sandbox acquired 04:16:35.516
(0.7 s, new), "Restored project workspace" source=remote 04:18:55.117 (139.6 s:
a full `git clone` of the 1.1 GB private repo), WebSocket ready 1.4 s later,
"Rose-in-Rose preview autostart failed … deadline_exceeded" after its 10 s
budget, "Session ready" 04:19:06.522, 151.8 s after the request. The agents
client's 60 s create timeout fired twice meanwhile ("Resuming code session" at
+63 s and +127 s); the global create slot queued both retries, which then
created two more ClaudeCodeSession rows for the same spawn (dd8ef6a8, 9c3c19a0,
631d4602) and restarted the CLI each time.

No /deploy gate ran a code agent inside the Rose project, so none of this was
measured, bounded or recorded.

## Diagnosis

Rung 1: the startup cost is real and dominated by the project restore (clone)
plus the project startup script that ws-server runs before the CLI (the Rose
project has no template snapshot in prod: `templateSnapshotId` is null).
Rung 2: no deploy-path test observes that path. The Claude Code smokes
(claude-code-agent, the 6c E2B blackbox smoke) create repo-less sessions; the
startup phases were only reconstructible by hand from five free-text Render
lines and three DB tables.
Rung 3 (stop): the benchmark catalog had no evaluator surface for code-agent
sessions beyond transcript presence, so a slow or duplicated create could not
fail any run.

Local benchmark run e55d7a42 also showed that the benchmark environment can
silently degrade the scenario: the shared GitHub PAT was out of REST quota
(`API rate limit exceeded`, core 5000/5000), the Rose project's clone grant was
skipped, and the session started in an EMPTY checkout (source=empty) while the
code agent still answered. The new startup check failed that run
("did not start in a project checkout"), as intended.

## Solution

New pre-deploy smoke benchmark `code-agent-rose-repo` (tasks.json): the root
agent is created in the benchmark user's Rose project (new task field
`project`, resolved through GET /api/projects, which builds the Rose project
out of the box for the repo owner) and spawns one Claude Code agent that
answers from its checkout. Its evaluators live in
agents/benchmarks/code_agent_checks/ (one module per check, registered in
long_horizon.RUNTIME_STATIC_CHECK_TYPES and dispatched by
run_benchmark._run_declared_static_check):

- `code_agent_startup_time`: per spawn, worker-clock phases create →
  project_startup → cli_init (= ready, gated) → first_output, plus the backend
  split of create (slot_wait, sandbox, workspace = project restore, ws_ready,
  preview, record) parsed from the existing backend lines; requires a project
  checkout (remote or snapshot). Every phase is appended to the span history
  under `code-agent-startup/<phase>`.
- `code_agent_one_session_per_spawn`: ClaudeCodeSession rows per agent equal
  its distinct spawn tool calls.

Offline proofs (real prod and local log lines) in
agents/benchmarks/code_agent_checks_test.py, registered in the permanent agents
blackbox gate. 10k-agent behaviour: evaluation-only, per run; nothing on the
product path changes.

## Human feedback

Andy (2026-11-06): these tests should fold into one code-agent benchmark that
evaluates every issue he reports; the coordinator assigned the create
idempotency fix to Lane A and FE/send_message fixes to other lanes, so this
case adds measurement and checks only and does not edit the spawn/create code.

## Reusable lesson

Before trusting a code-agent latency or correctness result, confirm the session
actually started in the project's checkout: a failed clone falls back to an
empty repo and the agent still answers.
