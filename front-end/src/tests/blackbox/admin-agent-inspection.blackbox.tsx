import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TopRightControls } from '@/components/TopRightControls';
import { AdminAccountSwitcher } from '@/features/admin-account-switcher';
import { InspectionAccountBadge } from '@/features/terminal/components/InspectionAccountBadge';
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
  let inspectionSlot: HTMLDivElement;

  beforeEach(() => {
    mockAdminSession();
    window.history.replaceState({}, '', '/?agent-id=foreign-agent');
    inspectionSlot = document.createElement('div');
    inspectionSlot.id = 'top-right-inspection-slot';
    inspectionSlot.dataset.testid = 'top-right-inspection-slot';
    document.body.append(inspectionSlot);
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
    localStorage.clear();
    inspectionSlot.remove();
  });

  it('floats the affected account identity above a cross-account run', async () => {
    const user = userEvent.setup();
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
    expect(badge.parentElement).toBe(screen.getByTestId('top-right-inspection-slot'));
    expect(badge.className).toContain('rounded-full');
    expect(badge.className).not.toContain('fixed');
    expect(badge).toHaveAccessibleName(
      'Inspecting Ada Lovelace, +15555550101, ada@example.com (read-only)',
    );
    expect(badge).toHaveTextContent('Inspecting Ada Lovelace');
    expect(badge).toHaveTextContent('Ada Lovelace');
    expect(screen.queryByText('Phone')).not.toBeInTheDocument();
    expect(screen.queryByText('Email')).not.toBeInTheDocument();

    await user.hover(badge);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Inspecting user account · Read-only');
    expect(tooltip).toHaveTextContent('Ada Lovelace');
    expect(tooltip).toHaveTextContent('+15555550101');
    expect(tooltip).toHaveTextContent('ada@example.com');
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

describe('top-right inspection control layout', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('places the compact inspection pill before the real account switcher', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <TopRightControls>
          <AdminAccountSwitcher
            isAdmin
            ownAccountLabel="Admin with an intentionally very long account label"
          />
        </TopRightControls>
        <InspectionAccountBadge
          context={{
            user_id: 'affected-user',
            name: 'Ada Lovelace',
            phone: '+15555550101',
            email: 'ada@example.com',
          }}
        />
      </>,
    );

    const controls = screen.getByTestId('top-right-controls');
    const badge = screen.getByTestId('inspection-account-badge');
    const slot = badge.parentElement;
    const accountControl = screen.getByTestId('admin-account-switcher');
    const accountPill = screen.getByTestId('admin-account-pill');
    const accountButton = screen.getByRole('button', { name: 'Switch account' });

    expect(slot?.parentElement).toBe(controls);
    expect(accountControl.parentElement).toBe(controls);
    expect(controls.firstElementChild).toBe(slot);
    expect(controls.lastElementChild).toBe(accountControl);
    expect(controls.className).toContain('gap-2');
    expect(controls.className).not.toContain('flex-wrap');
    expect(controls.className).toContain('max-w-[calc(100vw-2rem)]');
    expect(badge.className).toContain('min-w-0');
    expect(badge.querySelector('span')?.className).toContain('truncate');
    expect(accountControl.className).toContain('max-w-full');
    expect(accountControl.className).toContain('min-w-0');
    expect(accountPill.className).toContain('max-w-full');
    expect(accountPill.className).toContain('min-w-0');
    expect(accountButton.className).toContain('min-w-0');
    expect(accountButton.querySelector('span')?.className).toContain('min-w-0');
    expect(accountButton.querySelector('span')?.className).toContain('truncate');

    await user.tab();
    expect(badge).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Inspecting user account · Read-only',
    );
  });
});
