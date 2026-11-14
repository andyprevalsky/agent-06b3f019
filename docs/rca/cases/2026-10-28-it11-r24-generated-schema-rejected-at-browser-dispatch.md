---
id: 2026-10-28-it11-r24-generated-schema-rejected-at-browser-dispatch
date: 2026-10-28
title: It11 generated nested session-file types are rejected at native browser dispatch
surface: harness
component: generated-schema-spawn-contract
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Generated and saved list[session_file_pointer] nested schema passes the generator but is rejected by SpawnAgentTool before browser dispatch
symptoms:
  - BU055 BU056 and BU058 root agents fail shortly after schema generation
  - Invalid parameters for spawn_agent reports a nested list[session_file_pointer] literal error
  - Native browser task did not complete successfully is the later generic root error
tags:
  - it11
  - r24
  - response-schema
  - browser-dispatch
sources:
  - commit 66eb9ccc4e39237bdd99b08f697180c7097a39bd
  - agent 5c3fc176-2810-4fa9-a8a5-4b171e1175ed
  - agent d97ff025-f9aa-4567-985f-c656daeb3d88
  - agent ab69d609-22b8-4901-86dc-6f5982da14d9
repro: Original saved schemas and native validation error records; no mutation or model replay
status: open
---

## Problem

R24 initially examined three unclassified task failures from It11. The exact
normal exports establish a shared schema-admission failure, not a shared cause
inferred from the outer status label. Original jobs remain FAILED with
infra_failure=false. No regrade, live operator change or benchmark rerun occurred.

| Job / task | Root | Normal archive SHA256 |
| --- | --- | --- |
| r001-j0005 / BU055 | 5c3fc176-2810-4fa9-a8a5-4b171e1175ed | b0b43cd47b95966aa62504ffca32be323b626bc17d8ab0786027b1aad4740e21 |
| r001-j0006 / BU056 | d97ff025-f9aa-4567-985f-c656daeb3d88 | d29370643afe03cb3c06524eeb40061bdc9ef58ca6dc18a378af144867a4c48d |
| r001-j0008 / BU058 | ab69d609-22b8-4901-86dc-6f5982da14d9 | 4fefa8c1af9357c2d4c7b6c3e65e1dddaedb50f9bc80b20ce05a360462124afa |

Each normal runtime manifest's seven members and all supplemental packet hashes
were verified against the actual bytes. Supplemental execution provenance
records exact66eb9ccc4e39237bdd99b08f697180c7097a39bd/no workspace patch; custody
records real mode. Teardown epochs are present. These are original normal-export
receipts, not fresh provider observations. Task-run hashes are respectively
04993cc048b10d6d10ba367821c1c441e2756d57bca774f5e8ce14cd69205f42,
d255468fe9f4832562a656f8c47d07d97dde9cd47577e12008137b0aaff3127e and
289edca45a3c9ac8e8471fae5f16a7c05aff11a87f2117a41f4c44659ce31295.

The unchanged tasks request Superchargers and nearby restaurants (BU055), NASA
launches and crews (BU056), and CVPR sponsors/years/tiers (BU058). These contracts
are not rewritten into file-production tasks or simplified to avoid this error.

## Diagnosis

The original saved schemas and messages show the first failing boundary:

| Task | Saved nested field | Rejection location | Error time UTC |
| --- | --- | --- | --- |
| BU055 | superchargers[].restaurants: list[session_file_pointer] | fields.0.properties.2.type | 20:22:32.114 |
| BU056 | launch_events[].crew_members: list[session_file_pointer] | fields.1.properties.5.type | 20:22:29.329 |
| BU058 | sponsors[].sponsorship_tiers: list[session_file_pointer] | fields.0.properties.2.type | 20:22:29.594 |

For all three, original messages[5] record the SpawnAgentTool literal-validation
error; messages[6] carry the same error in the matching background-task FAILED
notification. The task IDs are51dd2368-99d5-5f6d-9137-4dc252118f58,
1088d5d8-c9ba-5ad3-8540-5ab3edb1ce9c and6b75018f-aa63-538c-b28c-e36f84de1187
respectively (the raw metadata is authoritative). The rejection occurs after a
successful schema-generation/save activity and before the native browser task
can pass its typed dispatch boundary. The later root message is generic.

Source66eb's helpers/llm.py::_SchemaNestedFieldType accepts session_file_pointer
and list[session_file_pointer]; _schema_from_generated_model preserves these
values. workflows/browser_execution.py passes owner.output_schema into the
native background spawn. agent_workflow.py::_execute_tool_once validates against
TOOL_MODELS before the executor. utils/tool_schemas.py::ResponseSchemaPrimitiveType
and ResponseSchemaNestedFieldConfig do not admit either session-pointer type.
Thus the producer and dispatch consumer disagree on their schema vocabulary.
The original literal errors pinpoint this mismatch without a speculative model
explanation or an invented retry experiment.

BU055 and BU058 each have an initial Qwen/Cerebras schema request ending at its
output limit, followed by an existing larger-limit retry. Both retries finish,
and the generated schemas are saved. BU056 finishes its first schema request.
Therefore truncation-retry events do not explain these terminal failures.
Ten embedded request/update dump payloads were decompressed and verified against
their recorded hashes; five response-schema requests and five updates are
available. No separately exported request files were assumed missing after
these embedded originals were found. No browser verifier or Polar judge output
is established for these dispatch failures.

Root call/token counters are zero in the task summary, but the native schema
requests above are positively recorded; zero summary counters do not establish
absence of model work. No positive provider-infrastructure failure is identified.

Archive searches for session_file_pointer/spawn schema and generated/nested
schema found the prior explicit-URL spawn-validation and union-error-summary
cases. Their Solution and Human feedback were read. They concern different
validation boundaries and are not recurrence proof or authorization to widen
this schema blindly. Existing file_resolution.py distinguishes internal session
pointers from public file pointers. Whether these generated pointer fields also
misrepresent the requested nested factual records remains a separate semantic
question; simply allowing the literal does not prove the task is satisfiable.

## Solution

The source repair normalizes the public schema representation at
set_response_schema_activity using existing restore_schema_from_remote_session.
It runs after either a fresh generation or cache hit, before persistence and
return. The existing recursive helper makes a copy and replaces only the exact
internal session_file_pointer/list[session_file_pointer] type names with their
public file_pointer/list[file_pointer] equivalents. It retains fields, meaning,
constraints, required/nullable flags and order. The generator's internal types,
remote inverse transform and strict SpawnAgentTool validation are unchanged.
No prompt, provider, task, cap, retry or grading change is included.

The fresh independent R24-PUBLIC-SCHEMA-V1 review found exact three-path patch
bfc9b92dcee1ee207e80ae66cba5e6a72303b701173eceeecdaafb957c28877f GROUNDED.
The source base b7fd9331b9972dbb8f4b4c2aa3b8d7c177757c86 merges executed66eb
with main5fedf69abb, which adds only six factory history rows. No DB or live
operator source change was performed. The actual three captured schemas are
permanent fixtures, with their original task/root/run SHA identities.

The same registered activity-to-dispatch controls fail on the baseline for all
three captured nested type paths plus a synthetic nested/nullable case. The
candidate passes these and ordinary public/invalid-type controls. Cache hit,
cache miss, live generation, persistence/deferred return and roundtrip tests
preserve original input bytes and all non-type fields. The independent reviewer
also checked that arbitrary factual strings/restaurant dictionaries still fail
both public and remote file-pointer validation. These tests prove the carrier
boundary only, not that an original generated file declaration was semantically
appropriate for the requested facts.

Semantic file choice and full unchanged-task success remain OPEN. This repair
does not make facts into files, fabricate an upload, satisfy a user request, or
promote any original grade. The existing required-file delivery and separate
completion gates remain unchanged. No full real-task rerun was performed.
Post-apply actual-checkout verification: all five domains passed in11.0s
(new owning5, LLM256, browser-execution17, full file-resolution and tool-schema
suites). Archive validation passed1251 cases; diff and Python3.11 compilation
checks passed. Ruff is unavailable locally and is not claimed passing.

Local compact evidence is .context/rca-r24/original-boundary.json. All input bytes
remain untouched. Initial intake had only outer status projections; this normal
export analysis supersedes that availability floor. No provider, browser, model,
DB, controller, image or extra capture call was made. Tokens UNMETERED.

## Human feedback

Parent required separate causes until original evidence justified grouping,
no inference from root zero counters, no infrastructure relabeling, and no
active source or operator change while It11 runs. Only existing normal exports
were requested. Source66eb and original grades/clocks remain unchanged.

## Reusable lesson

A generator accepting a schema type does not prove that the next typed dispatch
boundary accepts it. Join the saved schema, exact nested validation path and
matching failed-task notification before diagnosing model or provider failure.
