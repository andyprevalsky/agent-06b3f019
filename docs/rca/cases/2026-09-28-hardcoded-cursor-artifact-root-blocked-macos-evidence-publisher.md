---
id: 2026-09-28-hardcoded-cursor-artifact-root-blocked-macos-evidence-publisher
date: 2026-09-28
title: Linux-only artifact root blocked the evidence publisher on macOS
surface: harness
component: publish-evidence-links
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/publish_evidence_links.py ARTIFACTS_ROOT and publish_llm_dump
symptoms:
  - "PermissionError: [Errno 13] Permission denied: '/opt/cursor'"
  - publish_evidence_links.py uploaded the Hub bundle but failed before rendering the last LLM dump or verifying the FE link on macOS
tags:
  - evidence
  - publisher
  - macos
  - artifact-path
sources:
  - agent d3dbf69f-b718-438a-8eea-0497d5898c69
  - commit a7f28146c8e847f131533834bd360c5c1e85d32b
repro: scripts/tests/publish_evidence_links_artifact_root.test.sh
status: fixed
---

## Problem

The `browser-smoke` RCA needed a durable FE link and rendered last-call dump for approval. `python3 scripts/publish_evidence_links.py --run-json <run> --agent-id d3dbf69f-b718-438a-8eea-0497d5898c69` uploaded the run bundle, then raised `PermissionError: [Errno 13] Permission denied: '/opt/cursor'` while creating `/opt/cursor/artifacts/rca_evidence/<agent-id>`. The helper never reached FE verification or dump rendering on the Mac workspace. The Hub upload did succeed; separate read-only `verify_agent_reachable` then verified the 67-message agent, terminated browser task, and attached recording.

## Diagnosis

The first bad boundary was the module-level `ARTIFACTS_ROOT = Path("/opt/cursor/artifacts/rca_evidence")`: a Linux Cursor Cloud location was treated as universal despite this repository also running `/RCA` on macOS. `publish_llm_dump` called `out_dir.mkdir` at that root and failed before producing the local artifact or the renderer's presigned HTTPS link. The archive searches `publish_evidence_links /opt/cursor/artifacts PermissionError macOS` and `artifact output path hardcoded Linux Mac evidence publisher` found the 2026-08-31 browser termination validation case as a relative issue in the same helper, not a recurrence of this path failure. `docs/rca/process-feedback.md` was read.

The owning-boundary regression `bash scripts/tests/publish_evidence_links_artifact_root.test.sh` was run against the pre-fix `HEAD` publisher module with `PUBLISH_EVIDENCE_SCRIPT_PATH=.context/browser-smoke-rca/publisher-baseline.py`. It failed at the same write boundary as the live run: `publish_llm_dump` called `out_dir.mkdir`, and the controlled Mac filesystem denied `/opt/cursor` with `PermissionError: [Errno 13] Permission denied: '/opt/cursor'`. The regression also checks Mac and Linux defaults, an explicit artifact directory override, and the path used to render and copy the JSON source. `git log -S` traced the hardcoded-root introduction to commit `a7f28146c8e847f131533834bd360c5c1e85d32b`.

## Solution

`resolve_artifacts_root` now honors `CURSOR_ARTIFACTS_DIR`, retains `/opt/cursor/artifacts/rca_evidence` on Linux, and uses the gitignored workspace `.context/artifacts/rca_evidence` on macOS and other local platforms. `publish_llm_dump` passes the same root's parent to `render_llm_dump.py`, so the renderer's local copy and the publisher manifest use the selected artifact tree. Browser task termination and recording checks remain fail closed.

The same regression artifact then passed against the fixed publisher with `bash scripts/tests/publish_evidence_links_artifact_root.test.sh`. `bash scripts/tests/durable-evidence-links.test.sh` passed with the existing browser validation checks. The real `publish_evidence_links.py --agent-id d3dbf69f-b718-438a-8eea-0497d5898c69 --skip-hub-upload` invocation completed on macOS, printed an R2 HTTPS dump URL, verified the 67-message durable FE agent, and wrote its manifest under `.context/artifacts/rca_evidence`. This affects developer evidence tooling only; 10,000 production agents have no new runtime call or cost.

## Human feedback

None recorded.

## Reusable lesson

Resolve developer artifact paths by platform and explicit environment configuration before writing evidence, while keeping cloud defaults and validation gates intact.
