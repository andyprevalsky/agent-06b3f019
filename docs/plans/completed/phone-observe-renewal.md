# Cut per-step phone observation overhead

Coordinator follow-up to #2186 (2026-11-16): profile the ~4.5 s per-iteration
phone loop overhead from real prod spans and cut the biggest piece.

## Evidence (prod, read-only)

- `browser.step.phases`, last 48 h: the phase that contains `observe_phone`
  (`thinking_stream_start`) had a median of 1317 ms on phone steps (n=1926) vs
  218 ms on non-phone steps (n=617).
- Render request logs for the agent `b82a6edb` run (02:17–02:50Z): `observe_phone`
  makes three sequential calls every step. They are availability (p50 56 ms),
  interaction view (395 ms) and lease heartbeat (492 ms).
- The lease TTL is 120 s. Every completed operation renews it
  (`repo.operations.ts`), and so does the 30 s heartbeat during model and
  action work (`with_phone_heartbeat`). The per-step heartbeat is therefore
  redundant while the claim is fresh.

## Change

```
loop iteration ─► observe_phone: availability ─► view ─► [heartbeat only if leaseExpiresAt − now < 90 s] ─► decision/continuation
```

`observe_phone` still re-checks availability and reads a fresh view on every
step, and a heartbeat 403 still disables the phone. A missing or unparseable
expiry still renews.

10k agents: this removes one DB-writing POST per phone step per agent, and
adds no I/O.

## Verification

`spawn_browser_agent_v3` blackbox
`phone_observe_renews_lease_only_near_expiry`. It covers fresh (no renewal),
near-expiry, missing and unparseable expiry (renewal), and a 403 on renewal
(disabled). It fails on the old code and passes 5/5 on the new code. After
deploy, measure the same phase median on real phone steps from prod spans.
