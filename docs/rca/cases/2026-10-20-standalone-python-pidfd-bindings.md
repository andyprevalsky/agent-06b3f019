---
id: 2026-10-20-standalone-python-pidfd-bindings
date: 2026-10-20
title: Standalone Python omitted pidfd bindings used by controller recovery
surface: infra
component: controller-recovery
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: orphan-drain guest and export collector dereferenced optional os.pidfd_open
symptoms:
  - "AttributeError: module 'os' has no attribute 'pidfd_open'"
  - "module 'signal' has no attribute 'pidfd_send_signal'"
tags:
  - pidfd
  - standalone-python
sources:
  - commit 337c3f30f
repro: scripts/tests/cloudbench-controller-orphan-drain.test.py
status: fixed
---

## Problem

At main 857211a27, the agents venv (standalone CPython 3.11.9) failed
orphan-drain with three errors and resume-controller-export with one error.
The system Python 3.12 exposes both pidfd bindings; the pinned venv exposes
neither. The Linux host supports the underlying operations.

## Diagnosis

The recovery code assumed interpreter attributes were a kernel-capability
probe. The first bad boundary is the direct attribute lookup before opening a
bound process handle. The read-only export test also tried to mock an absent
signal attribute before exercising its validator. The collector's real
read-only path then encountered the same absent open binding.

Executed both exact suite commands with TMPDIR=/var/tmp and agents/venv/bin/python
on main, then the same commands on the candidate. Baseline logs are retained
at /home/boxes/polar-batch2-evidence/main/; candidate logs at its final/ directory.
Archive searches: literal pidfd_open/AttributeError and behavioral missing
platform process handle/native binding; no matching pidfd case. Available
claude-code-src had no pidfd analog; codex/openclaw/hermes-agent were unavailable
in this worktree. The local libc declarations are
/usr/include/x86_64-linux-gnu/sys/pidfd.h:31 and :46 (flags, siginfo, and return
values). The new real-handle regression checks noninheritability, signal 0,
and EBADF after close, forcing the absent-Python-binding path.

## Solution

The existing source-pinned collector owns one embedded pidfd adapter. It calls
the native Python operation when present, otherwise the identical libc
operation with explicit types, zero flags, null siginfo, and errno propagation.
The orphan guest embeds that same source. There is no numeric-PID kill fallback.
Collector source joins the orphan's new plan hashes; historical plans retain
their exact old source set and embedded command. Missing libc/kernel support
still fails closed. Read-only tests retain their no-signal traps when Python
lacks the signal attribute, and the AST validator also denies the named adapter.

Existing scripts/test.sh registers both affected suites. This is local
infrastructure causal proof, not unchanged benchmark outcome proof. No paid
benchmark ran. The user forbids agent delegation; no independent agent review
was performed. At 10k agents the adapter adds bounded local handle operations,
no remote requests, shared locks, polling or global state.

## Human feedback

User requested infrastructure-only integration and feasible repair of the
venv pidfd failures; prohibited paid runs, deployment, main merge and messages
to other agents. No product or harness approval is inferred.

## Reusable lesson

Preserve process-handle semantics across Python builds by testing the actual native operation rather than assuming an optional interpreter binding exists.
