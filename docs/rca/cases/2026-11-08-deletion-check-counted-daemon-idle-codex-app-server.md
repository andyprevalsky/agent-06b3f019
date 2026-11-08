---
id: 2026-11-08-deletion-check-counted-daemon-idle-codex-app-server
date: 2026-11-08
title: Deploy deletion-check counted the boxes.dev daemon's idle default Codex app-server as live work, so closeouts could never reach READY
surface: harness
component: deploy-cli-deletion-check
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_cli.py live_processes — any process whose cwd is in the checkout blocked unless is_harness_process matched; the daemon's shared Codex app-server matched no rule
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
  - PR #1792 (fix merged as cee8855e67, commit 658922b99c)
repro: python3 scripts/tests/deploy-cli.test.py IdleDaemonCodexServer
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

Fixed by PR #1792 (commit 658922b99c, merged as cee8855e67), which another workspace landed while this RCA's own
version was in review. PR #1790 then dropped its duplicate implementation in favour of the merged one, so the repo
keeps a single mechanism.

`idle_daemon_codex_server()` in `scripts/deploy_cli.py` exempts a process only when all of these hold:
- it is a `/opt/devbox-tools/codex/...` `app-server`;
- its parent's cmdline is the devbox daemon;
- it has no child process;
- no Codex session rollout under `~/.codex/sessions` has been written since its kernel start time.

Any other Codex process, or this one running a turn, still blocks. The regression is `IdleDaemonCodexServer` in
`scripts/tests/deploy-cli.test.py`, in the deploy structural gate `deploy-cli`.

Verified on the PR #1780 host: main's `live_processes(/home/boxes/rose)` no longer reports pid 4177674, and
`idle_daemon_codex_server(4177674, ...)` returns True.

Design note from the parallel attempt, for future changes here: the daemon's `~/.devbox/daemon/codex-sessions/`
directory is not a session record. Independent review of the daemon bundle showed that only the terminal wrapper
writes it. Managed Codex threads run inside the shared app-server and are tracked in daemon memory, so a check based on
that directory would hide a managed thread waiting on the model. The merged fix uses Codex's own rollout files and the
server's children, which a managed turn produces. The platform thread list
(`dvb-onbox threads list --scope project --all`, filtered by the daemon `config.json` `controlAuth.instanceId`) is an
authoritative alternative if rollouts ever stop being written at turn start.

Cost is O(1) /proc and directory reads per checkout process, plus one parent map. Nothing scales with agent count.

## Human feedback

None recorded.

## Reusable lesson

Before excluding a platform process from live-work checks, bind its identity to pid plus start time and prove idleness from the authoritative session record (the platform thread list), not a side-channel marker.
