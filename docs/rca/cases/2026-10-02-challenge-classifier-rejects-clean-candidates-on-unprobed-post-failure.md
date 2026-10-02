---
id: 2026-10-02-challenge-classifier-rejects-clean-candidates-on-unprobed-post-failure
date: 2026-10-02
title: Challenge recovery rejected candidates that loaded the page cleanly because the classifier required a POST failure the probe never exercises to be visibly cleared
surface: agents
component: challenge-llm-classifier
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/challenge_llm_classifier.py build_challenge_classifier_messages — "Return challenged=false only if this specific failure mode is cleared in DOM + network evidence" applied to a failure (a checkout POST) that a single-navigation candidate probe cannot reproduce
symptoms:
  - 'net::ERR_TUNNEL_CONNECTION_FAILED'
  - 'Challenge LLM classifier result challenged=true reason=The recovery reason states POST /api/test-payment/confirm fails'
  - 'Challenge recovery candidate probe attempt still challenged'
  - 'agent-payment-idempotent-abandonment: Timeout after 901s'
  - 'unattributed: 486540'
tags:
  - browser
  - challenge-recovery
  - kernel
  - proxy
  - classifier
  - agentcard
sources:
  - PR #1354
  - agent 77cafeca-01ab-4d52-9fc2-8fcb5f9ef6c2
repro: 'agent 77cafeca-01ab-4d52-9fc2-8fcb5f9ef6c2 (deploy AgentCard lane, run 1790906409-499639-80192): backend.log lines 14748-17738 show challenged=true verdicts on status=200 candidates with the full checkout DOM'
status: open
---

## Problem

During the PR #1354 `/deploy` AgentCard lane, `agent-payment-idempotent-abandonment`
timed out at 901s with the agent PAUSED. The second browser task filled the
card and clicked Pay. From 02:07:51 every request from that pooled Kernel
session (San Francisco residential proxy) to the bench ngrok host failed with
`net::ERR_TUNNEL_CONNECTION_FAILED`, and the confirm POST never reached the
backend. Other sessions reached the same host normally. The browser agent
correctly called `recover_from_challenge`. That single step took 486s and found
no usable configuration.

## Diagnosis

- The trigger was a third-party proxy failure on one Kernel session. Rotating
  to any other egress would have fixed it.
- The config search did produce working candidates: `steel_fixed`,
  `kernel_residential_state`, and `kernel_isp` each loaded `/test_payment` with
  HTTP 200 and the full 1939-character checkout DOM. The classifier marked every
  one `challenged=true`, citing the agent's recovery reason ("POST
  /api/test-payment/confirm fails with ERR_TUNNEL_CONNECTION_FAILED") rather
  than anything on the candidate page.
- The cause is the classifier instruction "Return challenged=false only if this
  specific failure mode is cleared in DOM + network evidence". It was added to
  stop false-stable promotions on WAF pages. A candidate probe is one navigation
  and never issues the checkout POST, so for a POST-level failure the criterion
  can never be met. Every candidate is rejected, even when the original failure
  was tied to the session's egress.
- Recovery time was inflated by the concurrent Steel outage: 137s for the
  cookie-variant probe and about 60s for the `steel_managed` candidate. Our share
  of that is fixed in
  `2026-10-02-steel-startup-failure-hidden-behind-cdp-validation-retries`.
- This branch did not cause it. Its only change to the classifier moved two
  URL helpers into `challenge_urls.py`.

## Solution

Open. Changing what the classifier is told is an LLM-visible prompt change and
needs human approval. One possible direction: when the cited failure is a
transport error (`ERR_TUNNEL_CONNECTION_FAILED`, `ERR_PROXY_*`) on a request the
probe does not replay, judge the candidate on its own page and network evidence
and leave the cited-failure criterion to WAF/soft-block reasons. It has to be
proven against the Eventim false-stable case and the AgentCard payment tasks.

## Human feedback

None recorded. Found while running the user-requested `/deploy` for PR #1354.

## Reusable lesson

A verifier criterion must be satisfiable by the evidence the verifier
collects. When the probe cannot reproduce the failure it is asked to rule out,
it rejects every candidate, including the ones that fix it.
