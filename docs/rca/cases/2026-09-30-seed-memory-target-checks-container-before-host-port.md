---
id: 2026-09-30-seed-memory-target-checks-container-before-host-port
date: 2026-09-30
title: Cold-seed memory gate suppressed schema failure and skipped host-path readiness
surface: harness
component: back-end/scripts/measure-seed-memory.sh
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: measure-seed-memory.sh suppressed the Prisma error and did not check readiness through the localhost host-port path Prisma used
symptoms:
  - 'run 1: schema push failed'
  - 'seed memory ratchet requires 5 successful, fidelity-verified runs; got 4'
tags:
  - deploy
  - seed-memory
  - postgres
  - docker
  - readiness
sources:
  - PR #1344
repro: scripts/tests/seed-memory-ratchet.test.sh
status: fixed
---

## Problem

The final `/deploy` cold-seed memory gate failed its first of five runs at
`npx prisma db push`, then passed runs two through five. The gate correctly
rejected four favorable memory samples: `seed memory ratchet requires 5
successful, fidelity-verified runs; got 4`. The failing stage is
`.context/deploy-runs/20260930-235404-20524/logs/seed-memory-ratchet-20261001-033450-78990.log`.

## Diagnosis

The script started a new throwaway Postgres container with a dynamic host port,
checked `pg_isready` only *inside the container*, then immediately ran Prisma
through `localhost:$PORT`. That readiness probe did not establish that Docker
had published the host listener yet. The same script redirected all Prisma
output to `/dev/null`, so the exact database error from this occurrence cannot
be recovered. A published-port readiness race is the narrow likely cause,
consistent with run one failing and four fresh target containers succeeding;
it is an inference, not a confirmed Prisma error signature. The missing
host-path check and discarded diagnostic were the owned first bad boundaries.

Archive searches: `seed memory schema push failed first run Docker port
readiness` and `Docker container pg_isready succeeds before published host
Postgres port seed memory`. The related
`2026-07-11-shared-local-db-concurrent-schema-mutation` case involved another
worktree mutating a shared database. This gate uses throwaway target containers,
so that failure class does not explain this run.

## Solution

The gate now checks the same host path Prisma uses with `SELECT 1` against
`localhost:$PORT/victoria`, using 30 retries and a two-second connection timeout
per attempt before pushing schema. If the probe never succeeds, its final error
is retained and printed. Prisma output is also retained in `schema-push-N.log`
and printed on failure, so a future schema or connection error can be diagnosed
without inference. No memory sample or budget is changed.

The permanent structural test checks the published-port probe and exercises
its retry, exhaustion, and error retention with mocked `psql` responses. Before this
change `bash scripts/tests/seed-memory-ratchet.test.sh` exited 1 with `cold
target schema push must wait for the published host port`; afterward the same
command exits 0. The final complete five-run ratchet passed with a 185 MB peak
against the 230 MB budget after the probe used Prisma's `localhost` host and
retained the last probe error.

## Human feedback

None recorded.

## Reusable lesson

Check database readiness through the same network path the next client will use, and retain failure output from every hard gate.


## October 5 host-probe-success recurrence

A fresh deployment on `7695d9b` again produced four of five successful cold
seeds. This time the retained localhost SELECT1 probe succeeded before Prisma
reported P1001 after another 69.302 seconds. Both target URLs matched the owned
database; subsequent fidelity-verified peaks were 154, 158, 168, and 169 MB.
The original target server state was not retained, so Docker transport failure
versus delayed host execution remains unclassified. The prior missing-probe
cause is not established for this occurrence, and the four samples remain a
failed gate. Original output and independent review are private under
`.context/deploy-runs/pr1410-finalize-20261005/`. A fresh five-run validation is
required; a passing retry does not retroactively resolve the original cause.


## November 9 canonical seed publication recurrence

The normal PG15 canonical-seed migration on `726dfa7e1` failed at the first
host TCP `psql` connection after its socket-default `docker exec pg_isready`
returned success. The installed image entrypoint starts a temporary initialization
server with an empty `listen_addresses`. A separately owned scratch reproduction
observed Unix readiness exit 0 while TCP readiness exited 2, then a successful
TCP `SELECT 1` after final startup. This proves a temporary-server readiness
mismatch; it does not establish the historical September host-forwarding cause.

The canonical migration script now checks explicit container TCP
`127.0.0.1:5432`, and refuses clients/publication if the same 60 one-second
polls are exhausted. Migration SQL, validation, dump/restore roundtrip and
remote GET/cmp remain unchanged. The registered hermetic actual-CLI suite
`python3 scripts/tests/migrate-canonical-seed.test.py` failed both tests against
the original and passed both with the fix. It covers Unix-ready/TCP-not-ready
and exhaustion without real database or provider calls. The ordinary publication
retry and whole-source gates remain separately required.

The original failure, installed entrypoint, owned scratch observations and
supervisor closure are retained privately under
`.context/rca-google400/seed-readiness-rca/`. Two earlier scratch mount-permission
setup failures remain preparation errors, not evidence for the original failure.
Protected database fixture 21535 was untouched. No new human feedback.
