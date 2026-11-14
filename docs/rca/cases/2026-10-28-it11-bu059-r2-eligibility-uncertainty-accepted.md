---
id: 2026-10-28-it11-bu059-r2-eligibility-uncertainty-accepted
date: 2026-10-28
title: It11 BU059 r2 completes with acknowledged scholarship eligibility gaps
surface: agents
component: browser-verifier-evidence-and-goal-coverage
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: native verifier acknowledges weak requested eligibility but returns task_completed true and score 1; exact general repair remains unproved
symptoms:
  - polar perfect-score failed (0/3 rubrics)
  - graduate-level eligibility is weakly supported for some of them
  - AAUW American Fellowship award amount is not in the visible evidence
  - Native browser verifier returns task_completed true with score 1.0
tags:
  - polar
  - it11
  - r31
  - eligibility
  - verifier
sources:
  - commit 66eb9ccc4e39237bdd99b08f697180c7097a39bd
  - agent db3ffc42-942c-42e3-956b-04ab9a75ce25
  - agent 07eb24c5-bb7a-4ae3-8146-af08d9de1512
  - plan: R42 archive e2eb0d335c8f78d0cd8ddc372736ad094db60961c1f8105795ea4cf2e77ed597
  - fleet run 20261028-214843-2725262
  - plan: normal archive 1c7226ec3b50ddcaab7684a0c074660a27f2f235105502d30cacf22fc3bad981
  - plan: normal manifest c3f7e6f81a778dd5dc14638d6a4c3cf0607a37d3b61e2d0214dce86afee9230b
repro: none-recorded
status: open
---

## Problem

Original BU059 r2 asks for five scholarships/fellowships specifically targeted
at or exclusively available to female graduate students, open to female U.S.
citizens studying computer science at U.S. universities. Each needs name, amount
and deadline. Its root completed; the task failed all three declared rubrics.
The root's completion is not the task's acceptance verdict. Infra remains false.
No criterion, grade, source or clock was changed.

All seven normal manifest members and separately labelled supplemental files
were checked against their SHA256 receipts. The archive is11853253 bytes;
run.json SHA256 is94b2c4775c11e7fa4d0e4cebd5c79411ef31775a576a2b4d20c3ed67541dd4fe.
Source66eb/no patch/real remains the original execution identity. This is separate
from R25 BU059 r1's post-completion credential wait crossing an activity deadline.

## Diagnosis

Original evidence establishes the following, without establishing a safe repair:

- Native browser verification starts at22:25:08.486624Z. Its actual encoded input
  is retained as dumpfca82864fcab, SHA256
  6bbc3f0dd9290519693c838b33f51ecd8c9d4c44ca3cd3ed741c6c3619688023.
  The response at22:26:06.340239Z, SHA256
  d0f88cdef0616a15e1be0b94d88c171a2c3cad7367bd13e8f7380fc6c99d34ad,
  says task_completed=true and score1.0. Gzip/base64 payload hashes were verified
  after local decoding; no provider request was replayed.
- The same response reasoning explicitly says graduate-level eligibility is
  weakly supported for some candidates. It identifies conflicting Google
  snippets, Hopper's ABET wording and Palantir's early-stage-student wording.
  Yet it selects those entries. These qualifications are not hidden solely in an
  earlier unseen document: the verifier itself records the uncertainty.
- The final schema contains five entries with required name, amount and deadline
  strings. Those fields are filled. This is not the R30 optional-file output-loss
  mechanism or R24 rejected internal file-pointer literal.
- Browser activity returns normally at22:26:23.032773Z after1875461ms; root status
  COMPLETED at22:26:54.431398Z. Task duration is1901.6s; host job join is
  22:33:38.917555Z. There is no50-minute expiry or stalled credential-finalization
  boundary in this record.
- The independent declared judge records C1=0 and C2=0 for unconfirmed requested
  eligibility, C3=0 for claiming an unavailable AAUW amount even though earlier
  trajectory evidence contains it. All three original scores are preserved.

For the AAUW detail, original message84 at22:07:48.665Z says American Doctoral
Fellowships carry a stipend of$25,000. Its text is5587 characters, SHA256
 a3650c9d3b578d618fb156609445d5ec754d37303190b68af2a35eb954ee5407.
The captured final preconversion context and encoded five-message verifier input
omit that exact stipend sentence and American Doctoral wording while retaining
other AAUW text. The verifier therefore reports that the amount is not visible.
This is a concrete evidence-selection difference, but not evidence that the
individual12k head/tail cap clipped this5587-character message. The precise
selection/custody path remains to be isolated. Restoring this amount alone would
not prove five eligible opportunities or reverse the independent C1/C2 failures.

Source inspection confirms native result acceptance uses the returned completion
and score under the current goal/schema contract; structured-field presence does
not itself establish all requested eligibility. No original user-requirement
change was identified. Do not classify the model as intrinsically incapable
without an unchanged captured-call controlled replay.

Archive searches: `verifier eligibility weakly supported scholarships` and
`AAUW amount missing evidence context`. Read the Oct20 child-answer12k and Oct14
requirement-version verifier cases' Solution/Human feedback. They are useful
relatives, not proved recurrences: this is neither an oversized child answer nor
an evidenced user-requirement revision race. R25 finalization remains separate.

## Solution

No runtime candidate, speculative test, model replay, prompt edit, cap increase,
provider change or altered evaluator. The useful next owning investigation is to
isolate exact native evidence selection for the5587-character AAUW result and
compare that with the preserved final verifier request, while keeping the
independently visible eligibility uncertainties separate. A general repair
would need causal controls that preserve native authority and full goal semantics;
text-keyword vetoes, automatic score rewriting, accepting five filled schema rows,
or dropping the eligibility requirement are not justified.

This bounded intake remains OPEN with original taskFAIL/infraFALSE. Full normal
root/source/mode and lifecycle receipts are retained. No live browser, provider,
DB, controller or publication operation occurred. Investigator tokens UNMETERED.

## Narrow owning-selection follow-up

The first mechanical omission was narrowed without changing production source.
`service.py::build_browser_verifier_context` takes `all_action_entries[-30:]`
for compact history and constructs `evaluation_evidence` from that same window.
Only older approved-card/auth-context entries have explicit carry rules. The
AAUW amount is evaluate step33; the actual final compact history begins at34
and ends at63. This is exclusion before the LLM TOOL_RESULT12k/160k admission,
not truncation of the5587-character result by the per-entry cap.

An offline call to the actual builder reconstructed saved step/action/params
and displayed evaluate values from original messages, with session-file listing
stubbed to its recorded empty value. It exactly matches the captured final
seventeen evaluate-step identities:
63,61,59,57,56,54,52,49,47,45,43,42,40,39,37,36,34.
Step33 and its stipend text are absent. Removing only the last recorded action
(step63) in the control moves33 into the existing30-entry window and preserves
the stipend text. No source, bound or provider operation changes in this probe.
Command: `PYTHONPATH=agents:agents/tests/blackbox agents/venv/bin/python
.context/rca-r31/selection-probe.py` exits0. This is a reconstruction of selection
membership, not byte parity of the full ActionHistory object or encoded request.
It is not a permanent regression for a fix; there is no proposed fix.

This reaches an intentional bounded-selection policy. Arbitrarily extending the
window, privileging scholarship/amount keywords, or increasing prompt budgets is
not justified. Letting every older evaluate compete within160k would require a
separately grounded admission policy and does not guarantee step33 survives the
actual full context. No such repair was implemented. The two independent
eligibility failures remain even if that one amount is restored. Stop at this
concrete floor; do not reopen R25 finalization or claim full-task repair.

## R42 original SWE-date omission (2026-10-29)

The R42 intake began at01:11:31.782901Z. Original It13 BU059r2/j0024/root
07eb24c5-bb7a-4ae3-8146-af08d9de1512 used source765caac with no patch.
All seven normal members match archive
e2eb0d335c8f78d0cd8ddc372736ad094db60961c1f8105795ea4cf2e77ed597 and
manifest9766d467be32b8104e967b653b110bd1fdec771b15a8dbc7e728c7f5bd9a81d5.
Native status is COMPLETED after1805.9seconds; the declared judge reports
C1=1,C2=1,C3=0, and original taskFAILED/infraFALSE are preserved.

The original SWE sponsor evaluations at action steps15 and17 state that the
Collegiate/Graduate application opens December1,2026 and closes February1,2027.
They follow the actual goto requests for swe.org/scholarships-overview/ and
swe.org/apply/. The receipts are5021 and3187characters, with hashes
545b038d2f2dca7ad5a1dc1f4f51cdd040ad07a68d58d6d425a42658c5373a6e and
b2ac6396d83e662964c0e7c4171fb71645385c3e4a7d63a7e685b103a22fcc08.
Later action55 reads a WIGSAT guide with a typical March/April deadline.

The final actor prose at01:02:58.558Z correctly repeats the sponsor's dates.
Neither date nor that prose is present in the captured preconversion verifier
context or its encoded model messages. The compact history starts at35 and
ends at64. Its fifteen separate evaluate receipts are exactly
64,62,60,58,57,55,53,51,48,46,44,42,40,38,36. Therefore the sponsor actions15/17
are excluded before TOOL_RESULT admission, while the later guide55 survives.
The original765 service still takes all_action_entries[-30:] and derives its
evaluate evidence from that same window, matching the mechanism above.

An offline call to the actual text converter exactly reproduces the captured
model messages after excluding the separately inserted schema-system block.
The converter reports60295/160000 tool-result characters and one truncated
result. The missing dates were already absent before conversion, so this is
not attribution to the12k result cap or exhausted160k budget. This replay
proves conversion custody only, not a model or full-task repair.

Native verifier request2ea5b9f6e48c has SHA256
2337edd132f17b8f13d3b31467dae3867ce8dc034ec4bc2175546cbe33f589d4; response SHA256
b04a2d6909aa65bdb7c5dd57432d00f384adef537ee1f488c070096640368694. The response explicitly selects the surviving guide's
typical March/April date and returns task_completed=true, score1.0. Its
structured output replaces the actor's current SWE date with that typical
window. The declared judge rejects this contradiction against the earlier
sponsor evidence. That is distinct from R38, where the contrary eligibility
facts were retained in the final native request and expressly discounted.

This is another observed omission under the same bounded selection policy,
not a regression of a claimed R31 repair: no such repair was applied. It does
not prove restoring one receipt would make the unchanged task pass. A larger
window, scholarship-specific preference, automatic trust in actor prose or
schema/prompt change is not justified by this intake. The existing general
admission-policy and outcome-proof gaps remain OPEN. No new runtime patch,
model/browser/provider call, capture, cap change or duplicate fix/test lane.
Tokens UNMETERED.

## Scoped source repair: full-history candidates under unchanged budgets

The earlier intake floors describe the source before this repair. On exact
source765caac00ce085dd0359b8342161a8717be7446d, the complete action history was
already privacy-projected and available. Native observation receipts used it,
but separate evaluate receipts were inadvertently selected from the compact
30-action view. The scoped repair changes only that evaluate comprehension to
use all_action_entries. It does not expand the compact log, model context,
per-tool12000-character cap or aggregate160000-character cap.

The existing latest-native-first and stable descending-step merge remains.
Native observations win equal-step ties; JavaScript results keep their explicit
untrusted attribution, original request/result pair and success/error state.
Missing values or unowned steps are not synthesized. History and final-context
privacy projections remain intact. Under pressure, a newer old-JavaScript
receipt can displace an even older native receipt. This tradeoff is explicitly
tested; neither lossless history nor universal preservation is claimed.

The new registered test
`test_browser_evaluate_receipts_outlive_compact_window_with_fixed_budgets`
fails on baseline because the expected steps46,3,2,1 become only46. The exact
candidate passes that same test and nine relevant existing controls covering
small histories, provider message bodies, native authority, privacy, failed and
conflicting results, payment/auth carry and bounded checkpoints. Both author
and independent reviewer ran all10 under pinned Python3.11.9 with no sockets.
The test also demonstrates oversized truncation, identical newer admitted
output despite an old-result flood, and possible oldest-native displacement.
After exact application, the registered new control passes on the actual
checkout in0.484s; compilation and archive validation are recorded separately.

Saved-input admission checks reproduce the original R31/R37/R42 converter
messages before modification, excluding the separately inserted schema system
message. R31 and R42 actor histories reproduce the original evaluate payloads
exactly. R37 has only the earlier actor history through44; its later selection
uses the exact captured final evaluate receipts plus non-evaluate placeholders,
so complete final ActionHistory parity is not claimed. The candidate projection
preserves all previously admitted tool-result lines in these three inputs and
changes actual tool-budget use from59306 to124720,35919 to66907, and60295 to103292
characters respectively. It restores the recorded AAUW stipend, restaurant
distances, and current SWE dates within the existing cap. These are deterministic
input projections, not model reruns or proof of factual correctness, eligibility,
file delivery, changed final answers or an unchanged task passing.

Approval BROWSER-EVALUATE-HISTORY-V1 exact two-file patch SHA256
6c5e16e36383402fbf0d268748529a3994885220380c6bfa5963599c15026fba was
GROUNDED before application by independent reviewer ph7eq6. The reviewer checked
the exact base/output hashes, independent baseline RED and candidate10/10 GREEN,
and portable supplied-text admission proof. The full original historical
custody remains investigator evidence, not claimed independently reopened by
the reviewer. Personally opened Codex context_manager/history.rs503–530,
554–573,680–690, Hermes context_compressor.py3311–3408, and Claude Code
services/compact/compact.ts230–286 support call identity and pressure-driven
bounded retention; none dictates Rose's exact limits or JS/native authority.
Their summarization/grouping differences are not imported here.

The source repair remains isolated from the executing765 checkout. Parent
integration must preserve R35's separate additions to the shared test file.
Older-context assembly and input cost can increase up to the unchanged limits;
production exposure and10k-agent cost are unmeasured. All original R31/R37/R42
FAIL grades, independent semantic gaps and full-task outcome remain OPEN.
No provider/model/browser/DB call, new capture, image or paid replay was made.
Original case and phase clocks are retained; token usage is UNMETERED.

## Human feedback

Parent required original first-bad evidence before grouping with R25, prohibited
reopening its durable-platform design on a different cause, and limited this to
existing normal exports without blocking the next useful experiment on an
unproved repair. Original scores and eligibility criteria must remain unchanged.

## Reusable lesson

Separate filled output fields, acknowledged eligibility uncertainty and omitted
source evidence before attributing a verifier's success to one failure mechanism.
