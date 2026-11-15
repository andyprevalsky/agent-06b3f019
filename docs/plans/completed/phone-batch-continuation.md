# Batch cloud-iPhone calls per model turn

Goal (Andy, 2026-11-15): one browser-agent model turn may emit several phone
calls (e.g. `input.tap` then `screen.text`), executed in order, stop at first
failure, without weakening any per-call check.

## Evidence

Prod setup agents `33712aad…` and `1772a64a…` ran strictly one phone op per
model turn: ops take ~1.3 s median, but 7–8 s pass between ops (model turn +
loop). When the model did batch (`apps.launch`+`screen.text`, `input.tap`+
`screen.text`), `RoseClient.complete_browser_use` rejected the whole turn
("requires a separate turn") and the model re-planned the same action.

## Design

```
model turn ──► client.py validation ──► batch_actions[] ──► BrowserActionBatch
  (N native       phone allowed iff         (ordered)          │ begin: fence=(observed lease, cursor)
   tool calls)    phone_call_batchable                         ▼
                                              activity loop iteration (unchanged per call):
                                              observe_phone (fresh) ─► batch.next(dom, state, phone)
                                                 refuse unless lease==fence.lease, cursor==fence.cursor,
                                                 no attention/pending op, and reads-only after navigation
                                              ─► execute_action ─► execute_phone (realm refusal, credential
                                                 rules, availability, CAS expectedCursor, own operationId)
                                              ─► batch.completed: SUCCEEDED receipt ⇒ fence.cursor=receipt.cursor
```

- Batchable: `status`, reads (`screen.text`, `screen.bounds`, `apps.list`),
  `input.text`, navigation (`input.tap/press/drag/scroll/keys`, `apps.launch`,
  `nav.home`). After navigation only reads may follow in the same turn.
- Still a separate turn: `setup`, `release`, `credentials.*`, `messages.*`,
  any unlisted operation.
- Native parallel tool calls are accepted but run serially: every phone op
  shares one lease cursor (CAS), like claude-code's non-concurrency-safe
  partition in `toolOrchestration.ts`.
- 10k agents: no new I/O; the existing per-iteration `observe_phone` is reused,
  state is per-activity.

## Verification

- `agents/benchmarks/browser_action_batch_test.py` (phone section) and the
  `rose-browser-use` blackbox aggregate `phone_batch_contract`: ordered fresh
  cursors, stop-on-failure, reads-only after navigation, lease/cursor/attention/
  pending fences, non-batchable calls refused, portrait-route journal identical
  batched vs single, actual activity loop with one fewer model turn.
- Replay of real setup dumps with old vs new wording (`replicate_llm_dump.py`
  exact transport) for the measured call/wall-time reduction (PR body).
