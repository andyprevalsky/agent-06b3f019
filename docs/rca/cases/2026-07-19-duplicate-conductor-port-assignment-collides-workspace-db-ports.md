---
id: 2026-07-19-duplicate-conductor-port-assignment-collides-workspace-db-ports
date: 2026-07-19
title: Two workspaces got the same CONDUCTOR_PORT base, so a foreign Postgres container squatted this workspace's DB port
surface: harness
component: run-sh-local-stack
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/run.sh:port_requires_reassign — strict port mode refuses reassignment when a foreign container holds CONDUCTOR_PORT+5
symptoms:
  - "Port range <CONDUCTOR_PORT> is occupied; strict Conductor port mode forbids reassignment."
  - "run.sh --benchmark exits 1 immediately at /deploy Step 5"
  - "Transaction API error: Unable to start a transaction"
tags:
  - conductor
  - ports
  - docker
  - postgres
  - deploy
sources:
  - memory:project_deploy_db_port_collision
repro: none-recorded
status: mitigated
---

## Problem

`/deploy` Step 5 (`run.sh --benchmark`) exited immediately with
`❌ Port range <CONDUCTOR_PORT> is occupied; strict Conductor port mode forbids
reassignment.` The error names only the range, not the offending port or
container.

## Diagnosis

Conductor had assigned two live workspaces the **same** `CONDUCTOR_PORT` base
(both 55190), and `LOCAL_DB_PORT = CONDUCTOR_PORT + 5`, so both wanted their
Postgres on 55195. A different workspace's container (e.g.
`victoria-db-montreal`) already held it. `run.sh:port_requires_reassign` detects
the foreign container, and because benchmark + bundled-frontend force strict port
mode, it refuses to auto-reassign and exits 1.

Worse, the failure has a silent precursor: the pre-Step-5 DB pre-start and
backend coverage run may have already connected to the **squatter's** database on
that shared port. Self-contained blackbox data still passes there, but concurrent
load shows up as `Transaction API error: Unable to start a transaction` — so a
"DB ready" signal on a shared port cannot be trusted to mean _your_ DB. This
workspace's real container may also be sitting on a stale port from when its
`CONDUCTOR_PORT` differed.

Diagnose with, over the workspace's range:
`for p in $((CP)) ... $((CP+9)); do lsof -nP -tiTCP:$p -sTCP:LISTEN; done`
and `docker ps --format '{{.Names}} {{.Ports}}' | grep ":<port>->"`.

## Solution

Do **not** touch the other workspace's container (rule 27). Relaunch the stack on
a free base: scan for a range where base+{0,1,2,3,4,5,6,9} are all free, then
`export CONDUCTOR_PORT=<free base>` before `run.sh` **and** for the smoke/semantic
steps (`BACKEND_PORT=$CONDUCTOR_PORT FRONTEND_PORT=$((CONDUCTOR_PORT+1))`).
`run.sh` then recreates `victoria-db-<dirbasename>` on the new base+5. The
recorded follow-up, worth its own PR: make the strict-mode failure name the
specific colliding port and container instead of the generic range message.

## Human feedback

None recorded.

## Reusable lesson

On a strict-port-mode `run.sh` failure, identify which container actually owns
each port in your range before trusting any "DB ready" signal — then move your own
stack to a free base rather than reclaiming another workspace's port.
