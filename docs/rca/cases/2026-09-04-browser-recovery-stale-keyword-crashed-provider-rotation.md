---
id: 2026-09-04-browser-recovery-stale-keyword-crashed-provider-rotation
date: 2026-09-04
title: Stale recovery keyword crashed browser provider rotation after FCaptcha rejection
surface: agents
component: spawn-browser-agent-v3 challenge recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/handler.py recovery call — passed obsolete provider_exit_rejected keyword to recover_from_challenge"
symptoms:
  - FCaptcha rejected a provider exit with pow_not_satisfied and challenge_network_mismatch
  - recovery raised recover_from_challenge() got an unexpected keyword argument provider_exit_rejected
  - the subsequent form verification retained fingerprint poison and scored 0.1751 above the 0.163 ratchet
tags:
  - browser
  - challenge-recovery
  - provider-rotation
  - fcaptcha
  - signature-drift
sources:
  - agent 197f664a-1e5b-468e-b66e-19afc00604a5
  - agent 8aefbb7c-d5b6-4911-9967-df6420626f33
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::challenge_recovery_call_contract
status: fixed
---

## Problem

After the printable-tool batching fix eliminated the original timeout, the
exact biometrics benchmark completed but failed its one-way score ratchet:
FCaptcha v1.34.1 returned `0.1751`, above the required `0.163` maximum.

The run had correctly detected an unusable provider exit. Instead of rotating,
the recovery call raised:

```text
recover_from_challenge() got an unexpected keyword argument 'provider_exit_rejected'
```

## Diagnosis

Critical path:

`FCaptcha /api/verify -> browser network recorder -> provider-exit rejection -> handler recover_from_challenge call -> challenge recovery config search -> replacement browser`

The first FCaptcha response reported `pow_not_satisfied` and
`challenge_network_mismatch`. A later response added `IP has used many
different fingerprints` and scored exactly `0.1751`. The recorder correctly
classified that provider exit as rejected, so evidence was correct through the
recorder. The handler then passed `provider_exit_rejected=...`, while the
keyword-only callee accepts `skip_cookie_probes=...`.

Commit `e76206c4a` renamed both sides to `skip_cookie_probes`; commit
`f1dfb0fe3` later restored only the handler's old keyword. The drift was present
on `origin/main` and lacked a cross-signature contract test.

This was novel. Archive searches used:

- `recover_from_challenge unexpected keyword argument provider_exit_rejected`
- `browser challenge recovery caller callee signature drift FCaptcha risk score`

Related recovery cases existed, but none covered caller/callee keyword drift.

The result was not an FCaptcha recalibration. The immediately preceding run
used the same v1.34.1 engine. Its analogous PoW/teleport/long-interaction result
scored `0.1463`; adding the fingerprint-abuse category accounts for the exact
`0.0288` increase to `0.1751`. The failing run also produced a later checkbox
score of `0.11454` once PoW succeeded.

## Reproduction

The permanent handler-boundary blackbox parses the live activity call, compares
every keyword with `inspect.signature(recover_from_challenge)`, and asserts that
both rejection conditions feed `skip_cookie_probes`.

Buggy code, unchanged test:

```text
$ cd agents && venv/bin/python - <<'PY'
import runpy, sys
sys.path.insert(0, 'tests/blackbox')
ns = runpy.run_path('tests/blackbox/spawn_browser_agent_v3.blackbox.py')
ns['test_challenge_recovery_call_keywords_match_callee_contract']()
PY
AssertionError: set(keywords) <= set(inspect.signature(recover_from_challenge).parameters)
```

Fixed code, identical assertion:

```text
PASS challenge_recovery_call_contract
```

The callee-boundary blackbox also proves that `skip_cookie_probes=True` bypasses
all cookie probes and reaches browser config search:

```text
$ cd agents && venv/bin/python tests/blackbox/challenge_recovery.blackbox.py
✅ provider_exit_skips_cookie_probes
27/27 passed
```

## Solution

The handler now passes:

```python
skip_cookie_probes=provider_exit_rejected or escalate_after_cookie_false_stable
```

The ratchet, task, evaluator, step limit, and timeout were not changed.

Exact task outcome on the intermediate buggy tree:

```text
FCaptcha captured API risk score 0.175 exceeds ratchet 0.163
RESULTS: 0/1 passed
```

Exact unchanged task outcome after the contract repair (using the documented
ngrok fallback knob because trycloudflare returned HTTP 530 before task start):

```text
$ CLOUDFLARE_TUNNEL_EDGE_TIMEOUT_SECONDS=0 scripts/run-bench --local browser-biometrics-webdecoy
✅ browser-biometrics-webdecoy: PASS
RESULTS: 1/1 passed (100%)
Duration: 225s
Captured API score: 0.0288
```

Durable before and after evidence:

- `https://www.roselabs.ai/?agent-id=197f664a-1e5b-468e-b66e-19afc00604a5`
- `https://www.roselabs.ai/?agent-id=8aefbb7c-d5b6-4911-9967-df6420626f33`

## Human feedback

The user required every known failure to be eliminated before deployment.

## Reusable lesson

Keyword-only orchestration contracts need a permanent call-site/signature test.
Testing the callee in isolation cannot catch a stale keyword in a large live
handler, and that drift converts a correctly detected recovery condition into a
runtime-only crash.

## November 3 signature-drift recurrence in the Foundry test consumer

Review5748355636 finding4451807236 identified another removed-keyword consumer: foundry_shared_cooldown_fixture passed provider_fast_mode=True to foundry_complete. The fixture now passes speed="fast" and the registered regression executes its actual main, real completion/parser and service-tier builder through the existing mock transport. Before TypeError; after exact priority tier and expected served response. Full Rose domain289/289 passes. This does not change production model or speed defaults. Detailed original/intermediate diagnostics and private proof are retained in nov3-final-review-fixes/python-cli/frozen-v2-a1feecd8.
