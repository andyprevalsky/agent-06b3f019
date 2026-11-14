/**
 * Quarantined blackbox cases (deploy failure policy: NOT_INTRODUCED flakes keep running and
 * reporting; their failure never blocks). Each export pairs the exact case title with its marker,
 * so the deploy attribution binds the quoted case written directly before `quarantine({`.
 */
import { test } from 'node:test';
import { quarantine } from '../helpers/quarantine';

type Body = (...args: never[]) => unknown;

/** Registers the node:test case; its body is unchanged and every assertion still runs. */
export const quarantinedHmrTest = (fn: () => Promise<void>) =>
  test(
    'Rose-in-Rose HMR: an agent write to the Rose front-end reaches the preview DOM in ≤ 3 s',
    quarantine(
      {
        since: '2026-11-11',
        repair: 'pending-handoff:cf9d391de1d0465683bbe6265b42351b',
        error: 'page.waitForFunction: Timeout 10000ms exceeded.',
        evidence:
          '.context/deploy-pipeline-e0f5/attempts/19/focused/backend-coverage-blackbox (PR1881 FLAKY cf9d391d)',
      },
      fn
    )
  );

export const quarantinedLiveFailoverCase = <F extends Body>(fn: F) =>
  [
    'live -- exact prod follow-up escalates through real OpenRouter',
    quarantine(
      {
        since: '2026-11-11',
        repair: 'pending-handoff:3ce7aeb5336647dfa379f0bb04ed45a9',
        error:
          'Error: live GLM failover missed in two samples 60s apart. First: AssertionError [ERR_ASSERTION]: live GLM failover must escalate the exact prod follow-up, got apology after 30083ms over 1 decision round(s)',
        evidence:
          '.context/deploy-pipeline-e0f5/attempts/17/final/live-probes (PR1881 FLAKY 3ce7aeb5)',
      },
      fn
    ),
  ] as const;
