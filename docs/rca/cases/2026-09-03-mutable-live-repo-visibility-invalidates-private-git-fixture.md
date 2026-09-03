---
id: 2026-09-03-mutable-live-repo-visibility-invalidates-private-git-fixture
date: 2026-09-03
title: A mutable live repository made the private-fetch regression fixture nondeterministic
surface: harness
component: cloudbench-refresh-deps-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/benchmarks/cloudbench_dependency_sync_test.py test_refresh_deps_controller_auth_header_fetches_private_repo hard-coded the live Rose GitHub repository as a private auth fixture
symptoms:
  - "AssertionError: assert 0 != 0"
  - "git -c credential.helper= -c http.extraheader= ls-remote https://github.com/rose-ai-labs/rose.git HEAD returned 0"
  - "test_refresh_deps_controller_auth_header_fetches_private_repo"
tags:
  - cloudbench
  - github-auth
  - mutable-fixture
  - private-repository
sources:
  - commit 80cd8d6cd
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_refresh_deps_controller_auth_header_fetches_private_repo
status: fixed
---

## Problem

The agents blackbox suite reported its `benchmark` domain as the only failure
(`96 passed, 1 failed`). The nested pytest failure was
`test_refresh_deps_controller_auth_header_fetches_private_repo`: the supposedly
unauthenticated fetch returned success, so `assert bug.returncode != 0` failed
with `AssertionError: assert 0 != 0`.

The exact owning-boundary reproduction was run locally before the fix:

`cd agents && source venv/bin/activate && pytest -q benchmarks/cloudbench_dependency_sync_test.py::test_refresh_deps_controller_auth_header_fetches_private_repo`

It failed because credential-disabled
`git ls-remote https://github.com/rose-ai-labs/rose.git HEAD` returned exit 0
and a 40-character HEAD SHA.

## Diagnosis

The path was `pytest fixture -> live GitHub repository visibility -> git
ls-remote result -> private-fetch assertion`. The first wrong assumption was
inside the fixture: it treated a mutable third-party repository setting as a
permanent private-auth boundary. With credentials, global and system git config,
and interactive prompting disabled, the fetch still returned HEAD successfully;
that directly proved current repository access did not require the header the test
expected to be mandatory.

The deeper owned gap was that a permanent offline regression gate delegated its
auth semantics to mutable external state. A repository visibility change,
GitHub access-policy change, or network outage could therefore change the
verdict without any change to `cloudbench_resolve_github_token` or the
refresh-deps git command.

Archive searches for `test_refresh_deps_controller_auth_header_fetches_private_repo
empty AUTH_HDR private fetch` and `public repository unauthenticated git
ls-remote succeeds environment-sensitive test` found the related
`2026-08-19-refresh-deps-empty-github-token-aborts-fleet` production incident,
but this was not a recurrence of its production cause. It was a new failure in
the regression guard added for that auth path.

## Solution

The test now creates a temporary bare Git repository and serves it from a local
HTTP handler with explicit auth contracts. The resolver endpoint accepts only
the fixture Bearer token; Git objects accept only the Basic header derived from
that resolved controller token. The same behavioral contract proves that
an empty `http.extraheader` is rejected and the controller header returns HEAD.

The identical pytest command then passed (`1 passed`). This removes live
repository visibility and network availability from the verdict while
preserving this regression test's auth semantics. Production refresh-deps wiring
remains covered separately by
`test_refresh_deps_git_sync_uses_controller_fetch_ref` and
`test_refresh_deps_uses_controller_token_not_box_secret`. The local fixture also
prevents sibling false failures if GitHub changes anonymous access behavior.
The change is test-only, starts one loopback server for one test, and has no
runtime or 10k-agent cost.

## Human feedback

None recorded.

## Reusable lesson

Model private-auth regression fixtures with a deterministic authenticated local endpoint, never a live repository whose visibility can change independently of the code.
