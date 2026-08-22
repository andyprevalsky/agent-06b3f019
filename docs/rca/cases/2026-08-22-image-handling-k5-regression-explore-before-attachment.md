---
id: 2026-08-22-image-handling-k5-regression-explore-before-attachment
date: 2026-08-22
title: image-handling k=5 pass regressed — execute agent explores WhatsApp instead of using rs.jpeg attachment
surface: agents
component: execute-loop / spawn_agent explore path
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents loop execute-phase first tool call — spawn_agent explore greps messages for "rockstar|blue logo" despite USER filePointer rs.jpeg already present
symptoms:
  - image-handling Timeout after 410s (dynamic cap=409s)
  - PIL.UnidentifiedImageError red_tinted_image is unpopulatable
  - spawn_agent explore rockstar|blue logo 1920x1080
  - maximum nesting depth (4) reached spawn_browser_agent
  - test.png messages:3d325c8d-638c-4f2f-9aca-ce94f76a9be8
tags:
  - image-handling
  - attachment
  - benchmark
  - spawn-claude-code-agent
  - explore-agent
  - k5-regression
sources:
  - fleet run 20260822-083840-568868
  - fleet run 20260822-034917-7332
  - agent 9d7d5919-5273-40a1-a09f-192ecb2b1d1e
  - agent 5dbbe353-ccc8-490c-9f40-896125be97db
  - agent 7e689bea-c4a1-43e7-97eb-880bfdad0cb2
repro: scripts/run-bench image-handling (observed failing on 20260822-083840-568868 and 20260822-034917-7332; pre-fix repro confirmed via sequential-rerun driver)
status: open
---

## Problem

**What failed:** `image-handling` passed 5/5 on a pass@k batch (`2026-08-21T18:35`, 44–222s, `COMPLETED`) but fails on both the daily fleet (`20260822-034917-7332`) and the isolated sequential rerun (`20260822-083840-568868`) with `Timeout after 410s (dynamic cap=409s) | Agent status: ACTIVE (expected COMPLETED)`.

**FE links:**
- Daily fail: `http://localhost:8765/open-agent?agent-id=5dbbe353-ccc8-490c-9f40-896125be97db`
- Sequential fail: `http://localhost:8765/open-agent?agent-id=9d7d5919-5273-40a1-a09f-192ecb2b1d1e`

**Evidence:** Run JSON shows the correct USER turn (`Make this image completely red-tinted…`) with `filePointer.original_filename=rs.jpeg` (`207364` bytes). The execute agent's **first** action is `spawn_agent` explore with goal *"identify the exact original filename… (1920x1080 Rockstar-style blue logo on black)"* and grep pattern `(?i)(rockstar|blue logo|1920.?1080|…)` over `messages`. Explore returns **`test.png`** from WhatsApp (`messages:3d325c8d-638c-4f2f-9aca-ce94f76a9be8`), not `rs.jpeg`. Subsequent `spawn_general_purpose_agent` calls use `attachments: null`. A `spawn_claude_code_agent` eventually runs but fails with **`PIL.UnidentifiedImageError`** / empty `extracted_output_files`; retries hit **HTTP 403** on Codex. Parent then spawns **12 `spawn_browser_agent`** calls, hits **`maximum nesting depth (4)`**, and stalls until harness timeout. Task contract expects only `spawn_claude_code_agent` (`tasks.json` `expected_tools`, `start_phase: execute`).

Among the 20 daily harness failures re-run sequentially, **only `image-handling`** had a recent pass@k=5 (5/5) batch before regressing. `agent-for-each` also had k=5 but **passed** the sequential rerun (daily timeout was fleet-load, not functional regression).

## Diagnosis

**Critical path:** benchmark attachment inject → USER message + `filePointer` → execute-phase LLM → tool choice → `spawn_claude_code_agent` with forwarded `rs.jpeg` → red-tinted PNG output → `COMPLETED`.

**First-bad boundary:** execute-phase LLM chooses `spawn_agent` (explore) to grep WhatsApp/message history for a "Rockstar-style" image **before** calling `spawn_claude_code_agent` on the already-attached `rs.jpeg`. Explore misidentifies `test.png` from seeded WhatsApp fixtures; downstream sub-agents inherit the wrong target. Recovery spawns browser agents and duplicate code agents until depth limit + timeout.

**Problem class:** `logical-inconsistency-in-harness-contracts` — task contract is "tint the attached file via code agent"; runtime behavior permits (and the model often chooses) a multi-agent search/recovery tree through unrelated message attachments.

**Not the root cause (downstream):** harness dynamic timeout (~409s) and `PIL.UnidentifiedImageError` are consequences of the wrong path + failed code-agent retries, not the initiating defect.

**Archive searches run:**
- `image-handling CHILDFAIL green variant` → no direct hit (relative: attachment forwarding cases)
- `attachment filePointer spawn_claude_code_agent not passed` → `2026-08-04-convert-context-to-messages…` (lead only)
- `benchmark attachment corrupted transit spawn` → `2026-07-03-benchmark-prompt-instructed-nested-explore-spawns` (same class: explore nesting on attachment tasks)

**Classification:** novel recurrence of explore-before-attachment on a task whose contract forbids it; not a prior fixed case.

## Solution

**Proposed fix (approval needed before implementation):**

1. **Execute attachment fast-path (product):** For benchmarks tagged `attachment` with `expected_tools: [spawn_claude_code_agent]` and `start_phase: execute`, bias or gate the first tool call to `spawn_claude_code_agent` with auto-forwarded parent `filePointer` (no explore-first). Option: system/tool rule "the USER filePointer is the source image; do not search messages/documents for alternatives."

2. **Spawn attachment forwarding (tool):** When explore/code-agent sub-goals reference "the supplied/attached image", auto-include parent USER `filePointer` if sub-agent `attachments` would otherwise be `null` (existing auto-forward pattern in `spawn_claude_code_agent.blackbox.py`).

3. **Recovery cap (product):** After first `spawn_claude_code_agent` FAIL on attachment tasks, retry once with explicit attachment re-upload; do not spawn `spawn_browser_agent` (task sets `requires_browser_agent: false`).

4. **Cement:** Extend `agents/tests/blackbox/spawn_claude_code_agent.blackbox.py` or a structural test asserting `image-handling` execute path does not emit explore-before-code-agent when USER has `filePointer`.

**10k-agent behavior:** Per-agent attachment forwarding stays O(1) per spawn; no new global fan-in. Explore gate is per-agent policy, not a shared channel.

## Human feedback

None recorded.

## Reusable lesson

When an attachment benchmark regresses after k=5 passes, diff the first execute tool call — if explore/grep runs before `spawn_claude_code_agent` while a USER `filePointer` exists, fix the attachment fast-path, not the timeout.
