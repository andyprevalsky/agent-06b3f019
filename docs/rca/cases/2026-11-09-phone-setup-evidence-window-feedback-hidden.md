---
id: 2026-11-09-phone-setup-evidence-window-feedback-hidden
date: 2026-11-09
title: Phone setup evidence-window rejection lost corrective feedback
surface: agents
component: phone-setup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: phone.py PHONE_GUIDANCE selection contract and _request non-success projection
symptoms:
  - Setup observations must be the current uninterrupted cursor window
  - Cloud iPhone result Failed
  - Portrait verification returned HTTP 409 before a setup journal existed
tags:
  - phone-setup
  - evidence-window
  - safe-error-feedback
sources:
  - PR #1896 normal physical acceptance
  - agent e10145fe-5ef9-55fc-8a6a-2b6b7a88bb1c
  - task 803e5368-c270-5743-a2bc-2ee70207205e
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_phone_setup_window_rejection_feedback_and_latest_observation
status: open
---

## Problem

The original normal setup task's call_QSXP9BZzGbpehW261m0Ajcno at
2026-11-09 23:25:35 UTC submitted portrait verification observations at
cursors 12 and 14. A successful input.tap occupied cursor 13. The original
model-visible result was success=false and _httpStatus=409; its UI message
was only Failed. Later verification attempts reused cursors 12 and 21.
The task stayed in setup and was subsequently paused by its owner. The original
physical acceptance is not complete, and no cleanup or acceptance PASS follows
from the candidate's local tests.

## Diagnosis

Two archive searches preceded the candidate: `setup.*observation|uninterrupted.*cursor|consecutive.*evidence`
and `phone.*error.*(hidden|discard|opaque)|phone.*feedback|redaction.*evidence`.
Related cases read were 2026-10-18-phone-results-omitted-from-browser-verifier-history,
2026-10-18-phone-setup-claim-and-unknown-fences, and
2026-10-20-public-phone-redaction-erased-trusted-identity-evidence. This incident
is distinct: the result and observations existed, but the selected window was
invalid. The adapter also discards the known rejection in the executed owning replay; the original wire body is not claimed captured.

The exact workflow history identified browser activity 207 and its cancelled
completion 290. Its encrypted, authenticated paused snapshot retained the exact
original call and public result. Only operation identity and safe result fields
were extracted; no private arguments, credential bindings or pixels were exported.
The native operation metadata independently maps the submitted IDs to successful
screen.text cursors 12 and 14 with the intervening tap13.

The backend requires consecutive successful screen.text IDs ending at the current
cursor. No current cursor can make [12,14] consecutive. At current14 its expected
window is [13,14]. That request therefore cannot pass the owning predicate.
The original wire rejection body was not retained: another preceding409 guard
is not independently excluded. This limit does not make the actual selected
window valid. Later operation-mode409s after blocking/pausing remain separate.

phone._request reduces all non-success responses to _httpStatus; the UI producer
uses result.get(error, Failed). This discards even the known constant setup-window
rejection, leaving the model without the correction it needs. Guidance said
current observations without explaining the consecutive-window requirement.

## Solution

The implemented follow-up preserves every backend consecutive-window, current-cursor,
revision, 120-second freshness, custody and privacy guard. Guidance says to
normally use only the latest fresh screen.text ID after navigation; multiple IDs
must be adjacent reads ending at the current cursor. It adds no two-read requirement
and does not alter internal portrait text/frame/text capture.

Only the exact existing backend literal `Setup observations must be the current uninterrupted cursor window`,
only on HTTP409 from the setup endpoint and within a bounded response, maps to
local constant code phone_setup_observation_window and corrective guidance.
Raw upstream/provider text, unknown errors, additional fields, wrong endpoints,
wrong statuses and oversized bodies never become public feedback.

The new owning tests reproduce the original missing-feedback failure and preserve
valid single-latest evidence. Security negatives exercise private and unknown
bodies. One sealed causal pair uses literally identical command argv, unchanged
test/driver bytes, and only the ignored phone.py SUT changes: original SHA
15303f9bfdd0f956116224f05540b60097d110cf8c4fae70ee8a85689284f10e gives
0/2 (native1), fixed SHA
f907e0ff718f9fa6727bc647206483349e9e148abb8cbf88c6ef450c92bf99f1 gives
2/2 (native0). Measured walls are recorded in identical-command-pair.json.
The focused owning suite is11/11, including nine unchanged methods; five
additional unchanged new-test runs are2/2. All supervisor receipts are quiescent,
no orphans, no TERM/KILL, no remaining children. Full domain tests and production
physical acceptance remain parent-owned and pending. Status stays open.

## Abstraction and simplification review

Step5a ladder: (1) The model submitted nonconsecutive IDs12 and14 across input13;
(2) the public selection guidance does not define the backend's uninterrupted window;
(3) the adapter's deliberate opaque-error boundary removes even a stable, locally
known window rejection. The deepest proved owned class is privacy-preserving,
actionable feedback for explicit current-observation validation failures. It covers
gapped IDs, duplicated reads, and a selected window that does not end at the current
cursor; the implementation never branches on incident IDs, task names or benchmark data.

Step5b stopped at that class. The next broader class tried was uniform automatic
repair or corrective disclosure for all phone HTTP rejections. That cannot have one
coherent safe recovery:403 authorization,409 unconfirmed physical outcome, stale
setup revision and provider failures have different authority, and unknown bodies
are deliberately opaque to protect credentials. Automatically substituting evidence
or replaying input would cross the documented seen-context/custody/no-replay contract.
This is a source-contract design analysis, not a claimed runtime experiment or
historical pre-design golden research. No model-intelligence limitation is claimed.

Step6a delete/unify/guard: deleting native window validation would admit stale proof;
deleting opacity for arbitrary remote failures would disclose untrusted or private
content. Deriving or replacing explicitly supplied evidence IDs would silently change
the requested verification and conflict with the deliberate seen-intent contract.
The current request/result boundary is already shared by all setup targets. Unify the
window's wording there, then add only the bounded exact native-rejection projection;
retain every unknown error as opaque. No extra retry, timer, cache or recovery state
is introduced. The additional JSON decoder exception handling keeps a2200-byte
nested response an ordinary opaque rejection instead of creating uncertain recovery.

Golden references opened during review of this candidate, not before the initial
implementation: Codex `codex/codex-rs/apply-patch/src/file_update.rs:155` rejects missing
context; `codex/codex-rs/core/src/tools/handlers/apply_patch.rs:366` returns the verified
rejection to the model, while373 uses a local constant for malformed input. Hermes
`hermes-agent/tools/file_tools.py:1039` teaches a fresh read and1176 documents its
current-baseline gate; `hermes-agent/tools/file_tools_write_guards.py:594` refuses
unread/stale writes. OpenClaw `openclaw/src/agents/tools/mobile-ui-tool.ts:455` requires
a current snapshot and479 consumes its authorization; `openclaw/src/agents/tools/computer-tool-guidance.ts:130`
requires fresh observation for stale refs and forbids blind replay. Its apply-patch
context errors at `openclaw/src/agents/apply-patch-update.ts:116` are another analogue.
These align on useful local rejection feedback without accepting stale state. Rose
remains stricter: no tolerant phone-cursor matching and no arbitrary provider-body
reflection. The three reference implementations do not authorize weakening Rose's
physical custody or privacy invariants.

## Review findings and validation limits

The first independent review rejected the packet's missing canonical fields and
noted that the original wire literal was unretained. It also found a concrete bounded
JSON recursion case: the initial candidate caught ValueError but not RecursionError.
The same new test observed this candidate fail and the revised decoder pass; all
original backend admission and public opacity assertions remain intact. First review
and superseded hashes are retained rather than relabeled clear. The final prompt
approval, complete new-source deploy gates and original physical Connect acceptance
are pending; the case remains open until those outcomes are witnessed.

## Human feedback

None recorded for this specific incident. The standing user requirements to preserve
Freedom and finish the normal phone setup/deploy remain in force. Parent-agent
coordination corrected an unnecessary two-read assumption and required an unchanged
owning reproduction; those are agent review facts, not human approval or feedback.

## Reusable lesson

When a model must satisfy a strict evidence-selection contract, state that
contract and return narrowly allowlisted corrective errors; keep authoritative
backend validation and unknown-error privacy intact.
