---
id: 2026-11-16-chat-grep-regex-gate-deadline-rejected-quadratic-unions
date: 2026-11-16
title: Chat-router grep failed a third of the time because the ReDoS gate timed out on allowed quadratic unions and merged searches rejected their own newest_first order
surface: back-end
component: data-grep-regex-safety
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/data/regexSafety.ts checkPatternSafety — no local proof covers a union of literal / literal.*literal branches, so it waits on recheck, whose fuzz classification (degree 2, allowed) takes 1.3-1.5 s, past the 1000 ms deadline, and fails closed; second defect at back-end/src/domains/data/validate.agent.ts validateAgentSourceSelection rejecting order newest_first on a merged agent_trajectories search that service.ts displayOrder already reads newest first
symptoms:
  - "[ChatHandler] Grep failed"
  - "Pattern safety analysis did not complete. Use a simpler expression without nested quantifiers or stacked wildcards."
  - "Unsupported grep parameter: 'order'. order pages an agent_trajectories search only when agent_trajectories is the only source; search it alone or remove order."
  - "Grep failed searching"
  - chat router grep routinely fails
tags:
  - grep
  - chat-router
  - regex
  - recheck
  - redos
  - deadline
  - order
  - agent-trajectories
  - strict-schema
sources:
  - agent ebb350db-303b-4e6a-b8b0-2d40dc9f9251 (production chat grep ERROR row)
  - agent 183c2dc3-0654-4910-b6fa-f78325117298 (production chat grep ERROR row)
  - agent eabeb732-2c95-40a6-8440-043939563d10 (production chat grep ERROR row)
  - agent 8789a5df-0119-4bbf-b90c-c7e58de56fe4 (production chat grep ERROR row)
  - agent 7f6107e2-e578-4536-bf5d-1aaa559ba016 (production chat grep ERROR row)
  - agent dd14af83-6910-48a0-a74d-722195e767e7 (production chat grep ERROR row)
  - agent a776e196-9606-42cf-8723-86361365562a (production chat grep ERROR row)
  - commit 562cc8c49008708918d15ee9844ab1c8c333062c (pre-fix main; replay reproduces all 9 errors)
  - PR #2427 (this fix; merged as b213386fd727185de5e4f6b0f61610a77d4bc5fd)
  - commit dede566e1fbf842985e4516f4c1ebbfa3d3f0fe0 (live Render deploy dep-dbto1j8ae00c739p8n2g, descendant of the merge)
repro: back-end/src/tests/unit/regex-safety.test.ts testWildcardLiteralAlternations (deterministic, 0 ms analyzer deadline); back-end/src/tests/blackbox/data-grep-contract.cases.ts chat-router cases and back-end/src/tests/blackbox/data-agent-task-path.cases.ts mergedNewestFirst (registered by data-grep.blackbox.ts / data.blackbox.ts)
status: fixed
---

## Problem

The user reported "chat router grep routinely fails". A read-only production
query of the web chat's terminal grep TOOL rows (`metadata.toolName = 'grep'`
with `metadata.grep`, text `Grep {...}`) found 27 chat-router greps between the
feature's launch on 2026-11-10 and 2026-11-16, of which 9 ended
`toolStatus: ERROR` (a third). Render logs show the matching
`[ChatHandler] Grep failed` lines. Replaying each stored argument set through
`validateGrepInput` reproduced all 9 outcomes exactly (and all 17 successes):

| Count | Error | Example arguments |
|------:|-------|-------------------|
| 3 | `Pattern safety analysis did not complete. ...` (each after ~1001 ms) | `azure.*credit\|credit.*azure\|azure.*spend\|spend.*azure\|azure.*justif\|justif.*azure` (`-i`, multiline); `(?i)(oauth\|verification\|security review\|google.*submit\|rose.*oauth\|oauth.*rose)` |
| 2 | `Unsupported grep parameter: 'order'. order pages an agent_trajectories search only when ...` | `sources: ["agent_trajectories","documents"], order: "newest_first"` (and `["agent_trajectories","agent_network"]`) |
| 3 | `Unsupported grep parameter: 'filters.gmail'. It is a block for the gmail source, which is not in sources (messages)` | the strict schema's 13 per-source filter blocks, with `person` copied into `gmail`/`email`/`imessage`/`whatsapp` while `sources: ["messages"]` |
| 1 | `Unsupported grep parameter: 'page_after'` | the model wrote one UUID into every field |

## Diagnosis

Critical path: Router decision (`routerDecision.ts`, strict `grep` object) →
`chatGrepRound.ts runChatGrepRound` → `userDataSearch.executeUserDataGrepTool`
→ `domains/data/grepTool.ts executeGatelessGrepTool` → `service.grep` →
`validate.ts validateGrepInput` → `regexSafety.checkPatternSafety` and
`validate.agent.ts validateAgentSourceSelection`. The arguments arrive intact
(the stored rows equal what the executor received); the first wrong output is
the validator's verdict.

1. Regex gate. After `(?i)` folding, `checkPatternSafety` tries three local
   proofs: `isClearlyLinearPattern` (at most one `.*` in the whole pattern),
   `isFiniteLiteralAlternation` (no `.*` at all) and
   `isClearlyAtMostQuadraticPattern` (no top-level alternation, no wildcard
   repetition). A union of `literal.*literal` branches matches none, so it goes
   to recheck under a 1000 ms wall-clock deadline. Measured locally, recheck
   classifies the three production patterns as `polynomial degree 2 (fuzz)`
   — explicitly allowed (`MAX_SAFE_POLYNOMIAL_DEGREE = 2`) — but only after
   1340-1527 ms, so every call ends `null` three times and fails closed with
   the "did not complete" message, adding 1 s to each turn. Why possible: the
   local proofs were grown shape by shape (2026-08-03, 2026-11-08 follow-up)
   and the union-of-single-wildcard shape, the most common way an LLM writes
   "A near B, either order", was never added.
2. Merged order. `validateAgentSourceSelection` rejects `order` on any merged
   search containing agent_trajectories. `service.ts displayOrder` sets
   `oldestFirst` only for a sole trajectory search with `oldest_first`, an
   all-message search or an all-calendar search, so a merged search with
   agent_trajectories always reads `newest_first`. The tool definition calls
   `newest_first` the default and says `order` is "Ignored for other sources".
   Both production calls sent `newest_first`: the validator refused the order
   the search already honors. This is the vacuous-satisfaction case
   `2026-10-25-agent-network-grep-rejected-advertised-record-kind` names in its
   lesson, missed for the merged branch.
3. Filter blocks (3/9) are invalid model arguments, not drift: the definition
   says "`{"<source>": {...}}` targets one source" and each source accepts only
   its own keys, which the validator enforces; the model recovered on its next
   call. Retained.
4. The UUID-in-every-field call is correctly rejected. Retained.

Archive searches: `rca_archive.py search "Pattern safety analysis did not
complete grep regex"` (relatives: 2026-08-03 regex-safety proof depended on
worker scheduling — same lesson, a sibling shape its proof did not cover, so a
failed guardrail; 2026-11-08 event-loop block — unrelated mechanism, its async
deadline is unchanged here) and `search "order pages an agent_trajectories
search only chat grep failed"` (relative: 2026-10-25 record_kind/order — its
lesson applies directly to class 2).

## Solution

- `regexSafety.ts`: new local proof `isWildcardLiteralAlternation` — a union
  whose branches are each a non-empty literal, or two non-empty literals joined
  by one `.*` or `.+` (zero-width `\b`/`\B` allowed), optionally wrapped in one
  unquantified `(`/`(?:` group spanning the whole pattern, flags `[ims]` only.
  Nothing repeats the union, so its backtracking cost is the sum of the
  branches' unanchored searches, each at most quadratic. Everything else (two
  wildcards in a branch, lazy wildcards, optional atoms, quantified or nested
  groups, prefixes/suffixes around the group, anchors, classes, escapes like
  `\w`) stays analyzer-owned and fails closed on an unknown or degree > 2
  verdict. The deadline is unchanged.
- `validate.agent.ts`: a merged agent_trajectories search accepts
  `order: newest_first`; `oldest_first` and `page_after` stay rejected by name.
- Regressions: the unit test proves the production patterns (and the measured
  `.+` / `\b` variants) locally under a 0 ms analyzer deadline, keeps over 30
  boundary shapes analyzer-owned, and checks that unions with an exponential or
  degree-3 branch are still rejected by the real analyzer. The contract blackbox
  replays the production chat-router calls verbatim through
  `POST /api/data/grep`. The task-path blackbox asserts that merged
  `newest_first` returns 200 with `display_order: newest_first` and that merged
  `oldest_first` stays a 400 naming `order`.
- Independent review (fresh sub-agent, no diagnosis given): reached the same
  four classes and first-bad boundaries before seeing this diagnosis. No
  counterexample to the proof: 430 random unions accepted only by the new proof
  were all rated degree ≤ 2 by recheck's automaton checker, and parsing-hole
  probes (lookarounds, scoped flags, `(a.*b)|(c)`, quantified groups, trailing
  escaped `)`, lazy wildcards, `***=`) all stay analyzer-owned. A further 40
  random `.+`/`\b` unions also rated degree ≤ 2 with no unknown verdict.
  Unit test 5/5 idle and 5/5 under CPU load.
- Remaining analyzer-owned degree-2 shapes still exceed the deadline. Examples
  measured by the reviewer: `oauth.*verif|google.?cloud.*submit` at 1269 ms and
  `(google|gcp).*(oauth|verification)|oauth.*review` at 1528 ms. Optional atoms
  multiply backtracking per optional (the existing proof caps them at one), so
  proving them needs its own argument. The SMS supervisor logged the same
  rejection three times (2026-11-11, 2026-11-13) through the same validator;
  its patterns were not logged, so whether this fix covers them is unverified.
  The rejection texts ("nested quantifiers or stacked wildcards"; "search it
  alone or remove order") are unchanged model-visible strings.
- 10k-agent behavior: an O(pattern length ≤ 1000) scan with no state, query or
  worker; it removes up to 1 s of analyzer wait and an analyzer slot per such
  grep from the shared backend.

### Shipped and verified (2026-11-16)

- PR #2427 merged as `b213386fd727185de5e4f6b0f61610a77d4bc5fd` through `scripts/deploy merge`: 17/17 gates PASS and CodeRabbit cycle 1 clean.
- Cloud smoke first failed before admitting any task. This sandbox's preinstalled flyctl v0.5.10 was refused by the relay ("unsupported Fly agent version"; the relay pins v0.4.115). The fix was the documented remediation from `2026-11-06-unlaunched-campaign-retained-cleanup-owner`: install the pinned client with `scripts/cloudbench-install-controller-client.py` and verify its SHA256. The zero-admission campaign was reconciled with a `campaign-startup-v1` proof (zero credit), and the rerun passed 7/7.
- Render service `srv-d3jga77diees73cgrvk0`: Render superseded and cancelled the merged deploy `dep-dbtnrq0ae00c739othu0` and the `31bc8e8d9` deploy. Live deploy `dep-dbto1j8ae00c739p8n2g` serves `dede566e1fbf`, a git-verified descendant containing the fix; it finished at 22:24:03Z.
- `scripts/deploy production`: PASS. Render passed verified-by-descendant. backend-probes passed 16/16 with no post-deploy log errors. Semantic passed via chat-lifecycle-ratchet run 43969750450.
- Production `POST /api/data/grep` replay (the chat router's validator) on the three formerly failing chat-router inputs:
  - Before the deploy (20:37Z): 400, 400 and 400.
  - After the deploy (22:24Z): 200, 200 and 200, with 36, 209 and 53 matches.
  - A normal grep returned 200. Merged `oldest_first`, `(a+)+$` and a degree-3 union still return 400.

## Human feedback

The coordinating agent asked that the regex fix preserve fail-closed behavior
for genuinely unsafe or unclassified patterns (no deadline increase), that
class 3 be fixed only if real schema/instruction drift existed (none found), and
that class 4 stay rejected.

## Reusable lesson

When a safety gate fails closed on an analyzer deadline, measure how long the analyzer takes on the shapes production actually sends and prove the allowed common shapes locally; a timeout on an allowed pattern is a false rejection, not safety.
