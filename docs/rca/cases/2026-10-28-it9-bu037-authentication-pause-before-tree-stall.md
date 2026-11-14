---
id: 2026-10-28-it9-bu037-authentication-pause-before-tree-stall
date: 2026-10-28
title: It9 BU037 waits for authentication help before the benchmark tree-stall failure
surface: harness
component: browser-auth-handoff
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Authentication help request and PAUSED wait precede the tree-stall detector; legitimacy of the help decision and underlying challenge cause remain unproven
symptoms:
  - "Browser paused while awaiting authentication assistance."
  - "status=PAUSED"
  - "silent for 521s (threshold=510s"
  - "silent for 520s (threshold=510s"
tags:
  - polar-bu-037
  - r20
  - it9
  - authentication-pause
sources:
  - commit 339894f88c95837c608b74c7a394ebc6fd338c6f
  - agent 9f0e3486-a045-4ac0-bb52-a0a23d4f5b2a
  - agent aa95bfa0-ab29-457b-a4c8-10a46921e07a
  - fleet run 20261028-080446-19664
  - fleet run 20261028-080447-19733
repro: none-recorded; original event chronology and source trace only
status: open
---

## Problem

R20 covers only the paired It9 BU037 failures. Run1 is root
9f0e3486-a045-4ac0-bb52-a0a23d4f5b2a, fleet 20261028-080446-19664; run2 is
root aa95bfa0-ab29-457b-a4c8-10a46921e07a, fleet 20261028-080447-19733.
The task asks to use Temu's search bar for wireless earbuds, sort by lowest
price, then list names and prices of the first five products. Neither original
run completed that task. Both remain taskFAIL/infra=false/released=true.

The complete two-part normal archive SHA256 is
49df9b9e07a20de9e0e229815ad414e35dc436672011ee55ec3f42bcd64c02d0,
size 129940574 bytes. Full hash and length match the parent's owner-confirmed
pin. Only these two fleets were extracted for analysis; the bundled BU023
comparison was not investigated. Both provenance files bind base_sha to
339894f88c95837c608b74c7a394ebc6fd338c6f and workspace_patch_sha256=none.
Embedded runtime manifests match:

- Run1 run.json0fc4aff899db49a4fd6bd08735b2c2d41355a814b165e1d43d12eb5f0afd8a46;
  worker0ff6cb64ee882ee0d04457d9dda952213f293e9ce9ce078dfe9fda8ca15d8dca.
- Run2 run.json487d1c9ad80f12f43a8451c903c689b64b72d036880f8affec8ba78d9d2d31fe;
  workera49c7295753fb0b5ddda5394250b76a0c5c8b36052929adcf39781a7f71daf77.

Original durations are 2289.9s and 1586.9s. Both raw task statuses are PAUSED,
not completed. Failure reasons record root silence521s and520s respectively
against510s, with no growing cost and one nonterminal leaf. No Polar declared
judge result is present. This is not a completed-task rubric failure.

## Diagnosis

The exact downstream sequence is shared, but the underlying authentication or
challenge cause is not yet proved common. The reported final paused message is
a consequence after the benchmark stall, not evidence of the first failure.

Run1 chronology from original worker and message rows:

- 08:40:19.177929Z: browser requests user authentication assistance.
- 08:40:25.868Z: credential propagation reports task_level, one credential ref,
  zero updates. This label alone proves neither invalid credentials nor a
  legitimate need for human help.
- 08:40:36.275797Z: request8d142373-1da4-4c71-9880-3f8f020336bf is recorded.
  Its native park observation binds task432ce693-5150-5e74-ad4d-9e4f0336c888,
  the root, session, request and observed Temu /login.html page.
- The driver repeatedly observes PAUSED with222 root messages and22c.
  It then records the521s tree-stall failure.
- 08:49:18.799755Z: worker receives PAUSE; 08:49:18.840Z: the manager emits
  Browser paused while awaiting authentication assistance. At08:49:19.042061Z
  execute ends paused. Thus this terminal chip follows the stall-triggered
  cancellation of a pending resume.

Run2 chronology:

- Recorded search navigation repeatedly leads to login/challenge pages. Step58
  returns HTTP403 with error_code40001 from the search API. Prior recovery rows
  say no stable configuration cleared the challenge. These are historical
  observations, not authorization for additional recovery or bypass.
- The recorded internal verifier gives0% and says it lacks any sorted wireless
  earbud product list. This is not a Polar declared-judge verdict.
- 08:29:29.026465Z: browser requests help. At08:29:35.320Z credential propagation
  reports captcha, one ref, one update. At08:29:51.705529Z request
  b562fd5d-c7d0-4b9a-9209-31c5e6fab7d1 is recorded, with a root/task/session-bound
  native Temu /login.html park observation.
- The driver observes PAUSED with153 messages and13c, then records520s silence.
  At08:38:35.361910Z the worker receives PAUSE; the terminal paused message
  follows at08:38:35.398Z and execute ends paused at08:38:35.570238Z.

The source supports this sequence without proving a defect:
handler.py's awaiting_auth_assistance branch marks workflow.is_paused=true,
updates tree state toPAUSED and waits for the matching response or resume/pause
change. A changed pause sequence emits _browser_abandoned_resume_event, whose
message matches the observed terminal chip. The benchmark's TERMINAL_STATUSES
exclude PAUSED. Its ordinary nonterminal-leaf rule compares tree, cost and world
model idle times to the unchanged limit, then returns the observed failure.

The catalog uses approval_handling=None. In run_benchmark.py the
fetch_approvals_now predicate enables attention polling only for auto_approve,
ignore, prompt_user or count_only. The zero approvals counters therefore do not
prove that no attention request was created: the native request messages exist.
This is an observed policy interaction, not proof that the harness must approve,
ignore, count as success, or wait indefinitely for external authentication.
No claim of a stale workflow, dropped response signal or successful sign-in is
supported by the current packet.

A key evidence limit remains. Final actor input dumps were skipped for size:
run1 last step85 dump4e8564654821 at5,313,645 bytes; run2 last step53
dump824c03101f5e at2,612,139 bytes. Last retained actor inputs are much earlier,
steps5 and22 respectively. Complete final model-input parity is unavailable.
The raw histories establish a help request and wait, but do not independently
prove that every permitted route was exhausted or that a different model choice
would complete the task. Native screenshots were not viewed or published.

Archive search `authentication assistance tree stalled` found earlier help/
stall cases. The prior It8 R11c Temu challenge/API failure is a lead only; it ran
to a different terminal sequence. No recurrence or shared first-bad diagnosis
was declared, and no prior case was appended.

## Solution

No repair proposed or applied. Do not bypass authentication or challenges,
force credential use, auto-approve help, count a pause as task completion, alter
the task, change its criteria, or raise/remove the stall/timeout limit on this
evidence. A valid human-help pause and an unattended benchmark failure can
coexist; deciding whether either behavior is wrong requires the missing decision
inputs and an explicit applicable contract, not the terminal error label.

Validation: exact full archive/hash/length, embedded run and worker hashes,
source provenance, original event/request/task identity joins, driver PAUSED
observations and source control-flow inspection. No causal registered red/green
or safe repair has been established. Any later protected repair needs the
required independent opened-reference grounding and owning causal controls
before application; unchanged real-task outcome remains OPEN.
No model/provider/browser/DB/controller calls, paid run, images, deployment or
active-parent mutation occurred. Own token usage is UNMETERED.

## Human feedback

The parent assigned only BU037 paired failures, prohibited examining bundled
BU023 as a new family, and required distinguishing legitimate user-help wait
from stale-workflow or benchmark-policy mismatch. It required original grades,
source and clocks retained, no speculative patch, no new reviewer/subagent,
no challenge bypass and no images. Earlier R14/R16/R18 cases remain separate.

## Reusable lesson

Join the original help request, native parked state, driver observation and
later cancellation before treating a paused terminal message as the root cause.
Do not equate zero harness approval counters with absence of a request when the
selected policy does not poll those requests.
