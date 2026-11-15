---
id: 2026-11-11-cloudbench-guests-received-the-rotating-devbox-github-credential
date: 2026-11-11
title: Cloud guests received the devbox's rotating GitHub credential, so a guest fetching after a daemon rotation was rejected and tripped the smoke infra stop
surface: infra
component: cloudbench-github-token
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-cloud guest delivery (_ghb64 Machine env, CONTROLLER_GITHUB_TOKEN wrapper) and run-bench-fleet controller_github_token_b64 called cloudbench_controller_github_token, whose candidates (Git credential helper, gh, .env GITHUB_TOKEN) are all the boxes.dev daemon's rotating user credential
symptoms:
  - "[cloudbench] FATAL: could not fetch requested ref 5de02a3624491dfa56f488dc3bf1b7e7d8655005 (fatal: could not read Username for 'https://github.com': No such device or address)"
  - "fatal: could not read Username for 'https://github.com': No such device or address"
  - "controller GITHUB_TOKEN exported (len=40)"
  - single INFRA_ERROR tripped the 1/13 smoke infra stop and cancelled 12 jobs
tags:
  - cloudbench
  - github
  - token-rotation
  - smoke
  - infra-stop
sources:
  - PR #1927 round 5 deploy cloud smoke, smoke/agent-payment-setup-resume, devbox 92d051c0 run 20261111-125924-1541267 remote-logs/cloudbench-driver.log
  - commit 5de02a3624491dfa56f488dc3bf1b7e7d8655005 (failed source; originating merge 5be050acaa4a0f9a08c05639af80e6f386d20089)
  - PR #1967 (fix, merged fa55807f276bfedbfa4180bf38991f58c70a234a on 2026-11-15)
repro: bash scripts/tests/cloudbench-github-token.test.sh
status: fixed
---

## Problem

Gate: NOT_INTRODUCED for PR #1927 (it did not touch token resolution). In its round-5 cloud smoke, one guest
(`agent-payment-setup-resume`) logged `could not read Username for 'https://github.com'` and
`FATAL: could not fetch requested ref 5de02a3624` at 13:06:50Z. The boxes.dev daemon had rewritten
`agents/.env` and `back-end/.env` (`GITHUB_TOKEN`) at 13:06:49.3Z. The other 12 guests fetched successfully at
~13:06:22Z with the same controller-delivered token. That single INFRA_ERROR met the 1/13 infra stop and cancelled
the other 12 jobs.

## Diagnosis

Every guest receives its fetch credential once, when the controller launches it (`CLOUDBENCH_GITHUB_TOKEN_B64` in the
Machine env, the run wrapper, or the worker env file). It fetches minutes later, after boot and credential handoff.
All three delivery sites resolved that token with `cloudbench_controller_github_token`. Its candidates are the
devbox Git credential helper (`boxes-github-credential`), `gh auth token` and `.env` `GITHUB_TOKEN`. On boxes.dev these
are all the daemon-managed user credential. On this box `GITHUB_DISPATCH_TOKEN` is the same token (identical hash), so
it is not an independent fallback either. The daemon rotates that credential and revokes the old one. A guest that
fetches after a rotation presents a revoked token; git then asks for a username on a non-TTY and fails. In addition,
the fleet's refresh-deps path exported `CLOUDBENCH_GITHUB_TOKEN_B64`, which pinned one resolved token into every
later bench child. The fleet also cached its worker token for the whole run.

Repro (`scripts/tests/cloudbench-github-token.test.sh`, section 3b): resolve through the exact function each delivery
site calls (read from the scripts' source), rotate and revoke the devbox credential on a mock GitHub, then
authenticate as the guest. Unfixed revision:
`FAIL: machine-env: guest fetch after the devbox credential rotated was rejected (delivered the rotating devbox token)`.
Fixed revision: `ALL CHECKS PASSED`.

Archive search ("could not read Username" and "devbox daemon rotated GITHUB_TOKEN"): relatives, not a recurrence.
`2026-11-07-cloudbench-token-resolver-had-no-candidate-outside-the-drained-user-identity` added the App only as a
last-resort quota fallback. `2026-11-07-staged-cycle-goes-stale-when-daemon-rotates-github-token` covers the same
daemon rotation breaking the deploy cycle, not guests. `2026-08-19-refresh-deps-invalid-env-github-token` covers an
injected invalid token.

## Solution

Shipped in PR #1967 (merge `fa55807f276b`, 2026-11-15). The new `cloudbench_guest_github_token`
(`scripts/lib/cloudbench-env.sh`) is now used by every guest delivery site:
- `run-bench-cloud`: Machine env, run wrapper, and `resolve_github_token` for warm-box git-sync.
- `run-bench-fleet`: `controller_github_token_b64` for workers and refresh-deps.

Order:
1. An explicit `CLOUDBENCH_GITHUB_TOKEN_B64` pin.
2. A GitHub App installation token scoped to Contents read on `rose`, with at least 2700 s of life left.
   `scripts/github_token_pool.py app-token --read-repository rose --min-ttl 2700` mints it.
   It is cached apart from the unrestricted `pick` token, and `--min-ttl` must be finite and ≤ 3300.
   It is validated by a bounded `git ls-remote` that spends no REST quota. Nothing on the devbox can revoke it.
3. The previous controller chain, with a WARN.

The fleet also changed:
- `controller_github_token_b64` is now defined before `warm_deps_preflight` calls it. It was previously defined after that call, so it never ran.
- Resolved tokens are not cached.
- Each worker staging attempt rewrites the 0600 worker env with a fresh token.
- The refresh-deps export is confined to the pipeline subshell.

Controller-local identity (writes) is unchanged.

Regression: `scripts/tests/cloudbench-github-token.test.sh` §3b, registered in deploy cloudbench-controller.
It mocks a Git remote (dumb HTTP, Basic auth), rotates and revokes the devbox credential, and fetches with the
token each delivery site hands out. It also covers the metadata-only token, the absent-App fallback, an explicit
pin, the scoped export and the per-attempt refresh. Mutation checks confirm each assertion. It passes on git 2.43
and 2.47 and under CI-injected `GIT_CONFIG_COUNT`.

Outcome proof: a live App-token `git fetch` of `5de02a36…` succeeded. The final deploy smoke on `f47421dab0` passed
11/11, including `agent-payment-setup-resume`, and all 14 guest git-fetches succeeded with no fallback.

Pitfalls found while landing it:
- (a) CI runners inject Git config, so run fixture deliveries under `env -i`.
- (b) Git >= 2.46 with `credential.interactive=false` discards a password-only helper answer, so fake helpers must emit `username=`.

10k agents: one local pool call (disk-cached App token) plus one `git ls-remote` per guest launch; no shared lock, no per-agent state.

## Human feedback

None recorded.

## Reusable lesson

Hand a remote guest a credential whose lifetime you control and that nothing on the controller host can revoke, never the host's rotating session credential.
