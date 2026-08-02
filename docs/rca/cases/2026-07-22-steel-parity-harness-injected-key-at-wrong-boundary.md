---
id: 2026-07-22-steel-parity-harness-injected-key-at-wrong-boundary
date: 2026-07-22
title: The live Steel parity harness injected its API key at a different boundary than production, failing one blackbox domain
surface: back-end
component: browser-provider-rotation
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the live Steel parity harness — it injected the Steel API key outside the process-local CDP connection boundary production uses
symptoms:
  - backend blackbox 97/98 with the live Steel parity domain failing
  - Steel parity harness fails while production Steel path works
  - domain passes on exact retry after key injection is moved
tags:
  - steel
  - blackbox
  - parity-harness
  - credential-injection
  - cdp
sources:
  - PR #846
repro: back-end live Steel parity blackbox domain (97/98 before the harness correction, 98/98 after)
status: fixed
---

## Problem

During the browser provider-rotation deploy, the full backend blackbox run came
in at 97/98: the live Steel parity harness domain failed while the production
Steel path itself was healthy. After the harness was corrected the exact same run
retried green, making all 98 domains pass.

## Diagnosis

Production injects the Steel API key at a process-local CDP connection boundary —
the key exists only at the moment a CDP connection is established, and nowhere
else. The parity harness supplied the key at a different point, so it was not
exercising the same code path it claimed to certify. The failure was therefore in
the test's environment model, not in the product: a "parity" harness that
diverges from production at the credential boundary can both fail on working code
and, worse, pass on broken code. The invariant this exposed was then cemented
directly: Steel keys must exist only at process-local CDP connection boundaries.

## Solution

Corrected the harness to inject its API key at the same process-local CDP
boundary production uses, then re-ran the exact domain to green (98/98). The same
PR added exact regressions proving Steel keys exist only at process-local CDP
connection boundaries, hardened credential-injection validation so injection
failures are surfaced instead of silently ignored, and ensured every reviewed CDP
error path closes its connection.

## Human feedback

Anthropic credential/billing health and the directly dependent
`claude-code-agent` smoke were explicitly overridden by the admin because credits
were exhausted; the record states those two gates are not reported as passed while
every independent gate ran normally.

## Reusable lesson

A parity harness that fails while production works is usually injecting
credentials at the wrong boundary — make the test attach secrets at the exact same
seam production does before suspecting the product.
