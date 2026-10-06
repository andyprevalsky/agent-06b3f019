---
id: 2026-10-05-concurrent-controller-env-upsert-truncated-auth-keys
date: 2026-10-05
title: Concurrent controller token exports truncated complete dotenv files
surface: infra
component: cloudbench-controller-auth
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench_upsert_env_key performed an unlocked read followed by a truncating write to shared controller dotenvs
symptoms:
  - agents/.env became a 54-byte regular file containing only GITHUB_TOKEN
  - required Fly and backend keys disappeared during a 50-CLI campaign
  - a controlled sibling read observed an empty dotenv during token export
tags:
  - cloudbench
  - controller-auth
  - concurrent-env-update
  - atomic-publication
  - lost-update
sources:
  - PR #1299
  - agent /root actual cached50 auth-key-loss observation
  - agent /root/image_cli_cancel controlled owning exporter reproduction
repro: scripts/tests/cloudbench-github-token.test.sh
status: fixed
---

## Problem

During the actual 50-CLI campaign, the controller dotenv was observed as a
54-byte regular file with only the GitHub token key. Required Fly and backend
keys were absent. Private evidence remains under
`.context/fresh-cli-validation-20261005/`; no credential values are archived.
The root owner canceled the failed campaign, verified every exact local writer
and controller copy had drained, and restored the authoritative environment.

## Diagnosis

`run-bench-fleet` and non-image `run-bench-cloud` paths call
`cloudbench_export_controller_github_token`, which retains the intended live
controller credential in both process environment and local dotenvs. Its shared
upsert read the whole file without a lock, then `Path.write_text` truncated the
destination before writing. A sibling could read that empty interval and later
publish a one-key file. Two upserts of different keys could also each read the
same old contents, then discard one another's updates. Even identical token
exports rewrote the file.

The existing owning GitHub-token control now calls this actual exporter and
upsert with only explicit temporary paths and dummy credentials. Controlled
Python I/O barriers force the truncation/read and sibling-update interleavings;
they change no production function. The old implementation fails all three
assertions: complete-file reads, sibling-key retention, and no rewrite for
identical rendered content. The existing resolver and request-token wiring
controls pass before and after the repair.

Archive searches were `dotenv upsert concurrent env` and
`concurrent .env read-modify-write atomic`. The August 19 controller-token case
introduced this dotenv handoff to preserve correct request authentication; it
tested token selection and a single update's unrelated-key retention. It did
not exercise concurrent publication. This is a new failure at that existing
handoff's writer boundary, so removing the handoff would regress its original
contract.

The separate first warm-snapshot refusal occurred after a dependency-complete
marker and before a successful snapshot receipt. Timestamp proximity to the
dotenv observation does not prove the cause of that earlier operation; this
case makes no such attribution.

## Solution

Each upsert resolves the existing destination alias, acquires an adjacent
persistent `fcntl` lock, and re-reads the whole dotenv while holding it. The
lock inode is retained so later writers cannot accidentally lock a replacement
inode; process exit automatically releases ownership. Identical rendered bytes
preserve the existing file identity and modification time. Changed bytes are
written to a same-directory temporary file with mode 0600, flushed and fsynced,
then atomically replace the target. Ordinary readers see either complete old
bytes or complete new bytes. Existing symlinks remain intact.

Token resolution, process exports, explicit token handoff, dotenv rendering and
normal generous benchmark budgets remain unchanged. The repair touches only the
shared local upsert. At 10,000 controllers, equal tokens require short serialized
reads rather than repeated file publication; different updates are serialized
per destination and retained. No model, provider, shared-builder or task work
is added by the regression control.

## Verification

The unchanged final focused control failed old source with exit 1 in 0.58 s,
then passed the private repair with exit 0 in 0.52 s, with all five focused
controls green. The command unsets `GITHUB_DISPATCH_TOKEN` so the script's
optional live resolver cannot run. Additional assertions preserve the exported
process token, mode 0600 and dotenv symlinks. Terminating only the fixture's
exact Python writer releases its lock, preserves the full dotenv, and allows
the next writer to complete. Every fixture barrier is released and all owned
writers are joined even when an assertion fails. Private red/green logs stay
under `.context/env-upsert-race/`.

## Human feedback

The user requested safe stop-at-any-time checkpoints, parallel work, quick
regressions in the deploy path and unchanged authentication/result ownership.
The root owner required a dummy-file reproduction, full unrelated-key retention,
no real secrets or funded calls, and independent review before shared edits.

## Reusable lesson

Serialize the entire dotenv read-modify-write operation, publish changed files
atomically, and avoid rewriting identical contents. Correct token selection
does not by itself make concurrent credential handoff safe.
