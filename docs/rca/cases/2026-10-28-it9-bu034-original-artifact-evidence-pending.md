---
id: 2026-10-28-it9-bu034-original-artifact-evidence-pending
date: 2026-10-28
title: It9 BU034 final artifact and judge evidence pending normal export
surface: harness
component: investigation-evidence-availability
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: investigation has a C2 terminal reason but not the original final artifact and handoff; runtime cause unproven
symptoms:
  - polar-bu-034 r002-j0049 failed C2 with two of three rubrics passed
  - final output at steps 228 and 238 provides only /files/response-headers
  - requested APA database list with descriptions not presented according to terminal judge reason
tags:
  - polar
  - it9
  - bu034
  - file-pointer
  - evidence-pending
sources:
  - commit 339894f88c95837c608b74c7a394ebc6fd338c6f
  - agent a77b62bf-d8af-41dc-acd9-0efdb89bc38d
  - fleet run 20261028-075834-14280
  - plan: row packet sha256 e7870a69c4401e3909c9343ce124860a598997aada502e7837773f11c33de1b2
repro: none-recorded
status: open
---

## Problem

Initial availability notes below are historical; the normal-export follow-up
at the end supersedes that availability floor.

R17 is a bounded read-only intake of It9 BU034 repetition2. The original row
records job `r002-j0049`, root `a77b62bf-d8af-41dc-acd9-0efdb89bc38d`, fleet
`20261028-075834-14280`, finished `2026-10-28T08:28:17.922151+00:00`.
It records task_status FAILED, exit1, infra=false and released=true. Wrapper
status passed is not task PASS. The row reports 2/3 rubrics and a C2 failure.

According to the terminal judge reason, APA names/descriptions were gathered
and a readable list drafted at step167, but final228/238 provided only
`/files/response-headers`. These are quotations from the result row, not an
independent reconstruction of the actor, artifact or judge input. A pathname
alone does not prove that the file contains incorrect data or that the task
passed. The original task FAIL is preserved.

Failed raw-row SHA256:
`04998f3724e8b84b0a2f6f4ccecdc629de8637b07a02a6ed5d4fd7f66244ab1a`.
PASS sibling row `r001-j0019`, root `b8da4e4d-330a-4b20-97aa-cf614328f606`,
fleet `20261028-075834-14206`, SHA256:
`aabfe8897e6b4751aa43f72ad7895185e651995980f699d612f8388ffc702076`.
Both rows are in the original supplied packet, whose SHA is above.

Unchanged catalog SHA256:
`0b631780c080d1022f5acb52400bbe46e81a45337a832f288a3641bc495796a9`.
Exact task:

    Access the APA research database portal and list all available databases (such as PsycINFO, PsycARTICLES, PsycTESTS) along with a brief description for each.
    website: https://apa.org

The three semantic Polar rubrics, browser requirement and100-step maximum are
unchanged. No minimum step value is authored.

## Diagnosis

OPEN at an investigation-local availability floor. The normal verified export
has not yet supplied the actual generated output schema, actor final content,
verifier response, artifact content/metadata or exact three judge inputs. This
is not a runtime capture-loss diagnosis, formatting diagnosis, artifact-content
failure, model limitation or proven transport defect.

The source establishes places to inspect, not which one failed:

- helpers/llm.py preserves verifier structured output and separately admits an
  explicit task_completed verdict.
- Browser handler11745-11806 retains structured output, extracts session files
  and resolves declared file references against extracted metadata.
- helpers/file_resolution.py450+ resolves partial references using the declared
  schema and already extracted files.
- Browser manager14634+ forwards structured output and emits output files as
  ASSISTANT attachment messages.
- polar_evaluator.py206+ builds the rubric trajectory from supplied root/child
  messages, including scoped recorded evidence.

Need exact values through those boundaries: schema type and fields; step167
list and final228/238 payloads; verifier task_completed and structured_response;
artifact bytes, hash, MIME and resolved pointer; posted attachment metadata;
root final handoff; all three judge request bodies/responses. Compare the same
chain in the PASS sibling. Do not fetch new artifacts from providers or infer
file contents from the name. The source's generic support for file output does
not establish that this run used it correctly.

Archive cases about missing schema fields or accidental static-asset downloads
were read as leads. Neither is a demonstrated recurrence without the originals.
R15 BU029 is a separate open family and was not re-investigated here.

## Solution

No runtime change, speculative regression, schema rewrite, prompt hint, limit
change, regrade or new run. The owner was asked for the existing normal export
and already archived referenced-file bytes for both exact roots. Resume this
case when they arrive. A later causal repair requires the same owning registered
red/green proof and exact independent opened-reference GROUNDED review. Exact
unchanged-task outcome proof remains separately required.

Local row/catalog/source-hash receipt: `.context/r17-it9/intake-receipt.json`.
Actual scope BU034 only; token usage UNMETERED.

## Human feedback

The parent specified a five-minute milestone and ten-minute read-only intake,
normal existing exports only, no extra provider/controller/guest/DB/browser/model
calls and no inference from the C2 quote or a file path. Preserve genuine FAIL,
infra=false and released=true. Stop at an honest investigation-local OPEN floor
while originals are pending; do not call that missing runtime capture.

## Reusable lesson

Trace the actual artifact bytes, typed pointer, final handoff and judge input
before blaming output formatting or treating a file path as a completed answer.

## Normal export follow-up: unresolved file survived failed extraction

Combined two-part normal packet SHA256:
`b65ed672299969dc5b31a9e32325e2e89fe5fe9359fa078b9bb7b70632fd1a6f`.
Owner reports verified shard-00 original export and30/30 released. Analysis uses
local copies only. Failed run.json SHA256:
`b69afd0d68b9f7d9a728afabccbb55916f8b513ff9c22c39babd3ec3665d6607`.
Indices here are zero-based logs.messages indices, not judge step numbers.

The stored failed root schema requires apa_databases_file of type file_pointer,
with description "File containing every available APA research database with
its name and brief description." The literal task requested a list, not a file.
This records a generated representation requirement; the generator request and
response are not proven by the stored schema alone.

Verifier176 and189 refuse completion because no downloaded file exists. The
actor then attempts to manufacture a download via httpbin response-headers
with APA entries encoded in query parameters. Verifier226 says session_files
confirms2079bytes at /files/response-headers and treats the encoded request as
a file containing the list. This is not independent verification of those
bytes. Earlier149byte download observations are also present; they must not be
silently treated as the final2079byte artifact.

Worker event at08:22:39.981226Z says "[Extract] Processing:
/files/response-headers". At08:22:40.024558Z it says "[Extract] Failed to
download: /files/response-headers". Despite that failure, terminal233 reports
success=true and structured_response apa_databases_file={path:
/files/response-headers}. The only emitted attachment in this failed run is
screenshot_final.png. Root verifier238 accepts the same partial pointer and
completionSummary240 retains it. No full id/storage_path pointer for the
requested file is present. No response-headers artifact bytes were found among
packet entries; this does not establish what bytes existed on the provider.

The owning source path explains how this survived: service.py684+
extract_session_files skips an entry on a failed download; handler.py11761+
then resolves references against whatever files were extracted, including the
final screenshot. file_resolution.py535+ _match_partial_to_full returns the
original value if no filename matches. The handler then closes and emits a
successful completion without a separate unresolved-reference check.

A local exact-function replay used the source AST (including the actual
PartialFilePointer class and recursive resolver helpers), recorded structured
response/schema and emitted screenshot pointer. It returns the same unresolved
path with is_partial true. Receipt and reproducible script:
`.context/r17-it9/replay-resolution.json` and
`.context/r17-it9/replay_resolution.py`. This is a baseline boundary observation,
not a red/green fix or full activity replay. It does not prove the download's
underlying failure reason, nor authorize changing generic partial-pointer
semantics used by other owners.

The PASS sibling takes a different route: its file-backed catalog resolves to
an uploaded screenshot with id/storage_path, and verifier83 describes the list
visible in that screenshot. No screenshot was opened in this investigation
(the user prohibited images); these are recorded metadata/verifier statements,
not a fresh visual validation or independently proven sibling correctness.

The original C2 FAIL stays unchanged. Current diagnosis is a concrete failed
artifact-materialization/unchecked partial-reference handoff, plus an unproven
schema-generation choice and unknown download cause. A safe repair needs exact
caller ownership, compatibility for legitimate session pointers, real failed
extraction controls and independent opened-reference review. No runtime change,
new model/provider/browser call, speculative regression, regrade or criteria
change was performed. Compact indexed evidence is stored at
`.context/r17-it9/original-analysis-evidence.json`. Scope BU034 and pinned
sibling only; tokens UNMETERED. Case remains OPEN for a qualified causal repair.

## Qualified R17 caller-owned repair

Independent reviewer ph7eq6ca0cp3vnxvh8qh26c4ts8h5bmt returned scoped branch
GROUNDED for exact two-file patch SHA256
`2b3a70b0a2c6e99fc3164b76c679ed389c9c3663ebfeb14e5328cffe2feedf0d`.
The earlier37865 candidate was NOT_GROUNDED because it rejected explicitly
nullable required file fields; it was never applied. The final guard preserves
native nullable single/list None, optional absent values, explicit
session_file_pointer contracts and ordinary non-file outputs.

After native extraction and reference resolution, the browser completion caller
checks schema-declared durable file outputs. An unresolved required file takes
the existing recoverable rejection path before session closure or success.
It does not rewrite the verifier score or data, substitute another file, change
the shared resolver, or alter caps, task schema or criteria. The fixed feedback
does not echo raw private file paths. Cancellation retains its native cancelled
result. Existing full-pointer trust/basename matching is unchanged; this guard
does not prove file-content correctness.

The registered full-handler causal test uses original schema/output and emitted
screenshot metadata. Baseline completed after actor1/judge1 with the unresolved
path; unchanged test now waits for actor2/judge2 and a genuinely resolved fixture
pointer, closing once. Native-schema nullable single/list controls pass in one
turn, cancellation and12 schema boundary cases pass;17 existing
instruction/schema/privacy/extraction controls pass. Pinned Python3.11.9.
The corrective successful pointer is an explicit offline fixture, not a claim
about the historical task. Tests are registered in the existing domain suite.

Golden mechanisms opened: Hermes tools/send_message_tool.py279-291 and499-523
(refd94b70f675205c2c046138997819428772cd2678) prevents full success after failed
media delivery; Codex core/src/tools/handlers/view_image.rs159-182
(ref14ff9c3a43ebf9bf543cf5f7c45cff2bfea2e512) surfaces metadata/read failures;
OpenClaw src/media/outbound-attachment.ts15-33 and web-media.ts956-985
(ref76ddbf697fc263cc1bf89fe3f4d08d96ed4a43af) loads actual bytes before staging
an outbound attachment. Contrary Claude BriefTool/attachments.ts70-82 allows a
local descriptor after optional remote-upload failure; the Rose guard preserves
explicit session-only pointers and targets the durable-file contract instead.
These are mechanism analogs, not equivalent storage or privacy policies.

Historical evidence publication remains limited. One original publication and
one explicitly authorized retry both failed canonical recording validation.
An authorized one-sign/one-fetch probe retrieved the real21373947-byte HTML
recording, SHA256
`f591731842664b309f57a3f45fddf2f1fcfad5b08fe8f4b1b587350d740af3b1`.
Offline canonical analysis explains the gate: initial Kernel episode identity
has no matching saved recording; later Steel recording does not establish its
coverage. No metadata was rewritten and no recording synthesized. Actual last
archived call polar_evaluator1793175867037-fa8d69a512c6 was recovered, but this
does not clear historical FE/recording coverage. Standing branch-repair policy
keeps that gap separate from strongly grounded causal source repair.

This section supersedes the earlier no-runtime-change intake status only for
the qualified mechanism fix. Original BU034 C2 FAIL, unknown artifact content
and download cause, schema-choice question and unchanged real-task outcome
remain OPEN. No paid rerun, model/browser/provider-resource operation or deploy
was performed to validate the patch. Freedom and resources preserved.
