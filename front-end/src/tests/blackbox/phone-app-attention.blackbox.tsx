/** Actual PhoneApp private attention form uses authenticated exact request/agent/task/lease. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { snapshot } from '@amplitude/rrweb-snapshot';
import { createPrivacyRecorderOptions } from '@amplitude/session-replay-dom-privacy';
import { AgentContext } from '@/features/terminal-component-group/hooks';
import { RoseAppsContext } from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
import { PhoneAppScreen } from '@/features/terminal-component-group/components/rose-apps/PhoneAppScreen';
import type { AgentContextValue } from '@/features/agent-context/types';
import type { RoseAppsValue } from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
import { fixture, messages, target } from './fixtures/phone-attention.fixture';
vi.mock('@/lib/api/client', () => ({
  API_BASE_WITH_PATH: 'http://localhost:3001/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer synthetic-user' }),
}));
function view() {
  return (
    <RoseAppsContext.Provider
      value={{ selectedAgentId: 'agent-a', tabs: [] } as unknown as RoseAppsValue}
    >
      <AgentContext.Provider
        value={
          {
            agent: { agent_id: 'agent-a' },
            selectedAgentId: 'agent-a',
            messages,
            isLoadingAgent: false,
            inspectionContext: null,
          } as unknown as AgentContextValue
        }
      >
        <PhoneAppScreen />
      </AgentContext.Provider>
    </RoseAppsContext.Provider>
  );
}
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:phone');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('masks and clears exact private input, dispatches once, never stores it in replay or storage', async () => {
  const f = fixture();
  const v = render(view());
  const input = await screen.findByLabelText('Private phone password');
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: 'SYNTHETIC-PRIVATE-CANARY' } });
  expect(JSON.stringify(snapshot(document, createPrivacyRecorderOptions()))).not.toContain(
    'SYNTHETIC-PRIVATE-CANARY',
  );
  const submit = screen.getByRole('button', { name: 'Type privately' });
  fireEvent.click(submit);
  fireEvent.click(submit);
  await waitFor(() => expect(f.posts.filter((p) => p.operation === 'input.text')).toHaveLength(1));
  expect(input).toHaveValue('');
  expect(JSON.stringify(localStorage)).not.toContain('SYNTHETIC-PRIVATE-CANARY');
  expect(JSON.stringify(sessionStorage)).not.toContain('SYNTHETIC-PRIVATE-CANARY');
  v.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});
it.each([
  { agentId: 'foreign' },
  { target: { ...target, leaseId: 'foreign' } },
  { completedAt: '2026-10-18T22:00:00Z' },
])('rejects mismatched authoritative attention %j', async (other) => {
  const f = fixture(other);
  render(view());
  await waitFor(() =>
    expect(f.calls.some((c) => c.endsWith('/auth-assistance/request-a'))).toBe(true),
  );
  expect(screen.queryByLabelText('Private phone password')).toBeNull();
  expect(f.posts).toEqual([]);
});
it('blocks completion and all new private input after an unknown command receipt', async () => {
  const f = fixture();
  f.setUnknown(true);
  render(view());
  const input = await screen.findByLabelText('Private phone password');
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: 'PRIVATE-UNCERTAIN-CANARY' } });
  fireEvent.click(screen.getByRole('button', { name: 'Type privately' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Authentication complete/ })).toBeDisabled(),
  );
  expect(input).toHaveValue('');
  expect(f.posts.filter((p) => p.operation === 'input.text')).toHaveLength(1);
});
