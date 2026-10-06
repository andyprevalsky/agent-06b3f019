---
id: 2026-10-06-cloud-init-fixture-cleared-timeout-from-path
date: 2026-10-06
title: Cloud setup fixture removed its native timeout executable from PATH
surface: harness
component: workspace-env-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: cloud-init-env.test.sh invoked bare timeout inside a deliberately narrowed env -i PATH
symptoms:
  - env timeout No such file or directory
  - unseeded-without-deps cloud-init.sh did not finish
  - workspace-env exited 1
tags:
  - fixture
  - macos
  - command-resolution
  - environment-isolation
sources:
  - PR #1424
  - commit 7872fa3d78d7ba38d2556d5b354fe0fc0400ee95
repro: bash scripts/tests/cloud-init-env.test.sh
status: open
---

## Problem

The ordinary deploy structural workspace-env gate failed after 21.65 seconds.
Its nested cloud-init environment fixture reported that the unseeded case did
not finish, suggesting an npx prompt. The retained child output instead showed
that env could not resolve the timeout executable. No cloud-init child was
launched at that boundary; this is not a production install or seed failure.

## Diagnosis

The fixture intentionally starts its child with env -i and a PATH containing
only private fake installer/provider tools plus /usr/bin and /bin. On the
supported Mac setup GNU timeout is outside those directories. Calling bare
timeout after clearing PATH therefore fails before the existing 60-second
verification budget or fake npx negative case can run. The subsequent cloud
build controls use the same boundary and need the same native tool binding.

Two archive searches used cloud-init-env/unseeded-without-deps and broader
narrowed-PATH/native-tool fixture failures. They did not identify this owning
cause. This is an environment premise mismatch, separate from partial PID
publication and from real setup or production credential failures.

## Solution

Resolve the existing native timeout executable before clearing the environment,
then invoke that absolute path for the two existing bounded command blocks.
Keep the narrowed child PATH, all private tool fakes, every assertion and the
same 60-second bounds. No production code or normal task/E2E budget changes.

The unchanged ten existing controls passed in 6.871 seconds using the candidate
fixture and byte-bound current cloud-init/cloud-build/workspace-env sources.
Installers, providers, database and privilege commands remain private stubs;
there were no real provider/model calls or source mutations. The existing
workspace-env gate invokes this family automatically. Original failure and
native candidate owner receipts are retained privately under
.context/fresh-basic-claude-final50-20261006/deploy. Final normal registered
qualification remains pending; this case remains open until that qualification.

## Human feedback

The user requested liberal infrastructure budgets and meaningful stage handoff
checks, without gratuitous verification or source resets. The repair changes no
budget and adds no gate or prerequisite.

## Reusable lesson

Bind required native orchestration executables before replacing a fixture's PATH.
