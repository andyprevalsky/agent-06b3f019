---
id: 2026-11-12-usage-snapshot-sent-only-on-next-heartbeat-and-every-cooldown-drawn-exhausted
date: 2026-11-12
title: Compute usage bars stayed empty because usage snapshots rode only the next lease heartbeat and every cooldown was drawn as an exhausted quota
surface: cross
component: compute-subscription-usage
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/subscription_usage.py observe() held each response's usage for the NEXT pre-attempt lineage heartbeat of the same token (helpers/llm.py _heartbeat_lease), which never comes after a lease's last response or a 429 rotation; the TS Rose client (back-end/src/providers/rose/claudeAuth.ts, gptAuth.ts) recorded no usage at all
symptoms:
  - compute usage bars always empty on the Integrations screen
  - usage bar solid red with "Rate-limited until 7:45 PM" only in the hover title
  - usageObservedAt null on every claude_code Integration row
  - data-usage-tone="exhausted" for a 12-minute Rose backoff
  - 'heartbeat result {"ok":false,"updated":0,"usageRecorded":false}'
tags:
  - usage-bars
  - compute-accounts
  - subscription-usage
  - rate-limit
  - cooldown
  - lease-heartbeat
  - anthropic
  - codex
  - ios
sources:
  - commit db5690fb6d
  - commit cfc940ef32
  - commit b18a7008e8
  - commit d4b3a62d29
  - agent d87e1d46 (Rose agent that authored origin/rose/empty-bars-integrated)
repro: agents/tests/blackbox/rose.blackbox.py (test_lease_heartbeat_flushes_subscription_usage_after_response, test_claude_429_usage_flushed_before_rotation_with_authoritative_cooldown, test_claude_429_without_metadata_marks_non_authoritative_cooldown); back-end/src/tests/blackbox/compute-subscription-usage.blackbox.ts (a lease's last flush right after its release is kept; a rejection is written inside the interval); front-end/src/tests/blackbox/compute-usage-bars.blackbox.tsx (renders the reset time ... as visible text; C4 non-authoritative cooldown is cooling); back-end/src/tests/blackbox/compute-subscription-usage.blackbox.ts (a chat-path Claude completion records its account usage in the background; a chat-path Claude 429 records the spent window; a chat-path Codex usage-limit 429 records the spent window)
status: fixed
---

## Problem

On 2026-11-12 15:51Z Andy reported, with an iPhone screenshot of the
Integrations compute bars, that the bars were always empty and that the next
reset time must be visible when a bar is empty, captured automatically from a
failing request, and kept current from normal `Rose.complete` usage without
blocking it.

Production evidence (read-only query, `BEGIN READ ONLY` / `ROLLBACK`,
2026-11-12T18:43Z) over `Integration` rows named `claude_code` / `gpt_code`:

| name | CONNECTED rows | never had usage | usage in last 24 h | cooling now |
| --- | --- | --- | --- | --- |
| claude_code | 7 | 7 | 0 | 5 (3 × 977 min, 2 × 26,237 min left) |
| gpt_code | 5 | 4 | 0 (latest 2026-11-10 23:43Z) | 4 (7,365–7,689 min left) |

Every Claude row had `usageObservedAt = null`, so the bars had no data, and
9 of 12 rows carried an active `rateLimitedUntil`, which the bar painted solid
red with its reset only in a `title` tooltip that iOS never shows.

Archive searches: `usage bars empty compute subscription usage snapshot
heartbeat`, `rateLimitedUntil cooldown exhausted reset time tooltip compute
accounts`, and `usage meter 5h 7d window bar never updates last snapshot
dropped`. No earlier case covers usage-bar delivery. Relative:
`2026-07-28-invented-5m-cooldown-clobbers-real-ratelimit-window` (TS 429 reset
capture). This incident is novel.

## Diagnosis

Critical path: provider response headers (`anthropic-ratelimit-unified-*`,
`x-codex-*`, a Codex `usage_limit_reached` body) → agents
`claude_auth.py` / `gpt_auth.py` `observe()` → per-token in-memory snapshot →
`_heartbeat_lease` → `POST /api/integrations/compute-code/token/lineage-heartbeat`
→ `heartbeatComputeTokenLineage` → `recordSubscriptionUsage` (15 s per-row
throttle) → `Integration.usage*` → `GET /api/compute-accounts` →
`usageMeterView` → `SubscriptionUsageMeter`.

Binary search from the database midpoint: the rows had no usage, so the defect
was upstream. Each boundary was then reproduced locally on `origin/main`
(485c741657) and on the fix (d4b3a62d29), using immutable `git archive` exports.
The receipts are in `/var/tmp/usage-rca/receipts.txt`.

1. **Agents producer (first bad):** `observe()` stored the snapshot, and only
   the next pre-attempt heartbeat of the same token popped it. A lease's last
   response was therefore never delivered. A 429 rotates the token away, so its
   snapshot was never delivered either. Main's rejected unified status did not
   mark the named window as 100% used, and Codex usage-limit bodies were ignored.
   `BLACKBOX_CASE_FUNCTIONS=<4 cases> python scripts/run_blackbox_tests.py rose`
   failed on main, exit 1: only two heartbeats were sent, and the response's
   usage arrived only on the second call's pre-attempt heartbeat
   (`assert len(heartbeats) == 3`). A rotated 429 produced zero usage
   heartbeats (`assert len(usage_heartbeats) == 1`). Its mark carried no
   authority (`KeyError: 'rateLimitAuthoritative'`). The same command passed on
   the fix, 4/4, exit 0.
2. **Backend recorder:** `heartbeatComputeTokenLineage` recorded usage only
   while the lease was unreleased, so a flush racing the release was dropped. A
   rejection observed within 15 s of the stored snapshot was throttled away,
   even though the bar most needs that observation. The scratch boundary repro
   (`released-lease-flush.repro.ts` on a local database) printed this on main,
   exit 1: `FAIL A1: last flush after release dropped (usage5hUsedPct=null,
   expected 40)` and `FAIL A2: rejected snapshot throttled away
   (usage7dUsedPct=70, expected 100)`. It passed on the fix, exit 0.
3. **Front-end display:** `usageMeterView` treated any active
   `rateLimitedUntil` as exhausted. This included Rose's own default or stall
   backoff. Those bars showed 0% left in red, with the reset only in
   `title`/`aria-label`. `npx vitest run
   src/tests/blackbox/compute-usage-bars.blackbox.tsx -t "renders the reset time"`
   failed on main, exit 1: `Unable to find an element with the text: resets
   7:45 PM`; the DOM had only `title="Rate-limited until 7:45 PM ..."`. With
   `-t "C4: a non-authoritative cooldown is cooling"`, main returned
   `{remainingPct: 0, tone: "exhausted"}` for a 12-minute backoff at 30% used,
   where `{remainingPct: 70, tone: "cooling", label: "retry in 12m"}` was
   expected, exit 1. Both commands passed on the fix, exit 0.
4. **TS chat path:** the backend's in-process Rose client never parsed usage
   headers, so chat traffic never fed the bars. It marked 429 cooldowns without
   saying why or whether the provider supplied the reset.

Deepest owned cause: usage delivery was coupled to the token's next request
instead of the response that produced it. The bar also derived "exhausted"
from any cooldown instead of from a provider-stated spent window. Missing
observations and Rose's own backoffs therefore rendered as an empty, red quota.

## Solution

- Agents (db5690fb6d): `subscription_usage.flush()` sends the snapshot in a
  background heartbeat as soon as the response headers arrive. It is bounded to
  5 s and never raises. Successes are sent at most once per token every 15 s;
  failures are sent immediately, before rotation. A rejected unified window
  becomes 100% used at its reset, and a Codex usage-limit body maps to its
  window. Marks carry `rateLimitAuthoritative` (whether the provider gave the
  reset) and `rateLimitReason`. Code sessions report every `rate_limit_event`.
- Back-end (cfc940ef32): migration `20261112170000` adds the
  `Integration.usageSource`, `usageStatus`, `rateLimitReason` and
  `rateLimitAuthoritative` columns. A lease's last flush is accepted for 120 s
  after release. A rejection skips the 15 s throttle but never overwrites a
  newer observation. `GET /api/compute-accounts` returns `cooldown {until,
  reason, authoritative}` and `nextResetAt`: the reset of a spent window, else
  an authoritative cooldown's end, never Rose's own backoff. The Claude usage
  endpoint refreshes rows that have no usage, in the background.
- Front-end (b18a7008e8): the bar has explicit states: unknown ("No data
  yet"), ok, exhausted with a visible "resets 3:49 PM", cooling (keeps the last
  fill, shows "retry in 12m", never red) and stale. The screen refetches every
  60 s while visible, on focus, and when the earliest deadline passes.
- TS chat path (this deploy): `back-end/src/providers/rose/subscriptionUsage.ts`
  parses the same headers in `claudeAuth.ts` / `gptAuth.ts` and records the
  snapshot on the leased row without awaiting it. Cooldown marks now carry their
  reason and authority. The regression is in
  `back-end/src/tests/blackbox/compute-subscription-usage.blackbox.ts`.
  TS repro: `cd back-end && bash scripts/run-blackbox-tests.sh
  compute-subscription-usage`. On d4b3a62d29, whose `providers/rose/`, `chat/`
  and `computeLoginFailure.ts` match main byte for byte, with the new chat-path
  cases copied in: exit 1, 16/19. First failure: "chat usage must reach the bar:
  ... "usage":null". The Claude and Codex 429 cases returned `usage: null`,
  `cooldown.authoritative: false` and `nextResetAt: null`. On the fix: exit 0,
  20/20, including "a stalled usage write never delays a chat-path completion".

Deploy gates on PR #1981 (head f4d5b7cd9539) caught two problems this
change had introduced. Both were fixed in the same PR.

- `agents-coverage-blackbox`, benchmark domain: `TypeError: function() argument
  'code' must be code, not str`.
  - Cause: `spawn_claude_code_agent/service.py` imported
    `helpers.llm.report_code_session_subscription_usage` at module level. That
    loads `openai`, whose `_DefaultAsyncHttpxClient(httpx.AsyncClient)`
    subclass fails while a benchmark test has `httpx.AsyncClient` patched to a
    function.
  - Fix: the helper moved next to `report_undelivered_code_turns` in
    `spawn_claude_code_agent/repo.py`, so importing the code-session domain
    never pulls in the LLM stack (`service.py` already imports `helpers.llm`
    lazily).
  - Repro: `BLACKBOX_CASE_FUNCTIONS=test_declared_judge_persists_its_isolated_identity_before_session_creation
    python scripts/run_blackbox_tests.py benchmark` fails on f4d5b7cd9539 and
    passes with the fix.
  - The benchmark domain's failure message also named `judge_failure`,
    `native_failure` and `unexecuted_native`. Those are a nested run's
    intentional stand-ins leaking through the global `_RECORDED_FAILURES`.
    `_test_utils.isolated_failure_report()` now scopes them.
- `deploy-command-structural`, `test-sleep-ratchet`: this change's fixed
  literal sleeps in `rose.blackbox.py` and `compute-usage-refresh.test.ts`
  became an Event that is never set and `waitFor`. Main's own over-baseline
  sleeps (`claude_code_ws_client.blackbox.py`, `mobile-pwa-chrome.blackbox.tsx`)
  are NOT_INTRODUCED and are being repaired on main by their owner.

At 10k agents the cost stays bounded. Each token sends at most one background
heartbeat per 15 s on success and one per failure. The backend does one lease
primary-key read and one conditional UPDATE per account per 15 s, whatever the
number of agents sharing the account. The UI makes one indexed list read per
visible screen per 60 s. These changes also prevent sibling failures: a
cooldown that names no login no longer lands on every row of a multi-account
user. Golden reference: not applicable (no approval-gated hunk).

## Human feedback

Andy, 2026-11-12 15:51Z: "/rca these bars always displaying empty (it might be
right not sure) either way. We need to display the next reset times when empty
(should be auto retrieved when we get a failing req / these bars should be
updating in a non blocking way from normal Rose.complete usage)", and "Those r
code agent skills, just pass to code agent". The ship brief for this fix
required the reset time to be visible text on iPhone, not only a tooltip. It
also required the TS `Rose.complete` path, which the first fix left undone, to
feed the bars too.

## Reusable lesson

Deliver an observation with the response that produced it, never on the
resource's next request, and render a missing or self-imposed state as unknown
or cooling, never as an exhausted quota.
