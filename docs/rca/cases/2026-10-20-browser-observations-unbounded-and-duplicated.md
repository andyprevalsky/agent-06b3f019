---
id: 2026-10-20-browser-observations-unbounded-and-duplicated
date: 2026-10-20
title: Browser evaluate duplicates unbounded values and page-state text has no bound
surface: harness
component: spawn-browser-agent-v3
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: service_actions._execute_inspection_action returns the raw evaluate value in both message and value; browser_use._format_browser_state_text returns unlimited page text
symptoms:
  - "llm.context.dump_skipped reason=payload_too_large"
  - "evaluate value: 1,891,249 chars; tool message in prompt: 3,782,525 chars"
  - "value copies in message: 2"
tags:
  - browser
  - evaluate
  - context-growth
  - result-limits
sources:
  - agent ee4bbcc2-2fe2-4be1-a7ad-2888caed87d9
  - commit 857211a277f369ea5acf378bb38d5cd5db9ce664
  - plan:/home/boxes/polar-600-resume/approvals/CP2-CP3-REAL-ERROR.md
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: open
---

## Problem

The retained Polar CP2 report attributes all five >=100k-token single-step
context jumps to evaluate results. In span 1bd1b672eeb9, a leaf-node query
included script JSON, and the next prompt grew from 387,962 to 4,165,781 bytes.
The report measures 3.4s versus 14.2s decision latency across that jump, but this
candidate has no post-fix task or latency measurement. The retained earlier dump
is browser_use_step_19 on the agent above; 47 subsequent dumps were skipped.
The recorded task concerns a first-child stroller comparison, not the synthetic
hotel data in the owning-boundary reproduction.

## Diagnosis

Untrusted page content enters `_execute_inspection_action` via CDP returnByValue.
The service embeds it twice (Python repr in message plus native value), and
`_browser_tool_result_for_history` retains both into the next model prompt.
The formatter separately admits all DOM text and page metadata. The deeper
owned cause is absent observation-size limits at the producer boundary, rather
than a timeout or a model context-window error. No context-length rejection was
reported. Retaining all old states is a separate design choice, not repaired here.

The two archive searches were `evaluate uncapped duplicated` and
`browser context tool result growth`. The compaction-token-accounting case
(2026-08-04) is a relative, not this cause or evidence of a recurrence.

The regression was run before production edits on the origin/main snapshot
above through the real dispatcher, history writer, and prompt builder with a
fake CDP. It printed 1,891,249 source characters / 3,782,525 tool characters and
failed the single-value assertion; the state test failed at 40,001 characters.
The same test functions then passed five consecutive fresh-process runs:
20,074 tool characters, value length 20,000; state length 40,000.
These are causal boundary proofs, not unchanged Polar outcome proofs.

## Solution

Proposed, unmerged and unapproved: preserve small native values, serialize only
oversized structured values to bounded JSON text, include a truncation marker
inside the 20,000-character value budget, remove the second value from message,
and cap complete formatted state text at 40,000 characters including its marker.
The page-state cap includes metadata as well as DOM. Raw internal DOM state is
not rewritten. State-history pruning and action-attached state are separate work.

Grounding opened in this session: browser-use 0.13.11 at
`/home/boxes/rose/agents/venv/lib/python3.11/site-packages/browser_use/`:
`tools/service.py:1913-1914` caps evaluate at 20k;
`agent/prompts.py:117,254-256` caps DOM at 40k;
`agent/message_manager/service.py:508,556-566` replaces a single state slot.
This converges on its sizes, with a stricter total-state cap including metadata.
`/home/boxes/rose/openclaw/src/agents/tool-result-limits.ts:4-8` caps live outputs
at 16k/32k/64k and 30% context share; its browser constants line 22 uses 40k.
`/home/boxes/rose/claude-code-src/src/tools/BashTool/BashTool.tsx:424` uses 30k;
`/home/boxes/rose/hermes-agent/tools/browser_tool.py:151` uses 15k snapshots;
`/home/boxes/rose/codex/codex-rs/utils/string/src/truncate.rs:15-26` includes a
marker inside a hard byte budget. These support bounded outputs, not identical
semantics or guaranteed task outcomes.

The two new tests are registered in `run_all_tests`, discovered by the existing
spawn-browser-agent-v3 runner, and therefore covered by `/deploy` Step 4g.
Validation: the complete `spawn-browser-agent-v3` domain passed (1 domain,
0 failures, 105.7s) from `agents/` via
`../agents/venv/bin/python scripts/run_blackbox_tests.py spawn-browser-agent-v3`.
An initial run from repo root failed two relative-path checks; that invalid
invocation is retained separately, not counted as a pass. Five additional
fresh-process pytest runs using `--import-mode=importlib` each passed both new
regressions (0.87/0.75/0.81/0.80/0.70s). Ruff 0.17.1 and the archive validator
passed. Evidence is in `/home/boxes/polar-p5/.context/p5/`.

The durable evidence publisher failed closed after dependency paths were
provided: it requires a UUID run ID, whereas the retained fleet run ID is not
one. The FE shell returned HTTP 200, but agent termination, recording and the
last-call rendered dump remain unverified. The packet must carry those gaps.

No paid reruns, deployment, merge, timeout change, benchmark edit, or history
pruning is authorized by this candidate. Outcome remains pending. At 10k agents,
limits are independent per observation with no new network calls, global locks,
or shared counters. CDP transfer and serialization still allocate the full raw
result before truncation; this is not a total-process-memory bound.

## Human feedback

User: "No paid reruns." User: "Leave 'keep only the latest full page state'
(history pruning) out of this commit." User: "do not label proxy causal proof
as unchanged-task outcome proof." No approval for the candidate is recorded.

## Reusable lesson

Bound model-visible browser observations at their producer and emit each value
once, while proving task outcomes separately from boundary regressions.
