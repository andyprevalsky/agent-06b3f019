---
name: biz-review
description: Weekly business review card for main — PRs and commits merged, user task completion rate with a per-task list and per-user usage, and a provider-matched compute-cost breakdown, with major updates and clustered minors. Use for /biz-review or a request for a business/weekly review of what shipped.
---

# /biz-review

Produce one interactive, color-coded card for the last 7 days (rolling, ending
now) and compare against the 7 days before it. `$ARGUMENTS` may give
`--days N`. The layout is fixed by `scripts/biz_review.py render`; never
hand-edit the HTML or invent sections. Run `python3 scripts/biz_review.py
self-test` first; it covers layout, masking, proration and every cost module.

Card order: Delivery → Tasks (completion KPI, user-initiated KPI with per-user
bars, expandable "All tasks" list) → Compute costs (total + top 3 groups, then
one expandable row per group) → Major updates → Minor updates (expandable
clusters). No latency, error rates, risk/warning sections, `warming` or
placeholder values.

## Prerequisites

- `agents/.env` and `back-end/.env` (authoritative copies, see CLAUDE.md);
  `back-end` dependencies installed (`npx tsx` works); `dvb-onbox` on PATH
  (boxes.dev box-hours) and `gh`.
- `back-end/.env` points at the PROD database; the metrics script only reads.

## 1. Collect (read-only, ~1–2 min)

```bash
python3 scripts/biz_review.py collect $ARGUMENTS
```

It prints `.context/biz-review/<stamp>/data.json`:

- **Delivery** — PRs merged to `origin/main` (first-parent merges and squash
  commits with `(#N)`) and every commit those merges brought in.
- **Tasks** (`back-end/scripts/biz-review-metrics.ts`) — root tasks real people
  started on prod: operators (Andy, Tamara) included; benchmark, simulated and
  fixture/test accounts excluded (`realWaitlistPersonSql`). Archived agents are
  soft-deleted `Agent` rows (GoalHistory is legacy) and are counted as agent
  runs or chat — never a separate category. Completion rate = COMPLETED ÷ agent
  runs; chat-only questions show as "Answered". Titles have phone numbers and
  emails masked.
- **Compute costs**, every row from the provider, never prod-DB recorded spend
  (cloud benchmark stacks use their own DBs, so recorded spend misses most usage):

  | Group | Source |
  |---|---|
  | LLM inference | OpenRouter (`OPENROUTER_MANAGEMENT_KEY` → `/api/v1/activity`; else exact lifetime-usage snapshot delta; else October-style month-to-date billed rate × days). Cerebras (browser session, else `set-cost`). Codex Pro / Claude Max plans from `scripts/biz_review_plans.json`. |
  | Fly.io | `scripts/biz_review_fly.py`: Prometheus run-seconds per machine (destroyed Machines included) × size list price, per app, plus volumes/rootfs. Not a snapshot of running machines. |
  | Browsers & sandboxes | Kernel, Steel, E2B session APIs × list price + prorated plan (`scripts/biz_review_browsers.py`); boxes.dev overage box-hours from `dvb-onbox billing status` + the seat plan. |
  | Hosting | Vercel billed charges; Render and Supabase plan rates. |
  | Search & data APIs | `scripts/biz_review_search.py` (Firecrawl plan, Exa via `EXA_SERVICE_API_KEY`) and Lantern ($0, included in its plan) via `scripts/biz_review_lantern.py`. |

  Rows with no reachable billing source are listed once per group as
  "Not connected yet". The plan list (`scripts/biz_review_plans.json`) is the
  user-confirmed source for flat subscriptions: 5 × Codex Pro $500, 2 × Claude
  Max $200, 1 boxes.dev Pro seat $99 (2026-10-19). Update it, not code, when
  plans change.

Known gaps and how to close them (ask once, then reuse):

- Cerebras: metrics API returns "Organization access to metrics API is
  disabled". Ask the user for the 7-day dashboard figure, or have them sign in
  at cloud.cerebras.ai in the Browser pane.
- Parallel, Perplexity: dashboard only. Exa: needs a team admin key. Fly actual
  invoice and OpenRouter rolling-exact: dashboard sign-in or management key.
  Azure Foundry is intentionally excluded.
- Record any figure the user reads off a dashboard before rendering:
  `python3 scripts/biz_review.py set-cost --dir <run-dir> --name <row name> --usd <n> --detail "<dates · models>"`.

## 2. Write the narrative

Read `data.json` → `git.prs` and `git.direct`; only PRs listed there belong on
the card. Use `gh pr view <n>` only where a title is unclear. Write
`narrative.json` in the run directory:

```json
{"majors": [{"title": "SMS supervisor rebuilt", "impact": "Native tool calling, searches before asking → smarter texts with fewer needless questions.", "prs": [1473], "tag": "SHIPPED"}],
 "clusters": [{"title": "💬 Chat quality", "count": "5 PRs", "items": ["Re-search after a miss, fan out queries (#1472)"]}]}
```

- Majors (about 6–10): user-visible features, payment safety, scale or
  reliability shifts. Title ≤ 5 words; impact is one sentence in
  "what → why it matters" form. Tag is `SHIPPED` (or `LIVE · <version>` when
  verified in prod); never a warning tag.
- Cluster every other PR and direct commit into themed groups, each with an
  emoji title, a count ("5 PRs", "~55 commits") and short items citing PRs.
  Bulk operational commits (operator pins, history rows) collapse into one
  "📊 Benchmark infrastructure" cluster.

## 3. Render and publish

```bash
python3 scripts/biz_review.py render --dir <run-dir>
```

Preview `<run-dir>/index.html` in dark mode and at 360 px with
`dvb-onbox visuals preview`, fix any console error or overflow, then publish
with `dvb-onbox visuals publish --title "Weekly business review · <Mon D–D>"`
(see the `boxes-inline-visualizations` skill). Put the printed link alone in
its own paragraph of the final answer with at most two short sentences around
it. Do not send screenshots or a markdown re-rendering of the card.
