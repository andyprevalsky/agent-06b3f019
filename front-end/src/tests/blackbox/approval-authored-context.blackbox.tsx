import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import ApprovalChip from '@/features/terminal-component-group/components/ApprovalChip';
import { BrowserWriteLockApproval } from '@/features/terminal-component-group/components/browser-status-bar/BrowserWriteLockApproval';
import { GateStack } from '@/features/terminal/components/GateStack';
import { checkAndRespondToAttentionRequest, respondToAttentionRequest } from '@/lib/api';
import { checkAndRespondToAttention } from '@/features/terminal/api';
import type { AttentionRequest } from '@/lib/api';
import { AttentionInboxContent } from '@/features/terminal-component-group/components/attention-inbox/AttentionInboxContent';
import { useAttentionActions } from '@/features/terminal-component-group/components/attention-inbox/useAttentionActions';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { mockSession } from './realtime-subscription.fixtures';

const API_BASE = 'http://localhost:3001/api';
type Surface = 'approval' | 'browser' | 'inbox';
const inboxRequest: AttentionRequest = {
  id: 'authored-request',
  agent_id: 'agent',
  workflow_id: 'workflow',
  question: 'Continue?',
  created_at: '2026-10-14T17:33:50Z',
  updated_at: '2026-10-14T17:33:50Z',
  answered: false,
};

beforeEach(() => mockSession());
afterEach(() => localStorage.clear());

function captureResponses() {
  const requests: { action: string; body: unknown }[] = [];
  server.use(
    http.post(`${API_BASE}/attention-requests/:requestId/:action`, async ({ request, params }) => {
      const text = await request.text();
      requests.push({ action: String(params.action), body: text ? JSON.parse(text) : undefined });
      return HttpResponse.json({ success: true });
    }),
  );
  return requests;
}

function renderApproval(surface: Surface) {
  renderWithProviders(
    surface === 'inbox' ? (
      <AttentionInboxContent
        requests={[inboxRequest]}
        refetch={async () => {}}
        isActive
        onSelectAgent={() => {}}
        onClose={() => {}}
      />
    ) : surface === 'approval' ? (
      <ApprovalChip
        pendingApproval={{ attentionRequestId: 'authored-request', question: 'Continue?' }}
      />
    ) : (
      <BrowserWriteLockApproval attentionRequestId="authored-request" question="Continue?" />
    ),
  );
}

const typedCases = (['approval', 'browser', 'inbox'] as const).flatMap((surface) =>
  (['Accept', 'Reject'] as const).flatMap((action) =>
    [
      surface === 'inbox'
        ? '  Please keep\n Tamara’s calendar.  '
        : '  Please keep  Tamara’s calendar.  ',
      '  Approved  ',
    ].map((context) => ({ surface, action, context })),
  ),
);

it.each(typedCases)(
  '$surface $action preserves actual typed context bytes: $context',
  async ({ surface, action, context }) => {
    const requests = captureResponses();
    const user = userEvent.setup();
    renderApproval(surface);
    fireEvent.change(screen.getByPlaceholderText('Add context (optional)...'), {
      target: { value: context },
    });
    await user.click(screen.getByRole('button', { name: action }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual(
      action === 'Accept'
        ? { action: 'respond', body: { response: context.trim(), user_message: context } }
        : { action: 'reject', body: { message: context } },
    );
  },
);

const protocolCases = (['approval', 'browser', 'inbox'] as const).flatMap((surface) =>
  (['Accept', 'Reject'] as const).flatMap((action) =>
    ['', '   '].map((context) => ({ surface, action, context })),
  ),
);

it.each(protocolCases)(
  '$surface $action omits authored text for an empty input: "$context"',
  async ({ surface, action, context }) => {
    const requests = captureResponses();
    const user = userEvent.setup();
    renderApproval(surface);
    fireEvent.change(screen.getByPlaceholderText('Add context (optional)...'), {
      target: { value: context },
    });
    await user.click(screen.getByRole('button', { name: action }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual(
      action === 'Accept'
        ? { action: 'respond', body: { response: 'Approved' } }
        : { action: 'reject', body: undefined },
    );
  },
);

it('keeps GateStack default reply tokens protocol-only', async () => {
  const requests = captureResponses();
  const user = userEvent.setup();
  renderWithProviders(
    <GateStack
      agentId="agent"
      onGateHandled={() => {}}
      pendingGates={[
        {
          attentionRequestId: 'protocol-gate',
          gate: {
            type: 'approval',
            gateKey: 'protocol-gate',
            presentation: { title: 'Confirm action', reason: 'Proceed?', cta: 'Confirm' },
            action: { kind: 'reply', tokens: ['YES'] },
          },
        },
      ]}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toEqual({ action: 'respond', body: { response: 'YES' } });
});

it('keeps automatic completion narratives protocol-only', async () => {
  const requests = captureResponses();
  const response = 'Opened the browser and completed authentication.';
  await respondToAttentionRequest('automatic-completion', response);
  expect(requests[0]).toEqual({ action: 'respond', body: { response } });
});

it('keeps an inbox protocol override separate from an actual typed draft', async () => {
  const requests = captureResponses();
  const { result } = renderHook(() =>
    useAttentionActions({
      requests: [inboxRequest],
      responses: { 'authored-request': '  unsent context draft  ' },
      clearResponse: () => {},
      refetch: async () => {},
      setIsOpen: () => {},
    }),
  );
  act(() => result.current.handleRespond('authored-request', 'YES'));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toEqual({ action: 'respond', body: { response: 'YES' } });
});

it('preserves typed terminal messages when a pending attention request intercepts delivery', async () => {
  const requests = captureResponses();
  server.use(
    http.get(`${API_BASE}/attention-requests`, () =>
      HttpResponse.json({ requests: [inboxRequest] }),
    ),
  );
  const message = '  Actual typed\n terminal message  ';
  expect(await checkAndRespondToAttention('agent', message)).toBe(true);
  expect(requests[0]).toEqual({
    action: 'respond',
    body: { response: message, user_message: message },
  });
});

it('does not infer authored text in the shared protocol-only pending-request helper', async () => {
  const requests = captureResponses();
  server.use(
    http.get(`${API_BASE}/attention-requests`, () =>
      HttpResponse.json({ requests: [inboxRequest] }),
    ),
  );
  expect(await checkAndRespondToAttentionRequest('agent', 'YES')).toBe(true);
  expect(requests[0]).toEqual({ action: 'respond', body: { response: 'YES' } });
});

it.each(['approval', 'browser'] as const)(
  '$surface context input stays 16px on phones so iOS Safari never zooms or pans while typing',
  (surface) => {
    renderApproval(surface);
    const input = screen.getByPlaceholderText('Add context (optional)...');
    // A bare text-sm would beat the Input's mobile text-base through tailwind-merge (14px → iOS focus zoom).
    expect(input.className.split(/\s+/)).toContain('text-base');
    expect(input.className.split(/\s+/)).toContain('md:text-sm');
    expect(input.className.split(/\s+/)).not.toContain('text-sm');
  },
);
