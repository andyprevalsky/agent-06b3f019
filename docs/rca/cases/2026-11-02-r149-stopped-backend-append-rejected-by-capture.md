---
id: 2026-11-02-r149-stopped-backend-append-rejected-by-capture
date: 2026-11-02
title: Original-volume capture rejects a verified shutdown append to an active backend log
surface: infra
component: original-volume-capture
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "cross_check_receipts requires the stopped backend log to retain the byte length of an earlier active-driver observation"
symptoms:
  - Original capture exits1 after downloading its archive
  - Backend log grows by17129 bytes while retaining the exact observed prefix
  - Capture remains unverified without final native proof
tags:
  - r149
  - it35
  - capture
  - backend-log
sources:
  - commit f797a2c4a98f1d891c3c32eea48a4038c02edf8c
  - plan: It35 owner6561b0d8f0e34c0b9410ca2539a4b10a machine811193dc944218
  - plan: original capture14301 and failed-capture custody281b4250
repro: Actual original bytes fail the original comparator and pass the candidate comparator with only the historical output directory relocated
status: open
---

## Problem

The original It35 capture of machine811193dc944218 exits1 at `cross_check_receipts`: the captured backend log contradicts the byte length recorded while the driver was active. The held download remains unverified. This cleanup failure is distinct from the original task outcome, which is unchanged.

## Diagnosis

Full failed-capture custody SHA256 is281b42504f014a22a441e60ae7c8d1ce1c5326675d579eab0ea1012825b3d497. Its13-member held download is bad7f45acc55bfeada01eafb72c063b3dfe741920414f42f9c63ed5c2c23ed4c. The earlier backend body has6141997 bytes, SHA25628d9e8108af6c4491691b67aa67bf602fe9d43fe7a7c7998519a8edf38feaa0f, matching its provider-active manifest. The captured body has6159126 bytes, SHA256d346f6546550b13d6986d8810354cec466cc2f655fec11378a834d38f0cb3ebf. Every earlier byte is an exact prefix; the17129-byte suffix contains39 administrative database-termination errors and one server SIGTERM shutdown line.

The full existing parser finds unchanged root identity,13 browser sessions,28 allocations,13 browser mutations and one root creation; no payment evidence is added. Other observed artifact lengths match. The existing stopped-provider verifier validates the earlier manifest, stopped-Machine proof and provider cleanup receipts against the full captured log. The source nevertheless rejects backend length before that compatible contract can be used.

The compensation journal reports stopped/restored true, but final native Machine/Volume responses and successful capture provenance were not persisted. Neither the journal nor this offline comparison establishes final release. No failed download is retrospectively published.

## Solution

Frozen patchbc31202c4799d9da79b0cb235249ac2bb875d84572a32102e59acf29cc36cb54 changes the capture helper and its already registered forensic tests. Only a backend extension may use the exception: typed active/running/token-bound prior state, exact retained prior body and manifest hash, complete lines, at most64MiB total and1MiB appended, followed by the existing full stopped-provider archive verifier. Rewrites, truncation, missing evidence, changed ownership and appended payment evidence fail closed. Other artifact comparisons and ordinary same-length hash checks remain strict. Durable receipt checks record prior/captured/appended byte counts and hashes. Fresh final native proof remains mandatory.

The same actual-byte comparator replay is RED before and GREEN after. Its adapter relocates only the historical output directory; it does not rewrite original bodies or claim a native capture. Eight owning/collateral tests pass in five consecutive same-byte runs; the full registered module passes30 tests. Controls include malformed state, missing or foreign manifest/stopped proof/receipts, rewritten/truncated/non-UTF8/split-line/oversized logs, new ownership/payment evidence, and the real capture writer with transport mocked. Compile, private-index apply and whitespace checks pass. The reviewed candidate helper SHA256 is6548daca1c64ec064675eb67d1ddcc1748b54e0a3da70f3c0073d72b4e571ad8; its original test SHA256 is9bf1dba551c81776b32d54f68310baa7a1409850d015049235c82f2ddfcea0d9. The parent subsequently split nine test-only Ruff E701/E702 statements without changing their AST, producing test SHA256f0affe860f23d77c6a7d6bf319360b22d773f784e037fcc259b0cd8591b0820c; runtime bytes are unchanged. Independent review is GROUNDED for this comparator correction. The parent integration also passes all 30 registered tests (85.401 seconds), compile and archive validation; the test formatting-only delta has an identical AST and introduces no lint diagnostics. The operational capture remains OPEN until a fresh ordinary capture satisfies all current guards; no retry occurred in this investigation.

Two archive searches covered the literal mismatch and active-driver backend append. The closest prior case, `2026-10-06-forensic-archive-assumed-one-runtime-phase`, and the exact f797 stopped-provider verifier supply the relevant existing contract. Personally opened OpenClaw backup-manifest verification, Hermes archive-input validation and Codex session migration sources support explicit identity/hash validation, not a general permission to accept changing artifacts. Their SHA-bound excerpts accompany the review packet. Unrecognized log semantics or unlogged external effects are not proved absent by this parser.

## Human feedback

The user prioritizes native agent failures, progress zero and schema/validator data flow while keeping all failures in scope.

## Reusable lesson

An observation taken while a producer is active is not a terminal-file identity. Admit a later append only with the original bytes, bounded provenance and the existing full ownership verifier. A repaired comparator does not turn a failed capture into verified release or a failed task into success.
