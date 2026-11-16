/**
 * Hub / archived sub-agents show breadcrumb chrome (parent_agent_id set) but
 * GET /ancestors walks only the live Agent table. The trail must still be
 * clickable from parent_agent_id + parent_goal, and ancestor rows that use
 * `agent_id` instead of `id` must navigate.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import { SubAgentBreadcrumb } from '@/features/terminal/components/SubAgentBreadcrumb';
import type { AgentDetail } from '@/lib/api';
import type { DripStyles } from '@/features/terminal/types';

const dripStyles: DripStyles = {
  blur: 0,
  bgOpacity: 0.8,
  borderOpacity: 0.5,
  shadowIntensity: 1,
  glow: 0,
  glowOpacity: 0,
  saturation: 1,
  brightness: 1,
  backgroundColorsScalar: 1,
  borderColorScalar: 1,
  borderRgb: '0,0,0',
};

function gpDetail(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent_id: 'gp-1',
    goal: 'You are analyzing ONE creator: Casey Winters',
    model: 'benchmark-hub',
    source: 'WEB',
    reasoning_effort: 'off',
    progress: 100,
    status: 'COMPLETED',
    status_message: null,
    temporal_workflow_id: 'benchmark-hub-gp-1',
    token_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    tool_tokens_in: 0,
    tool_tokens_out: 0,
    tool_cost_cents: 0,
    context_size: 0,
    message_count: 4,
    price_limit_cents: 0,
    tree_cost_cents: 0,
    created_at: '2026-08-29T00:00:00Z',
    updated_at: '2026-08-29T00:00:00Z',
    write_lock_enabled: true,
    parent_agent_id: 'root-1',
    parent_goal: 'Analyze the top 50 creators',
    verifier: null,
    tools: [],
    ...overrides,
  };
}

describe('SubAgentBreadcrumb (hub / archived sub-agents)', () => {
  it('keeps the ancestor chain and owner clickable while a coding session is current', async () => {
    const onSelectAgent = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <SubAgentBreadcrumb
        ancestors={[{ id: 'root-1', goal: 'Root goal' }]}
        agentDetail={gpDetail()}
        codeAgentTitle="verify_project"
        onSelectAgent={onSelectAgent}
        dripStyles={dripStyles}
        blur={0}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Agent breadcrumb' });
    expect(nav).toHaveTextContent('Root goal');
    expect(screen.getByText('verify_project')).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Root goal' }));
    expect(onSelectAgent).toHaveBeenLastCalledWith('root-1');
    await user.click(screen.getByRole('button', { name: gpDetail().goal }));
    expect(onSelectAgent).toHaveBeenLastCalledWith('gp-1');
  });

  it('synthesizes a clickable parent crumb when the ancestors API is empty', async () => {
    const onSelectAgent = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <SubAgentBreadcrumb
        ancestors={[]}
        agentDetail={gpDetail()}
        onSelectAgent={onSelectAgent}
        dripStyles={dripStyles}
        blur={0}
      />,
    );

    const parent = screen.getByRole('button', { name: 'Analyze the top 50 creators' });
    expect(parent).toBeInTheDocument();
    expect(screen.getByText('You are analyzing ONE creator: Casey Winters')).toBeInTheDocument();

    await user.click(parent);
    expect(onSelectAgent).toHaveBeenCalledWith('root-1');
  });

  it('navigates when the API returns agent_id instead of id', async () => {
    const onSelectAgent = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <SubAgentBreadcrumb
        ancestors={[{ agent_id: 'root-1', goal: 'root goal' } as never]}
        agentDetail={gpDetail({ parent_goal: null })}
        onSelectAgent={onSelectAgent}
        dripStyles={dripStyles}
        blur={0}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'root goal' }));
    expect(onSelectAgent).toHaveBeenCalledWith('root-1');
  });
});
