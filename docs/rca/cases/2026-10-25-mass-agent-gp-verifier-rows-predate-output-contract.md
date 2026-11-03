---
id: 2026-10-25-mass-agent-gp-verifier-rows-predate-output-contract
date: 2026-10-25
title: Mass-agent first-level GPs completed with schema-incomplete output because their replayed verifier rows predate the output contract
surface: agents
component: demo-cache-mass-agent-fixture
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: DEMO cache rows fastmode:v42:llm:<gp goal hash>:verifier_execute:p:N — the recorded July verifier verdicts each GP replays carry no `output` (or a partial one), so the GP's structured_output holds only fields coalesced from its transcript
symptoms:
  - "Typed tree evidence shows incomplete first-level Task Complete outputs despite populated 14-field response schemas"
  - "Molly Maloof ae95295e displays only two outputs; Tim Ferriss 99887d92 displays five"
  - "output.creator_name: Field required"
  - "T7: 44 of 51 completion outputs do not satisfy their response_schema"
tags:
  - mass-agent
  - demo-cache
  - verifier
  - structured-output
  - response-schema
  - llm-judge
sources:
  - agent 1b40326c-0d56-4fba-8b7b-966b6f1a3c4b
  - fleet run 20261025-082331-22807
  - commit 0137ddae0
  - memory:mass-agent-fully-demo-cached
repro: agents/tests/blackbox/benchmark.blackbox.py::test_mass_agent_completion_outputs_must_satisfy_their_response_schema
status: fixed
---

## Problem

The final /benchmark full run on 4d0bec372 was 69/70. test-mass-agent-run-0 (r001-j0004,
root 1b40326c) failed the T7 judge: "incomplete first-level Task Complete outputs despite
populated 14-field response schemas: Molly Maloof ae95295e displays only two outputs; Tim
Ferriss 99887d92 displays five."

Validating with the verifier's own completion contract, only 6 of 50 first-level GPs have a
valid structured_output. The other 44 are missing fields or have mistyped ones (Tim's
`hook_formulas` is a str where the schema says list[str]). The distribution is identical in
every earlier cloud run, passing or failing, so the earlier PASSes were judge misses.

## Diagnosis

A GP's structured_output is the verifier verdict's `output`. In the run's worker.log, all 6
valid GPs replayed a verifier row that has an output (`Progress checked has_output=True`).
The 44 invalid GPs replayed rows with no output (43: 22 at score 0.5, 21 at score 1.0) or a
partial one (1); 11 of them had no stored row at all (`cold_namespace_passthrough`).

For Molly (ae95295e): execute_loop p:1 spawned the explore. p:2 is the end of the recorded
trajectory, and the verifier row at p:2 (`…a9edd0c280965a52:verifier_execute:p:2:c:7c36d994…`)
has score 0.5 and no output. The DEMO soft-pass then completed the GP holding only
`{creator_name, rank}`, coalesced from the transcript.

The rows were recorded under the older verifier contract, before ProgressScoreWithOutput.
The replay is faithful; the fixture is stale relative to the current response contract.
Coverage relied only on a nondeterministic LLM judge.

## Solution

- Data: `agents/scripts/regen_mass_agent_verifier_rows.py` replays each incomplete GP's exact
  recorded verifier request (from `llm.context.dumped`: messages, ProgressScoreWithOutput
  schema, pool) live once through `helpers.llm._call_llm_verifier`, using a leased compute
  token (served by gpt-6-sol-foundry / gpt-6.1-sol-foundry). It keeps the streamed record
  exactly as RoseClient.complete produced it and validates the output against the GP schema.
  It then upserts that record at the slot key through prod `/api/fast-cache/set`:
  - 33 existing rows rewritten, with backups;
  - 11 rows created at the request's `p:N` slot key.

  All 44 parsed outputs validate. 4 of 48 calls returned truncated JSON on foundry and
  succeeded on retry. Receipt: `.context/descend/descend-full69-20261023/ma5-verifier-regen/`.
- Deterministic coverage: tasks.json evaluator `t7-schema-complete-outputs`
  (`completion_structured_output_schema`) validates the root and every first-level GP with
  `_build_verifier_response_model`. It is red on the failing run.json (44 of 51 invalid) and
  green after the fix. The T7 judge is unchanged.
- No harness behaviour change and no nudges. The soft-pass is untouched; the data now gives
  it complete verdicts.
- Golden reference: `claude-code-src/src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:143-151`
  validates structured output against the schema and throws on mismatch rather than accepting
  it. The static check enforces the same contract on finished agents.
- Open: an agent can still finish COMPLETED with schema-incomplete output when a DEMO
  soft-pass promotes an output-less cached verdict. The static check now catches that for
  this task.
- 10k agents: no runtime change.

## Human feedback

Andy authorized changing the mass-agent task and DEMO cache without approval. The parent
required a deterministic static check in place of judge-only coverage, without weakening the
T7 judge, and no harness nudges.

## Reusable lesson

When a replay fixture predates a response contract, validate every replayed agent's output against its schema with a deterministic check and re-record stale rows from their exact recorded requests; never rely on an LLM judge to notice incomplete outputs.
