# Browser approval benchmark coverage review

Reviewed October 27, 2026 for agent
`3392bb69-807b-4ef9-a671-2e5eeb92efa7` against the user's revised continuation
contract. This is a coverage review and proposed acceptance criteria, not a new
benchmark pass or an activated catalog change.

After approval, the original blocked tool should resolve once with permission
granted and an explicit statement that its action has not executed. The normal
actor decides whether to retry or first observe. There is no queued automatic
execution, replacement target, additional tool, or approval-only identity guard.
The existing grant scope and lifetime remain in force. A real failed retry may
be recovered by the ordinary actor.

| Existing benchmark | Current useful coverage | Decision |
| --- | --- | --- |
| `browser-auth-existing-browser-session` | Saved session works without another password/passkey/code attempt | Keep as a control; it has no approval boundary. |
| `browser-auth-password-app-approval` | Actual separate-device UI approval; helper checks the browser is live and its CDP URL remains unchanged | Keep the live handoff behavior. Do not force browser retirement here. |
| `browser-auth-session-expires-at-checkout` | Payment approval, intentional merchant session expiry, reauthentication, exact one-order/account/receipt/settlement outcome | Reuse this hosted checkout scenario for controlled approval-continuation and browser-recreation coverage. Keep intentional merchant expiry distinct from accidental state loss. |
| `agent-payment-setup-resume` and `gate-subscription-webhook-resume` | Continuation after setup/billing gates | Supporting coverage; neither proves private browser checkpoint completeness. |
| Amazon, DoorDash and Toast unresolved-approval tasks | Stop before a live purchase and leave approval unresolved | Preserve these contracts. They cannot demonstrate post-approval resume. |

## Criteria to add to controlled checkout coverage

1. Actual human-approval API completion resolves the original blocked tool result
   exactly once, with its original call ID, permission granted, and
   `action_executed=false`.
2. No executor dispatch occurs between permission resolution and the next normal
   actor decision. The actor uses existing tools to observe or retry.
3. The existing in-scope grant survives continuation and recovered retries
   without another approval. Existing typed-grant expiry, activity-scoped site
   grants and out-of-scope checks retain their current behavior.
4. A controlled actor retry fails through the real ordinary executor. Its error
   remains visible, and the actor can naturally observe and recover. The final
   outcome still requires exactly one correct order. Do not use a blanket error
   exemption, fabricated error, or zero-tool-errors requirement for this variant.
5. A real approval park checkpoints before native release. After forced native
   destruction, the same logical task resumes in a new native browser with the
   seeded cookie, localStorage, IndexedDB, sessionStorage and cart preserved,
   including a live supported cross-origin frame. A still-live reconnect reuses
   its native browser. Compare state before intentional merchant expiry.
6. Keep the existing exact receipt, settlement, signed-in-account association,
   order count and reported order-number checks. Missing lifecycle or transcript
   evidence must fail the new check.

## What remains to make these catalog assertions executable

The current hosted checkout fixture records cookies and server cart/order
state. It does not emit ordered checkpoint/native-generation/state evidence,
correlated approval-result/actor-dispatch evidence, or a controlled failed actor
retry. Those test-only observations and interventions need an explicit scenario
contract and a typed evaluator before these criteria can gate a catalog run.
Adding only prose to `criteria[]` does not provide coverage.

The local permanent backend integration already exercises real activities,
HTTP, Postgres, encrypted checkpoints and Chromium with native destruction,
main/frame storage equality, live reuse, capture failure retention and one
synthetic order. Model/approval continuation/message orchestration are fixture
edges, so that pass is not a full model/Temporal catalog benchmark result.

The reviewed catalog draft remains unapplied. Benchmark definitions and grading
changes require explicit approval under `CLAUDE.md` rules 25/26a. No task names,
prompts, timeouts, history, pass thresholds or live-purchase stop conditions were
changed by this review. Preserve original results when qualifying future source.

## Full Rose-agent verification, October 27 follow-up

The user required the test to run through a Rose agent rather than a scripted
ActivityEnvironment actor. A real root/browser Rose agent
`c4d90385-9b3f-497e-bb71-cf1350218c1f` completed the synthetic Canvas Shop task
in 225.8 seconds through the normal local backend, real model calls, Temporal
Cloud, actual Kernel browser and attention-request APIs. No model decisions or
browser executor results were mocked. The merchant and approving test user are
synthetic; no real payment or shipment occurs.

Before approval, the merchant ledger contained zero order attempts and the
logical browser had checkpoint revision1 and PAUSED status. After approval, the
same logical task used a different Kernel native ID. The original click's tool
result appeared once with its original call ID, permission granted and
`action_executed=false`. The actual model chose read_browser_state, then a fresh
click. The merchant validated the restored cookie, localStorage, IndexedDB and
sessionStorage and recorded exactly one accepted order, no duplicate/invalid
attempt and no duplicate approval. The root completed and reported the visible
order number. This closes the prior single-path paid-provider/full-Temporal
positive-coverage gap; intentional retry failure and iframe scenarios remain
separately covered by the component/integration tests, not this full-agent run.

The unchanged catalog `browser-auth-password-app-approval` also passed through
a real Rose agent in145.8s. The main typed-approval test is explicitly an ad hoc
functional test; no catalog task definitions or grading thresholds were changed.
Its recording and66messages were published and verified in a fresh browser.
All owned test agents, native sessions, local stack/database, merchant and tunnel
were retired. Private receipt: `.context/rca-3392/real-rose-agent-final-validation.json`.


The full-agent positive test now covers the successful continuation/recreation
criteria. Activating this as a permanent catalog case still needs the reviewed
fixture/evaluator integration and definition approval. The controlled real-model
failed-retry and iframe variants were not run in this full-agent follow-up.

## Final combined-source Rose verification

After integrating shared Steel/Kernel custody, partitioned frame persistence,
and same-agent denial continuation, ordinary Rose agent
`a280adfb-ddb9-427a-9d76-41e35e039f3e` repeated the positive approval flow on
the final runtime in **174.5 seconds**. It used actual root/browser models,
Temporal Cloud, Kernel, and the normal attention-request API. The merchant
recorded zero attempts before approval and exactly one valid synthetic order
afterward, with no duplicate or invalid attempt. Cookie, localStorage,
IndexedDB and sessionStorage proofs all passed across native recreation under
the same logical browser. The original click result retained its call ID and
`action_executed=false`; the next actual model action was `read_browser_state`.
No real payment or shipment occurred. This run does not add a full-model
negative-denial, intentional failed-retry, or cross-site-frame claim; owning
integration tests cover those separately.

[Final Rose recording and 84 messages](https://www.roselabs.ai/?agent-id=a280adfb-ddb9-427a-9d76-41e35e039f3e#benchmark-share=98dab579-4c4f-45b5-bc54-0bf53f495064.1795725487.6259e800cece29507247ee9e63a18b44fe7b7a50d8396de78553c521d658c403) were published
and verified in a fresh browser. The exact terminal agent, merchant and
merchant tunnel were retired; the deployment semantic stack remains owned
until its mandatory gate finishes. Runtime source binding and strict ledger:
`.context/rca-3392/final-rose-positive-validation.json`.

### Post-sync namespace qualification

The same real Rose acceptance was repeated after integrating upstream worker
and namespace isolation, using `rose-labs-bench.tch2n`. Agent
`505428f6-4e43-41b0-a0dc-8f8473c5e6b9` completed in **245.1 seconds**.
It again produced one valid order and one approval, retained all four storage
proofs across same-logical-browser/native recreation, and chose
`read_browser_state` after the original permission result. The recording and
65 messages were [published and verified in a fresh browser](https://www.roselabs.ai/?agent-id=505428f6-4e43-41b0-a0dc-8f8473c5e6b9#benchmark-share=8533a9bd-e91d-432f-806f-5245eed89b08.1795727033.72ab38ef627b24aa71ab1653f00d1dea6a63d042070f23aa91478a6a91d5a833).
The raw observer's same-host historical rows are preserved; the audit selects
the exact current agent owner and verifies one parked/restored logical browser.
No model result or browser action was mocked. Private current-source binding:
`.context/rca-3392/postsync-rose-positive-validation.json`.
