# Write-lock SMS formatter only rendered purchase fields

## Symptom
Non-purchase write-lock approvals (returns/`generic_write`, email/`message`,
social_post, payment) texted a hollow body:

```
Approval needed
Rose needs your approval for Amazon checkout.
```

even when the in-app `question` had refund/drop-off, recipients, or payment
details. Amazon return approvals were the live trigger during
`browser-amazon-return`.

## Local repro (pre-fix)
```bash
npx tsx -e 'import { formatPaymentApprovalBody } from "./src/providers/smsSupervisor/writeLockBody.ts";
console.log(formatPaymentApprovalBody(null, {
  trigger_type: "generic_write",
  action: "confirm Amazon return for Carhartt beanie",
  service: { name: "Amazon" },
  generic_write: {
    label: "Confirm return",
    target: "Carhartt beanie",
    payload_summary: "Refund $10.84 via Whole Foods Dropoff",
  },
}, "unused", "https://roselabs.ai/?agent-id=demo"));'
```
Observed: checkout stub with no Action/Target/Change.

## Root cause
`formatWriteLockNotificationBody` always used a purchase "checkout" header and
only read `notification.purchase.items` / totals. When
`writeLockNotification` was present for any other `trigger_type`, the rendered
approval `question` was ignored, so SMS dropped the structured details.

Secondary: `sanitizeSmsText` rewrote `user@example.com` → `user@Example` via the
domain→label transform, mangling email approval recipients.

## Fix
- Render SMS per `trigger_type` (purchase / message / social_post / payment /
  generic_write), mirroring the in-app approval fields.
- Keep purchase's carrier-safe "checkout" header for existing MMS blackbox.
- Fall back to the rendered `question` when structured details are sparse.
- Preserve email addresses inside `sanitizeSmsText`.

## Cemented test
`back-end/src/tests/unit/sms-approval-plain-text.test.ts` — cases for each
trigger + email preservation + sparse fallback.

## Relatives
- `2026-08-05-sms-approval-markdown-and-truncated-drafts`
- `2026-08-20-return-write-lock-notification-demands-unsatisfiable-purchase-details`
