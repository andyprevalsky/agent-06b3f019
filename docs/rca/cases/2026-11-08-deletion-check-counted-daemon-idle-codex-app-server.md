---
id: 2026-11-08-deletion-check-counted-daemon-idle-codex-app-server
date: 2026-11-08
title: Deploy deletion-check counted the boxes.dev daemon's idle default Codex app-server as live work, so closeouts could never reach READY
surface: harness
component: deploy-cli-deletion-check
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_cli.py live_processes — any process whose cwd is in the checkout blocks unless is_harness_process matched; the daemon's default Codex app-server matched neither the daemon-helper rule nor any idle-service rule
symptoms:
  - "OPEN  live process 4177674 in this checkout: /opt/devbox-tools/codex/versions/0.166.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex app-server"
  - "DEPLOY_DELETION_CHECK NOT_READY open=1"
  - "codex app-server --listen ws://127.0.0.1"
tags:
  - deploy-closeout
  - deletion-readiness
  - boxes-devbox
  - codex
sources:
  - PR #1760 closeout deletion-readiness.json (NOT_READY, sole item pid 4102777 codex app-server)
  - PR #1780 closeout deletion-readiness.json (NOT_READY, sole item pid 4177674 codex app-server)
repro: python3 scripts/tests/deploy-cli.test.py DeletionCheck.test_the_daemons_idle_default_codex_server_does_not_block_but_a_session_does
status: fixed
---

## Problem

The `scripts/deploy deletion-check` step of `/deploy` could not reach READY on a boxes.dev devbox. On the PR #1760 and
PR #1780 closeouts its only open item was a `codex app-server` process with its cwd in `/home/boxes/rose`. Each deploy
had already preserved every ref, archived evidence and stopped all owned processes, yet the receipt stayed NOT_READY,
so the scorecard could not certify SHIPPED.

## Diagnosis

The process is the boxes.dev daemon's default Codex app-server. Its parent is
`/opt/devbox-runtime/node/current/bin/node /home/boxes/.devbox/daemon/bundle/sprite-daemon.mjs`. It started at devbox
boot (00:43:22Z, before any deploy work). The daemon records it in `~/.devbox/daemon/codex-default-app-server.json`
with `pid` 4177674, `statStartTime` 10508393 (equal to `/proc/4177674/stat` field 22) and
`workspaceKey: /home/boxes/rose`. `~/.devbox/daemon/codex-sessions/` was empty, and `dvb-onbox threads list` showed this
devbox's only thread to be the Claude deploy thread.

`live_processes` treats any process with its cwd in the checkout as live work unless `is_harness_process` matches.
`is_harness_process` recognizes only daemon helpers (`~/.devbox/daemon/...`, `/opt/devbox-tools/bin`, and
daemon-script node processes). It deliberately keeps agent sessions (claude, codex) blocking. That is correct for a
Codex session, but this server hosted none, and the CLI never consulted the daemon's own record of which server and
sessions exist.

Reproduction on the real host: the `origin/main` `live_processes(Path('/home/boxes/rose'))` returned `[4177674]`.
The fixed version returns `[]` with the same daemon state.

## Solution

`is_idle_default_codex_server(pid)` in `scripts/deploy_cli.py` excludes the process only when all of these hold:
- the daemon record names exactly this pid with the same kernel start time, so a reused pid never matches;
- its parent is the devbox daemon;
- `codex-sessions/` exists and is empty.

Anything unreadable keeps the process blocking. If a Codex session exists, the server blocks again, as do other
agents' sessions. The regression in `scripts/tests/deploy-cli.test.py` (deploy structural gate `deploy-cli`) runs a
real child process in the checkout and covers the idle case plus five blocking cases: no record, an active session, a
reused pid, a different pid and a non-daemon parent. Cost is O(1) file reads per checkout process; nothing scales with
agent count.

## Human feedback

None recorded.

## Reusable lesson

Before treating a platform process in a checkout as live work, consult the platform's own record of that service and
its sessions, and bind the identity to pid plus start time.
