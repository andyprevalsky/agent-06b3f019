---
id: 2026-10-26-presentation-guidance-urls-became-subagent-fetch-work
date: 2026-10-26
title: Root system prompt's scorecard style URLs became explore fetch work and timed out background-agent-message-smoke
surface: agents
component: root-system-prompt
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/utils/prompts.py MAIN_SYSTEM_PROMPT "# Presenting results as Rose scorecards" named remote GitHub/product URLs as the "visual source of truth", so a root put fetching them into its explore spawn goal
symptoms:
  - "Timeout after 182s (task timeout=180s)"
  - "Agent status: ACTIVE (expected COMPLETED)"
  - "For presentation only, also read https://github.com/Rose-Ai-Labs/rose/blob/main/front-end/src/index.css"
  - "the exact month was not captured in the truncated page content"
  - "Explore agent cancelled by user"
tags:
  - background-agent-message-smoke
  - prompt
  - scorecard
  - explore
  - spawn-agent
  - timeout
sources:
  - agent 9a3a8e6d-00bb-48f5-b645-b38594e73cba (fail, shard-01 r002-j0043, fleet run 20261026-044407-21856, source ae2f7366c)
  - agent e25463c6-bceb-43c2-9f09-3ba558d3807e (pass, 75.3s, fleet run 20261026-044408-21803)
  - commit 6d1dfa66d (introduced the URL-based scorecard guidance)
  - agent 66239187-4e88-418c-9c62-791d75ebacff (local run-bench pass 1 on the fix)
  - agent a093adae-02f5-49d1-87c4-7d106c7bf5d5 (local run-bench pass 2 on the fix)
repro: agents/tests/blackbox/prompts.blackbox.py::test_result_scorecards_are_in_both_root_prompt_phases
status: fixed
---

## Problem

background-agent-message-smoke failed with `Timeout after 182s (task timeout=180s)`.
The root was still ACTIVE, and its explore agent's third run was cancelled by
teardown at 04:55:13Z. The other copy (e25463c6) passed in 75.3s. Both copies
used the same source and the same shard.

## Diagnosis

The failing run's message timeline (run.json `logs.messages`):

1. 04:52:19 The root's `spawn_agent` fullGoal added: "For presentation only, also
   read https://github.com/Rose-Ai-Labs/rose/blob/main/front-end/src/index.css
   and .../report-display-format.md and briefly report Rose typography, theme
   tokens and report formatting." The passing copy's goal contained only the RFC work.
2. 04:52:33 The forwarded marker was delivered correctly: send_message_to_agent
   ran, the inbox row was written and the explore consumed it. Inbox, wait_for
   and the grace hand-off all worked.
3. 04:53:12 The explore split its turn budget between the RFC pages and the
   GitHub files. It reached "I'm on my final turn" without fetching the GitHub
   files and without capturing the RFC month.
4. The root resumed the same explore twice to close those gaps (04:53:23, 55s
   run; 04:54:31). Each resume repeated the GitHub reading request or followed
   from it. The third run was cancelled at the 180s deadline.

Every LLM call and web_fetch finished in about 2–10s. There was no provider
stall, no stalled tool and no wait that failed to wake. The time went to
unrequested presentation research.

Step 5a:
- Why 1: The root delegated fetching the style files. Evidence: the spawn goal above.
- Why 2: The root system prompt presented those files as URLs and called them
  "the visual source of truth". The only fetch restriction covered the five
  product references ("do not fetch them on every reply"), not the repo files.
- Why 3: The presentation guidance was not complete inline. Following it
  required remote reads. Nothing scoped it to the root's own final reply, so it
  could leak into sub-agent goals as task work. Stop here: the fix is to make
  the guidance self-contained and scoped. It also prevents sibling leaks, for
  example a root spawning a browser or explore agent to open the five product URLs.

Golden reference: claude-code-src/cli.js:7775 (`# Tone and style`) gives
presentation rules inline in the system prompt, with no remote style source.
claude-code-src/cli.js:7749 forbids generating URLs unless they help the task.
The fix converges on both.

Step 5b (prompt edit). Class stopped at: "LLM-visible presentation guidance
must be self-contained and never create task work". Next-deeper class tried:
"no system-prompt section may contain URLs". That was not coherent. Some
sections must name real task endpoints or tools, and some URLs are evidence
the user provided. The constraint holds only for guidance that is not part of
the task, so it stops at presentation guidance.

## Solution

`agents/utils/prompts.py`:
- Replace the two GitHub URLs with the essential Rose tokens, taken from
  front-end/src/index.css: Geist/Inter, light #f9f9fb/#111117 with white cards,
  html.dark #272725/#ecece8, and a 0.75rem radius.
- Name the five craft references without URLs.
- Add: "Presentation is your own final step: Never fetch style references or
  add presentation work to a sub-agent's goal."

The regression in `prompts.blackbox.py` asserts:
- the scorecard section contains no `http` or `github.com`;
- the inline tokens are present;
- the scoping sentence is present.

It fails on c37a063da and passes after the fix. At 10k agents the prompt has
fewer tokens and causes no network work, and nothing grows with agent count.

Outcome proof: on the fix, the unchanged task passed twice in a row with
`scripts/run-bench --local background-agent-message-smoke`: 66.9s (66239187)
and 66.0s (a093adae). Neither spawn goal mentioned style files. A local failure
on the buggy revision was not run. The parent waived it because the failure is
nondeterministic, and the cloud r002 failure is the original evidence.

## Human feedback

None recorded.

## Reusable lesson

When a root over-delegates, check whether a system-prompt section that is not
part of the task contains URLs or other external references it must resolve.
Inline that guidance and scope it to the agent's own reply.
