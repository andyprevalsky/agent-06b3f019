# Admin purchase/credit bypass + descend daily-bench fixes

Status: **completed** — implemented on main in `39e412053`; the sandbox payment lifecycle was subsequently pinned to a non-admin identity and stabilized in PR #918.

## Origin

`/descend daily benchmarks minus anti-bot minus ecommerce` (run
`.context/descend/descend-daily-20260722T162627Z`) produced a set of harness
fixes awaiting approval. On review, three needed redirection and one new
feature was requested. This plan supersedes the raw descend "fix approval"
blocks for the affected items.

## Decisions locked in chat

1. **Admin purchase/credit bypass (NEW feature).** Users on the existing
   `ADMIN_USER_IDS` allowlist (`back-end/src/utils/adminAccess.ts` — Andy +
   Tamy) may purchase without a Stripe subscription / card-on-file. Chosen
   funding = **option A**: admins route to a **company-funded card with NO
   personal Stripe hold** — Rose eats the cost. Blast radius = 2 userIds.
2. **H-01 (`user-data-prod-grep`)**: replace the rigid structured-checklist
   parse with a **semantic LLM judge**. `response_schema` already auto-generates
   on agent-create (`agent_workflow.py:1244`), so the "add a task schema" commit
   (`8e0137b10`) is dropped.
3. **H-14 mint failure**: root cause = `STRIPE_SUBSCRIPTION_PRICE_ID` unset in
   the local/benchmark backend env (set on Render/prod). **DONE** — value
   mirrored into `back-end/.env` + real test value into `.env.example`; fail-open
   (raise gate with default subscribe URL) retained as a safety net.
4. **Approval format**: every approval block must carry the **verbatim task
   prompt** + a **verified-working FE link** (re-run the task on a live stack,
   open the link, screenshot, iterate until it renders the trajectory).

## Key architectural finding

There is **no existing zero-charge card path.** Even the "static Rose Agent
Card" still captures the user's Stripe hold (`purchases/charge.ts:128`). So
option A requires a **net-new no-reimbursement flow**, not reuse.

## Design

### Money flow (admin bypass)

```
mintPurchaseCard(input)                       [purchases/service.ts]
  ├─ isAdminUser(input.userId)?  ── no ──▶  existing path
  │                                          (findSubscription → 402 if no
  │                                           stripeCustomer → chargeAndIssueCard)
  └─ yes ──▶ issueAdminCompanyCard(purchase, input)   [purchases/charge.ts NEW]
              ├─ mintCompanyFlowCard(...)      (AgentCard company-funded)
              ├─ record wallet funding (transferId)   ← Rose's funds, no user charge
              ├─ (SKIP authorizeStripeHold + captureAuthorizedHold)
              └─ mark HELD
             on failure: closeIssuedCardOnFailure + reclaim funding;
                         NO stripe reversal (nothing was charged)
```

### Compute-credit gate (free-credit)

```
agent_workflow._check_credits → check_user_usage activity → GET /api/credits/usage
                                                              → getUsageSummary()  [credits/service.ts]
```
Admin bypass lives in **`credits/service.ts` getUsageSummary**: if
`isAdminUser(userId)`, report an effective active tier / remaining>0 so the
free-credit gate never fires. Single source of truth; no Python allowlist.

## Work items & automated verification

| # | Change | File(s) | Test (cemented) |
|---|--------|---------|-----------------|
| 1 | `STRIPE_SUBSCRIPTION_PRICE_ID` local env | `back-end/.env`, `.env.example` | DONE (fail-open covered by workflow.blackbox H-14A) |
| 2 | `issueAdminCompanyCard` no-charge path | `purchases/charge.ts`, `service.ts` | `purchases.blackbox`: admin mint → card issued, **zero Stripe paymentIntents**, HELD |
| 3 | Non-admin unchanged | `purchases/service.ts` | `purchases.blackbox`: non-admin no-customer → still 402 |
| 4 | Credits admin bypass | `credits/service.ts` | `credits.blackbox`: admin → remaining>0/tier; non-admin exhausted → gate |
| 5 | Semantic LLM-judge eval for H-01 | `benchmarks/run_benchmark.py` (+ evaluator) | `benchmark.blackbox`: free-text 4-provider checklist PASSES; missing-provider FAILS |
| 6 | Bench: admin variants assert bypass | `benchmarks/tasks.json` | `gate-subscription-card-mint` (admin) → card minted, no gate |
| 7 | Bench: non-admin variants assert gate | `benchmarks/tasks.json` | `gate-subscription-*-nonadmin` (seeded non-admin) → subscription gate fires |
| 8 | Verified FE links | (delivery) | re-run each affected task on live stack; screenshot each link renders |

## Rollout / safety

- All admin-bypass purchases run against **test-mode Stripe** in benchmarks;
  the real-money path is gated to the 2 admin userIds only.
- No Zod schema changes anticipated; if any surface, request approval first
  (rule 5).
- Deploy via `/deploy` once items 2–7 are green; item 8 links attached to the
  final approval message.

## Superseded descend items

H-01 (redirected to semantic eval), H-09 (redirected to admin bypass), H-14A
(env root cause + fail-open). Remaining descend items (H-02/03/04/06-07/08/10/
12/13/15/16) keep their original fixes but are re-presented in the new
approval format with verified links.
