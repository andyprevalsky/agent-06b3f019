---
id: 2026-07-23-provider-cache-affinity-not-scoped-to-one-sequence
date: 2026-07-23
title: Provider cache affinity was not scoped to one logical sequence, so sibling explore tasks evicted each other's prompt cache
surface: cross
component: provider-cache-affinity
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: provider routing/usage identity — routing namespace, Codex affinity headers, and persisted usage did not all carry the same logical-sequence identity
symptoms:
  - sibling explore tasks evict each other's prompt cache
  - one-shot web summaries pollute the repeatable-cache ratchet
  - cache hit rate collapses across concurrent tasks in one agent tree
tags:
  - prompt-caching
  - cache-affinity
  - explore-agent
  - codex
  - fast-mode
sources:
  - PR #856
repro: cache-sequence regressions across provider routing/usage identity and structured-write key isolation
status: fixed
---

## Problem

Cache affinity leaked across logically independent work: concurrent sibling
explore tasks evicted one another's prompt cache, and one-shot web summaries —
which by definition are never reused — polluted the repeatable-cache ratchet that
measures cache health. The result was cache hit rates that neither reflected nor
rewarded real prefix reuse.

## Diagnosis

Cache identity was not carried consistently end to end. The routing namespace, the
Codex affinity headers, and the persisted usage record each derived their identity
differently, so two calls that belonged to the same logical sequence could land in
different cache scopes, and two calls from _different_ sequences could collide in
the same scope. Structured Fast Mode writes did not include the sequence in their
cache key at all. Because Temporal activity dispatch, DAG parameter population,
verifier, final-verifier, summarizer, context-compression, and approval paths each
re-derived identity, the sequence was lost at whichever hop forgot to propagate it.
The deepest owned cause is a missing single identity that every hop must carry —
not a defect in any one call site.

## Solution

Scoped provider cache affinity to one logical sequence end to end: the routing
namespace, all Codex affinity headers, and persisted usage now carry the same
identity, so sibling explore tasks cannot evict each other and one-shot web
summaries cannot pollute repeatable-cache ratchets. Structured Fast Mode writes
include the sequence in their cache key, and the Temporal activity, DAG parameter
population, verifier, final-verifier, summarizer, context-compression, and approval
paths all preserve it through usage accounting. Cemented by cache-sequence
regressions covering routing/usage identity, structured-write key isolation,
Temporal activity propagation, DAG parameter population, verifier/final-verifier,
summarizer/context-compression, approval flows, stable same-task and isolated
sibling explores, unique one-shot summaries, and fail-closed positive ratchets. The
merged head's smoke run measured 48.5% aggregate cache hit (browser biometrics
68.8%, spawn sub-agents 45.6%, browser smoke 46.1% repeatable-cache hit).

## Human feedback

None recorded.

## Reusable lesson

Prompt-cache affinity needs one logical-sequence identity propagated through every
hop that routes, writes, or accounts for a call — otherwise concurrent siblings
silently evict each other and one-shot work corrupts cache metrics.

## October 8 WMH adapter recurrence and explicit-prefix verification

The new native WMH call site bypassed the logical-sequence convention fixed
above: `RoseWMHProvider._complete_async` called Rose without `cache_namespace`.
Existing sequence regressions covered normal agents and tool helpers, but not
this adapter. The user identified the missing provider-prefix-cache test after
run `bbbdb300-bde5-4386-8463-cbef0cba9319` reported **0 cached reads across
1,813,251 WMH input tokens**. This is an adapter recurrence of lost affinity,
with an additional explicit-prefix layout defect; the original July rollout
and its results remain historical evidence, not proof of this local change.

The traced path is native task JSON → WMH provider message conversion →
`RoseClient.collect`/complete → OpenRouter request transform → provider usage.
The captured system is only 887 tokens under `o200k_base`. The native SDK sorts
JSON keys alphabetically, placing the changing `candidate_response` first;
the common user prefix across all 75 predictions was only 63 characters.
Shared root task and initial context followed this changing action. Rose's
default system/whole-opening-user markers therefore did not mark a long,
reusable prefix. OpenRouter documents a 1024-token OpenAI minimum and explicit
breakpoints for newer models:
https://openrouter.ai/docs/guides/best-practices/prompt-caching.

Six live calls replayed two exact saved logical inputs through the real
`_WMHCacheSafeRoseClient.collect`, with DEMO response replay disabled. Every
call used actual `openai/gpt-6.1-sol`, xhigh, 16384 output tokens, one outbound
request and no retry. Each condition used one cold input A and a different
warm input B. Source system text and all task/action/state/history/example
values were independently checked against the captured wire; only JSON order
and text-block boundaries changed.

| Condition | A cached reads / input | B cached reads / input | Pair token hit rate |
| --- | ---: | ---: | ---: |
| Original request | 0 / 2203 | 0 / 13428 | 0% |
| Task first and common session affinity | 0 / 2203 | 0 / 13428 | 0% |
| Explicit task-prefix breakpoint and affinity | 0 / 2204 | 1368 / 13429 | 8.7507% |

The warm fixed request's token hit rate is **10.187%**; request hits are **1/2**
for the fixed pair. Ordering and affinity alone failed the live hit test. The
positive pair uses the actual runtime `_to_rose_messages`, which marks the
shared task initial context/instruction/task ID as one text block and keeps
changing tools, environment, conversation, retrieval and candidate fields in
the following unmarked block. Joining both blocks preserves the complete
native JSON, including unknown future fields. The system policy is unchanged.
Scoped predictions pass `wmh:session:<native session ID>` through Rose's
existing routing/usage mechanism; separate worlds retain separate affinity.
Shorter task prefixes may still be below provider minimums. One warm call
proves this mechanism works, not a sustained or concurrent benchmark hit rate.

Adversarial review found a second regression before completion: Rose includes
the routing namespace in DEMO request-key material. WMH now normalizes only its
`wmh:session:` namespace to the previous None-valued key shape. Actual call IDs,
state/history clocks, execution policy, model and output budget remain bound;
unrelated caller namespaces remain significant. The central Rose client and
its cache contract were not changed.

Permanent regressions in `agents/benchmarks/wmh_rose_provider_test.py` cover
wire breakpoint preservation, changing action/world evidence, complete native
JSON and parser call-ID/state preservation, block/string replay equivalence,
session isolation and namespace-independent exact replay identity. The valid
and invalid distribution guards now exercise block prompts both before cache
write and after response replay. The registered WMH blackbox invokes this
owning suite, and the existing `/deploy` agent coverage lane runs that runner.
Original request/namespace code failed three unchanged owning controls;
current code passed all three. The replay-namespace guard separately failed
before its fix and passed unchanged afterward. Exact red/green commands and
outputs are retained under `.context/wmh-provider-prefix-cache-20261008/`:
`request-contract-controls.py [--original]` and the pytest selector
`native_demo_replay_identity_excludes_only_session_routing`.

Archive searches for `0% cache hit` and `WMH prompt prefix provider routing`
found this related affinity case; the current captured evidence establishes
the adapter recurrence rather than importing the old diagnosis. Rose's own
`providers/rose/transforms.py:1018` documents preserving caller breakpoints.
Available golden analogs are Claude Code's
`claude-code-src/src/services/api/claude.ts:588` (text-block cache markers),
Hermes `agent/prompt_caching.py:60` (stable user prefix followed by an unmarked
tail) and `agent/prompt_cache_scope.py:1` (logical scope independent of physical
rotation), and OpenClaw's `src/llm/providers/stream-wrappers/proxy.test.ts:173`
(OpenRouter cache marker guards). The latter two were read from the existing
Desktop checkout; this worktree has no Codex reference clone. These analogs
support request-local prefix boundaries and logical affinity. There is no new
behavioral prompt instruction, padding, model upgrade, result fabrication or
weakened output validation.

Independent wire/usage/output audit and the portable per-call receipts are
`docs/plans/active/wmh-evidence-20261006/wmh-provider-prefix-cache-20261008.json`.
The user required actual hit evidence, not counters or request-shape tests
alone. The broader WMH fundraiser/contact RCA stays open. This fix is local;
the fundraiser was not rerun and deployment remains explicitly held.

October 8 continuation checkpoint: the requested five-minute fundraiser cache
baseline completed with 1,367/16,341 metered WMH input tokens cached (8.365461%),
10,978 output tokens, one cached request of two metered calls, and DEMO 0/4
lookups with two stores. Two other prediction attempts were cancelled without
final usage. Both cleanup receipts are clean; native revision 2 joined, $0
settled, and the fresh-browser FE replay had 20 messages. The cache mechanism
works on this run; this small sample does not establish a sustained rate or
fundraiser success.

The user then requested a draft PR/handoff. Current source adds iteration 1's
full-task marker, with logical JSON unchanged and owning checks passing, but
its benchmark was interrupted during model loading before task start. There
is no live iteration-1 result. Iterations 2/3 remain reviewed unapplied patches
for complete-history-batch and exact-retrieval boundaries. The history-prefix
reproduction failed two reuse guards and passed three preservation controls on
the baseline; offline 75-request invariance and adversarial malformed/parallel
reviews passed for the proposals. Live measurements and promotion of those
guards into the owning suite are pending. Portable receipts, patches and
continuation instructions are in
`docs/plans/active/wmh-evidence-20261006/cache-optimization-20261008/` and
`WMH_HANDOFF.md`. No merge or deployment occurred.

Final verification: the full registered `world-model-harness` blackbox passed
(provider 89/native 37, including both corpus-ordering controls), pricing 7
passed, Ruff and `git diff --check` passed, and `scripts/rca_archive.py validate`
reported 776 valid cases. Adversarial review passed after the replay-namespace
correction. The separate corpus-ordering failure and repair encountered during
this gate are recorded in the existing October 6 WMH contact RCA.
