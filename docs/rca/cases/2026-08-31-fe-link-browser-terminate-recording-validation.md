---
id: 2026-08-31-fe-link-browser-terminate-recording-validation
date: 2026-08-31
title: /rca FE links cited agents whose browser tasks were still IN_PROGRESS without an attached recording
surface: harness
component: publish_evidence_links
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/publish_evidence_links.py:verify_agent_reachable — FE verification stopped at HTTP reachability and never checked browser terminate+recording
symptoms:
  - FE link validation missing browser terminate
  - Browser Agent In Progress toolStatus IN_PROGRESS after root FAILED
  - missing Browser recording saved / recording_view_url / recording_file_pointer
  - publish_evidence_links verified reachable without recording
tags:
  - rca
  - fe-link
  - browser-recording
  - publish-evidence-links
sources:
  - agent 453ab413-b29f-402d-ac71-6489edb2dceb
  - agent 5522bab2-3089-41c5-8ff4-5629b20703a5
  - PR #1164
repro: scripts/tests/publish_evidence_links_browser_validation.test.sh
status: fixed
---

## Problem

`/rca` returned durable FE links (`https://www.roselabs.ai/?agent-id=…`) that
were HTTP-reachable but still showed live browser chips: `action_type=browser`
with `toolStatus=IN_PROGRESS` and no correctly attached FINISHED recording
(`recording_view_url` / `recording_file_pointer`). DoorDash bench agents
`453ab413…` (Kernel replay present, chip still IN_PROGRESS) and `5522bab2…`
(no `task_complete`, recording started only) were cited as evidence while FE
browser state was incomplete.

## Diagnosis

Archive searches (`python3 scripts/rca_archive.py search "browser recording"`,
`search "FE link"`) hit related cases (ephemeral hub links, recording attach
on deletion) but not this exact contract gap — **novel** as a publish-path
validation hole.

Critical path: approval Evidence → `publish_evidence_links.py` → Hub
`GET /api/agents/:id` → FE chip derivation (`task_complete` closes panels;
FINISHED recording supplies Recording tab). `verify_agent_reachable` only
checked message count + FE HTTP, so incomplete browser state still printed
`verified reachable`.

## Solution

1. Skill + approval-format: one-line FE criterion that every
   `spawn_browser_agent` task must be terminated with recording attached.
2. `validate_browser_agents_terminated_with_recording()` in
   `publish_evidence_links.py` — fails closed on missing `task_complete` or
   unreachable/unfetchable recording.
3. Cemented by `scripts/tests/publish_evidence_links_browser_validation.test.sh`
   + durable-evidence / approval-format / structural gates.
4. Remediated prior FE agents on the durable Hub (552: inline HTML upload +
   `task_complete`; 453: chip status flip; both re-verified PASS).

10k-agent behavior: O(browser_tasks_on_cited_agent) probes at publish time only
— not on the live agent hot path.

## Human feedback

User required FE link validation that each browser agent has terminated and
recording is attached correctly; max one line in the `/rca` skill description
as the additional criterion; prior FE links must be brought to that state.

## Reusable lesson

Never mark an FE evidence link verified until every browser task on that agent has `task_complete` and a reachable attached recording.
