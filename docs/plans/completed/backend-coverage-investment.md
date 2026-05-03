# Backend Coverage Investment

**Status:** ACTIVE — multi-session effort
**Trigger:** `/deploy` halted on this branch (May 2026) when coverage gate revealed actual ≈ 42.8% lines vs configured threshold of 88%. Threshold was set in commit `9d7a4876` as "realistic initial" but never matched reality; past deploys silently bypassed the gate.

## Goal

Bring `back-end` test coverage from current actual to the configured `.c8rc.json` threshold (88% lines / 87% functions / 76% branches / 88% statements) by adding blackbox tests in `src/tests/blackbox/<domain>.blackbox.ts`.

## Current state (snapshot)

```
Lines:      42.83%  (9,575 / 22,352)
Functions:  40.44%
Branches:   70.56%
Statements: 42.83%
```

**Lines gap to threshold:** ~10,094 uncovered lines.

## Top uncovered files (closing these first = biggest leverage)

| Lines uncov | File | Existing test domain |
|---|---|---|
| 343 | `src/domains/integrations/uploadService.browser.ts` | `integrations.blackbox.ts` |
| 305 | `src/domains/integrations/uploadService.passwords.ts` | `integrations.blackbox.ts` |
| 297 | `src/domains/data/repo.ts` | `data.blackbox.ts`, `data-coverage.blackbox.ts` |
| 259 | `src/domains/data/service.ts` | `data.blackbox.ts` |
| 259 | `src/domains/integrations/routes.browser.ts` | `integrations.blackbox.ts` |
| 251 | `src/providers/rose/streaming.ts` | `rose.blackbox.ts` |
| 242 | `src/domains/auth/service.ts` | `auth.blackbox.ts` |
| 222 | `src/domains/people/service.ts` | `people.blackbox.ts` |
| 215 | `src/domains/integrations/routes.upload.ts` | `upload.blackbox.ts` |
| 215 | `src/domains/integrations/repo.ts` | `integrations.blackbox.ts` |
| 213 | `src/providers/rose/client.ts` | `rose.blackbox.ts` |
| 209 | `src/providers/fetchCapture.ts` | (none) |
| 206 | `src/domains/models/service.ts` | `models.blackbox.ts` |
| 204 | `src/domains/agents/repo.ts` | `agents.blackbox.ts` |
| 200 | `src/domains/people/routes.ts` | `people.blackbox.ts` |
| 197 | `src/providers/hybridAuth.ts` | (none — needs new test) |
| 195 | `src/domains/sms-webhook/service.ts` | `sms-webhook.blackbox.ts` |
| 192 | `src/domains/agents/routes.ts` | `agents.blackbox.ts` |
| 192 | `src/domains/vapi/service.ts` | (none — needs new test) |
| 189 | `src/domains/integrations/uploadService.messaging.ts` | `integrations.blackbox.ts` |

**Top 20 = 4,604 uncov lines.** Closing top 20 to ~80% covered would gain ~3,800 lines, lifting overall to ~60%.

## Strategy

1. **Reuse existing blackbox test files** — most domains already have tests; expand them to hit more code paths rather than creating new files.
2. **Mock at the boundary** — never call third-party services for real (Twilio, Vapi, Steel, Stripe). Use the established mock patterns in existing tests.
3. **Test by behavior, not by line** — each test should exercise a real user-visible scenario; coverage is a side effect.
4. **Surface integration tests** for files that have no current test domain (`fetchCapture.ts`, `hybridAuth.ts`, `vapi/service.ts`).
5. **Ratchet up `.c8rc.json` thresholds** as coverage rises — only ever increase, never decrease.

## Wave plan

Each wave: 4 parallel sub-agents working on independent domains. After each wave, run coverage and re-target the next wave at the new top-N uncovered.

**Wave 1** (this session, in progress):
- Agent A: `integrations/uploadService.browser.ts` + `routes.browser.ts` (~602 lines)
- Agent B: `data/repo.ts` + `data/service.ts` (~556 lines)
- Agent C: `providers/rose/streaming.ts` + `providers/rose/client.ts` (~464 lines)
- Agent D: `auth/service.ts` + `auth/service.twilio.ts` (~413 lines)

**Wave 2** (next session):
- Agent E: `people/service.ts` + `people/routes.ts` + `people/service.messages.ts`
- Agent F: `integrations/repo.ts` + `integrations/routes.upload.ts` + `integrations/routes.email.ts`
- Agent G: `agents/repo.ts` + `agents/routes.ts` + `agents/agentMessageService.ts` + `agents/agentConfigService.ts`
- Agent H: `models/service.ts` + `vapi/service.ts`

**Wave 3** (next session):
- Agent I: `providers/fetchCapture.ts` + `providers/hybridAuth.ts` + `providers/embeddings.ts`
- Agent J: `sms-webhook/service.ts` + `tool-usage/service.ts`
- Agent K: `blueprints/routes.ts` + `credits.ts`
- Agent L: remaining domains

## Acceptance criteria

- Each wave: run `cd back-end && npm run test:coverage:report` to measure delta
- Each wave: ratchet `.c8rc.json` thresholds up to (current actual − 0.5%) so future PRs don't regress
- Final: when actual ≥ 88% lines, threshold matches, deploy gate works honestly

## Notes

- The 88/87/76 threshold from `9d7a4876` was aspirational and the deploy gate has been broken since. This plan replaces aspirational with honest ratchet.
- Coverage is being measured via NODE_V8_COVERAGE on a real backend process — instrumentation is correct.
- Once we hit 88%, future contributions ratchet from there.
