import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Terminal from '@/pages/Terminal';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';

function mockAdminSession() {
  const user = {
    id: '1f85ff25-6e29-4c1b-8739-f917bd101a30',
    phone: '+19729777432',
    is_anonymous: false,
  };
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'admin-token',
      refresh_token: 'admin-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user,
    }),
  );
  localStorage.setItem('app-user', JSON.stringify(user));
}

function agentDetail(inspectionContext: Record<string, string> | null) {
  return {
    agent: {
      agent_id: 'foreign-agent',
      goal: 'Foreign account run',
      model: 'rose-1-lite',
      source: 'WEB',
      reasoning_effort: 'medium',
      progress: 50,
      status: 'ACTIVE',
      status_message: null,
      temporal_workflow_id: 'wf-foreign',
      token_count: 100,
      tokens_in: 80,
      tokens_out: 20,
      tool_tokens_in: 0,
      tool_tokens_out: 0,
      tool_cost_cents: 0,
      context_size: 4096,
      message_count: 1,
      price_limit_cents: 100,
      tree_cost_cents: 1,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:01:00Z',
      write_lock_enabled: false,
      parent_agent_id: null,
      parent_goal: null,
      verifier: null,
      tools: [],
    },
    messages: [],
    pagination: { has_more: false, oldest_timestamp: null },
    inspection_context: inspectionContext,
  };
}

describe('admin agent inspection', () => {
  beforeEach(() => {
    mockAdminSession();
    window.history.replaceState({}, '', '/?agent-id=foreign-agent');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
    localStorage.clear();
  });

  it('floats the affected account identity above a cross-account run', async () => {
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json(
          agentDetail({
            user_id: 'affected-user',
            name: 'Ada Lovelace',
            phone: '+15555550101',
            email: 'ada@example.com',
          }),
        ),
      ),
    );

    renderWithProviders(<Terminal />);

    const badge = await screen.findByTestId('inspection-account-badge');
    expect(badge).toHaveTextContent('Inspecting User Account');
    expect(badge).toHaveTextContent('Ada Lovelace');
    expect(badge).toHaveTextContent('+15555550101');
    expect(badge).toHaveTextContent('ada@example.com');
    expect(badge).toHaveTextContent('Read-only');
  });

  it("does not show the inspection badge for the admin account's own run", async () => {
    let detailRequests = 0;
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, () => {
        detailRequests += 1;
        return HttpResponse.json(agentDetail(null));
      }),
    );

    renderWithProviders(<Terminal />);

    await waitFor(() => expect(detailRequests).toBeGreaterThan(0));
    expect(screen.queryByTestId('inspection-account-badge')).not.toBeInTheDocument();
  });
});
