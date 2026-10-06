---
id: 2026-10-06-fixture-git-commits-inherited-host-signing-helper
date: 2026-10-06
title: Throwaway fixture git commits inherited the host's remote signing helper and pushed the benchmark domain past its bound
surface: harness
component: agents-test-env-defaults
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/tests/env_defaults.py apply_test_env_defaults left the host global git config (commit.gpgsign=true, remote ssh signer) active for fixture repositories
symptoms:
  - "TIMEOUT: domain 'benchmark' exceeded 300s"
  - "test_refresh_deps_applies_exact_workspace_before_rebuild takes ~27s in one random parameter"
  - "ssh-keygen -Y sign -n git alive for 9+ seconds under a pytest fixture"
tags:
  - benchmark
  - coverage
  - git
  - fixture
  - cloud-vm
sources:
  - PR #1341
  - commit 29b20bee4021419c972b639d0bf9bfddb6931492
repro: agents/tests/unit/test_env_defaults.py
status: fixed
---

## Problem

The `/deploy` agents coverage lane on a 4-core Cursor Cloud VM failed one of
109 domains: `TIMEOUT: domain 'benchmark' exceeded 300s`. The same domain
passed in 70-80 seconds on this branch before the merge with main, and in
186 seconds when replayed alone on the idle host after the merge.

## Diagnosis

Replaying `cloudbench_dependency_sync_test.py -k refresh_deps_` six times
took 12.6, 28.1, 18.2, 27.5, 13.2 and 27.5 seconds. A different random
parameter of `test_refresh_deps_applies_exact_workspace_before_rebuild`
stalled each time (once `[direct]` at 27.51 s, once `[bad_digest]` at
11.08 s), while every parameter took 0.2-0.5 s in isolation. Its bounded
subprocess has a 20-second timeout and still passed, so the stall was in
the unbounded fixture setup.

Sampling the pytest session's process tree every 2 seconds during a stalled
run showed one `/exec-daemon/ssh-keygen -Y sign -n git` process alive for 5,
7, then 9+ seconds. The host's global `~/.gitconfig` sets
`commit.gpgsign=true`, `gpg.format=ssh`, and a Cursor signing program. The
fixture's `git commit` calls inherited `HOME`, so every throwaway commit
went through the remote signer. A standalone signed commit usually took
0.03 s; the signer intermittently stalls for 10 s or more.

The fixture inherited host state it does not own. Shell fixtures such as
`check-prompt-human-approval.test.sh` and
`auto-rca-lifecycle.blackbox.test.sh` already set `commit.gpgsign false`
locally, but the agents Python suites had no shared equivalent.

## Solution

`apply_test_env_defaults()` (used by `agents/conftest.py` and the blackbox
runner) now injects `commit.gpgsign=false` and `tag.gpgsign=false` through
`GIT_CONFIG_COUNT`, unless the caller already injected its own git
configuration. Every agents test subprocess that inherits the environment,
including the benchmark domain's nested pytest gates, makes unsigned commits.
Production git paths are unaffected, and so are tests that build a
minimal environment without `HOME`.

After the fix, the same six replays took 1.09-1.15 s each, and the benchmark
domain alone took 166 s instead of 186 s. Under the next canonical
two-lane deploy load it passed in 205.03 s, below its unchanged
300-second bound. `test_env_defaults.py` builds a host whose global config
signs through a missing program: the fixture commit and annotated tag fail
before the defaults and pass after them, and an explicit
`GIT_CONFIG_COUNT` injection is preserved. Without the fix the test fails.
There is no runtime cost at 10,000 agents; only test processes are affected.

## Human feedback

None recorded.

## Reusable lesson

A fixture that runs real tools must pin every host setting that can reach
the network or a remote service; when a test is slow only on one host,
sample its process tree before suspecting the code under test.
