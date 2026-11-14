# PR #1928 review deferrals

CodeRabbit verification review 5860297518 on `52953c70` left eight findings in
benchmark-infrastructure and deploy-tooling code. None is security- or
production-impacting. The ledger allowed no further cycle, so they were deferred
with `deploy_review_cycle.py override` (disposition `overridden`, recorded clean)
and each comment received a `[DEFERRED]` reply.

| Comment | File | Finding | Why deferred |
|---|---|---|---|
| 4539099338 | scripts/cloudbench-warm-source.py | Honor the server's full `Retry-After` (including the HTTP-date form), or fail within an operation deadline | Benchmark-infra only; the 16 s cap still fails closed |
| 4539099350 | scripts/cloudbench-warm-source.py | Claim expiry can elapse during 429 retries when `--ttl` is short | Benchmark-infra only; refresh the expiry after a retried write, or require ttl > retry budget |
| 4539099365 | scripts/cloudbench-warm-source.py | 429 retries inside `claim_exchange` can outlive the 30 s donor lease | Benchmark-infra only; restart under a new lease with a fresh read |
| 4539099384 | scripts/cloudbench-warm-source.py | A delayed last-used retry can regress a peer's newer timestamp | Benchmark-infra only; recompute the timestamp per retry |
| 4539099407 | scripts/deploy_test_quarantine.py | Verify every extracted failed id even when the unit-name match succeeds | No live path: structural Python markers cannot equal a suite unit name today |
| 4539099434 | scripts/deploy_test_quarantine.py | Multi-file suites need a union of marker paths | Fails closed (attribution refuses and blocks merge) |
| 4539099452 | scripts/deploy_test_quarantine.py | Validate the repair of every matched marker, not only `found[0]` | Deploy tooling; follow-up |
| 4539099472 | scripts/run-deploy-structural-gates.py | Exclude nested fixture failure headers from attribution | Fails closed (an extra marker is demanded rather than an attribution passing) |

Later main syncs (`cfa06656`, `d969e88b`) were recorded as `post-cap-unreviewed`
under the standing three-round authorization.
