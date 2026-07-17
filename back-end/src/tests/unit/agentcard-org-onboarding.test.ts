#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  completeOrgCardholderOnboarding,
  refreshOrgCardholderStatus,
  type OrgOnboardingDependencies,
} from '../../providers/agentcard/org-onboarding';
import type { OrgOnboardingConfig } from '../../providers/agentcard/store';

function toolResult(payload: Record<string, unknown>): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function deps(overrides: Partial<OrgOnboardingDependencies>): Partial<OrgOnboardingDependencies> {
  return {
    getOrgManagedCardholderId: async () => undefined,
    getOrgOnboardingConfig: async () => undefined,
    saveOrgCardholderId: async () => {},
    ...overrides,
  };
}

async function main(): Promise<void> {
  // A callback whose sessionId does not match the session persisted for this user is rejected — even
  // if the upstream session is "completed" — so a foreign session cannot be bound to the user.
  let toolCalled = false;
  await assert.rejects(
    () =>
      completeOrgCardholderOnboarding(
        'user-1',
        'attacker-session',
        deps({
          getOrgOnboardingConfig: async () =>
            ({ sessionId: 'user-1-session', setupUrl: 'https://x/setup' }) as OrgOnboardingConfig,
          callOrgTool: async () => {
            toolCalled = true;
            return toolResult({ status: 'completed', cardholder_id: 'ch-attacker' });
          },
        })
      ),
    (error: unknown) =>
      error instanceof Error && error.message.includes('does not belong to this user')
  );
  assert.equal(toolCalled, false, 'must reject before calling the MCP for a foreign session');

  // No persisted session at all → rejected.
  await assert.rejects(
    () =>
      completeOrgCardholderOnboarding(
        'user-1',
        'some-session',
        deps({ getOrgOnboardingConfig: async () => undefined })
      ),
    (error: unknown) =>
      error instanceof Error && error.message.includes('does not belong to this user')
  );

  // external_user_id mismatch is still rejected even when the session id matches.
  await assert.rejects(
    () =>
      completeOrgCardholderOnboarding(
        'user-1',
        'user-1-session',
        deps({
          getOrgOnboardingConfig: async () =>
            ({ sessionId: 'user-1-session', setupUrl: 'https://x/setup' }) as OrgOnboardingConfig,
          callOrgTool: async () =>
            toolResult({
              status: 'completed',
              cardholder_id: 'ch-1',
              external_user_id: 'someone-else',
            }),
        })
      ),
    (error: unknown) =>
      error instanceof Error && error.message.includes('does not belong to this user')
  );

  // Happy path: matching session + completed status persists and returns the cardholder id.
  const saved: Array<{ userId: string; cardholderId: string }> = [];
  const cardholderId = await completeOrgCardholderOnboarding(
    'user-1',
    'user-1-session',
    deps({
      getOrgOnboardingConfig: async () =>
        ({ sessionId: 'user-1-session', setupUrl: 'https://x/setup' }) as OrgOnboardingConfig,
      callOrgTool: async () =>
        toolResult({ status: 'completed', cardholder_id: 'ch-1', external_user_id: 'user-1' }),
      saveOrgCardholderId: async (userId, ch) => {
        saved.push({ userId, cardholderId: ch });
      },
    })
  );
  assert.equal(cardholderId, 'ch-1');
  assert.deepEqual(saved, [{ userId: 'user-1', cardholderId: 'ch-1' }]);

  // refreshOrgCardholderStatus reports `approved` cardholders as connected (mintCard accepts them).
  const approved = await refreshOrgCardholderStatus(
    'user-1',
    deps({
      getOrgManagedCardholderId: async () => 'ch-1',
      callOrgTool: async () => toolResult({ status: 'approved' }),
    })
  );
  assert.deepEqual(approved, { connected: true, cardholderId: 'ch-1', status: 'approved' });

  const verified = await refreshOrgCardholderStatus(
    'user-1',
    deps({
      getOrgManagedCardholderId: async () => 'ch-1',
      callOrgTool: async () => toolResult({ status: 'verified' }),
    })
  );
  assert.equal(verified.connected, true);

  const pending = await refreshOrgCardholderStatus(
    'user-1',
    deps({
      getOrgManagedCardholderId: async () => 'ch-1',
      callOrgTool: async () => toolResult({ status: 'pending' }),
    })
  );
  assert.equal(pending.connected, false);

  process.stdout.write('AgentCard org onboarding tests passed\n');
}

void main();
