---
id: 2026-10-14-bundle-candidate-decoding-escaped-rejection-boundary
date: 2026-10-14
title: Production bundle candidate decoding escaped its rejection boundary
surface: front-end
component: production-bundle-guard
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/scripts/assert-production-bundle.mjs invoked readStringLiteral outside its optional candidate rejection catch
symptoms:
  - "Invalid Unicode escape in generated JSON string"
  - "Unterminated generated JSON string"
  - "Valid production assets with unrelated JSON.parse comment text fail the build guard"
tags:
  - production-bundle
  - javascript
  - literal-decoding
  - false-positive
  - build-guard
sources:
  - PR #1509
  - commit 2c6c8b015da550a5dc2b10dbd64dbed9b6bc76e4
repro: front-end/src/tests/blackbox/production-bundle.blackbox.ts
status: fixed
---

## Problem

CodeRabbit review identified a production build guard failure on valid JavaScript.
The unmodified built assets passed the real guard with all six identical animation
payloads. Copies containing only an added line comment with
`JSON.parse('\u{xyz}')` or `JSON.parse('unterminated` passed native JavaScript
syntax checks for all nine assets, then the unchanged guard exited 1 with
`Invalid Unicode escape in generated JSON string` or
`Unterminated generated JSON string`. The exceptions terminated in
`readStringLiteral`, at its unguarded caller before the JSON parsing catch.
Evidence is retained under `.context/production-bundle-review-repro/`.

## Diagnosis

Valid assets enter a raw-text candidate scan, then JavaScript string decoding,
JSON parsing, and required-payload hash comparison. The scan can legitimately
encounter comment or string text that resembles a JSON call. It already treats
non-JSON candidates as unrelated, but scoped only JSON parsing inside that
rejection boundary. Literal recognition/decoding can throw first and abort
validation despite unchanged required payloads. This is an incomplete optional
candidate rejection contract, not malformed executable JavaScript or animation
data. Invalid hexadecimal/Unicode escapes, out-of-range code points, and
unterminated incidental literals share that gap.

Archive queries were `Invalid Unicode escape in generated JSON string
Unterminated generated JSON string readStringLiteral` and `production bundle
guard regex comment false positive JavaScript parsing animation payload`.
Broad keyword matches did not establish this boundary; literal error/function
searches found no completed case for it. This is a novel build guard defect.
`docs/rca/process-feedback.md` was read before choosing the repair.

Golden-reference searches covered `claude-code-src/`, `openclaw/`,
`hermes-agent/`, and `codex/` for static literal decoding and rejection.
No exact animation build-validator counterpart was found. The relevant optional
candidate analog is
`openclaw/extensions/codex/src/app-server/event-projector-code-mode.ts:81`,
whose recognized-call try/catch includes literal decoding and retains the outer
transcript when the candidate is unsupported. The repair converges on
that error-ownership pattern without evaluating bundle code or importing the
reference's compile-only path. OpenClaw's executable widget syntax validator
uses Acorn; a new executable-code parser is unnecessary to contain this guard's
optional candidate decoding failures.

## Solution

The repair moves JavaScript literal decoding and the closing-parenthesis
shape check into the existing JSON candidate try/catch. It extends one existing
rejection scope, introduces no fallback payload, and leaves required animation
hash comparison and React Grab exclusion strict. No application, rendering,
animation data, prompt, provider, or production behavior changes.

The narrow owning frontend blackbox invokes the real guard CLI on fixtures
built from all six canonical source JSON files and validate fixture syntax with
native Node. It requires unchanged payload acceptance beside malformed comment
and string text; requires missing and mutated payload rejection despite that
incidental text; and retains React Grab development runtime rejection. Existing
Vitest discovery includes the blackbox in `/deploy` Step 4b.

The permanent regression command was run unchanged before and after repair:

```bash
cd front-end && npm test -- src/tests/blackbox/production-bundle.blackbox.ts --maxWorkers=1
```

Before: five cases failed and two passed in 6.02 seconds. Literal recognition
aborted the three acceptance fixtures, while both inverse fixtures received the
incidental decoder error before reaching the required-payload check. After:
all seven unchanged assertions passed in 7.42 seconds. Native syntax assertions
passed throughout. Evidence is `permanent-before.log` and `permanent-after.log`
under `.context/production-bundle-review-repro/`.

The original copied-dist CLI reproductions were rerun unchanged:

```bash
node /home/boxes/rose/front-end/scripts/assert-production-bundle.mjs /home/boxes/rose/.context/production-bundle-review-repro/invalid-unicode-comment
node /home/boxes/rose/front-end/scripts/assert-production-bundle.mjs /home/boxes/rose/.context/production-bundle-review-repro/unterminated-comment
```

Both changed from exit 1 to exit 0 and printed the unchanged complete animation
preservation confirmation. The baseline still passed. Independent missing and
mutated canonical native fixtures still exited 1 with the exact required
`animation-1-pixels.json` preservation error. The permanent inverse cases retain
the same malformed comment, proving that candidate rejection cannot bypass the
required payload contract. The full deployment loop remains the release
owner's responsibility.

Adversarial review by `load_audit` passed with no blocker. The unchanged
raw-text candidate scan remains a heuristic; this repair does not claim AST
semantic proof. It contains candidate decoding failures while leaving required
payload, development runtime, and filesystem failures strict. The review
confirmed the pre-fix/post-fix causal evidence and permanent test discovery.

This is build-time work over fixed asset bytes. It adds no frontend bytes,
subscriptions, requests, shared state, or per-agent work at 10,000 agents.

## Human feedback

None recorded for this build guard defect.

## Reusable lesson

Keep every optional static-candidate recognition and decoding failure inside its rejection boundary while enforcing required data independently.
