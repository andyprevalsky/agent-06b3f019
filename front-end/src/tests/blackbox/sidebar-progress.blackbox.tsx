import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockSession } from './app-sidebar.fixtures';
import RoseAgentRow from '@/features/terminal-component-group/components/rose-sidebar/RoseAgentRow';
import { makeAgent } from './app-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';
import { formatProgressEta, hydrateProgressEstimate, reconcileAgent } from '@/lib/progressEstimate';
import { handleUpdateAgent } from '@/features/agent-context/hooks/realtimeHandlers';
import type { AgentDetail, ProgressEstimate } from '@/lib/api';
const prediction: ProgressEstimate = {
  progress: 0.4,
  etaSeconds: 120,
  observedAt: '2026-10-21T01:00:00Z',
  sequence: 2,
  model: 'jev',
  promptVersion: 'v1',
};
function row(overrides = {}, expanded = true, attention = false) {
  return (
    <RoseAgentRow
      agent={makeAgent({
        agent_id: 'root',
        status: 'ACTIVE',
        temporal_workflow_id: 'wf',
        progress_estimate: prediction,
        ...overrides,
      })}
      isSelected={false}
      isExpanded={expanded}
      indented={false}
      hasAttentionRequest={attention}
      onClick={() => {}}
      actions={{
        onRename() {},
        onCopyLink() {},
        onTogglePin() {},
        onArchive() {},
        onNewAgentInBranch() {},
        onMarkUnread() {},
        onMute() {},
        onShare() {},
        onDelete() {},
        onSchedulePrompt() {},
        onCopyId() {},
      }}
      onMenuOpenChange={() => {}}
    />
  );
}
describe('Rose sidebar predicted progress', () => {
  beforeEach(() => mockSession());
  it('shows zero as an empty outline around the bot', () => {
    renderWithProviders(row({ progress_estimate: { ...prediction, progress: 0 } }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.queryByTestId('prediction-arc')).not.toBeInTheDocument();
    expect(document.querySelector('[data-sidebar-agent-icon]')).toBeInTheDocument();
  });
  it('matches the warning icon 14px footprint', () => {
    renderWithProviders(row());
    expect(screen.getByRole('progressbar')).toHaveAttribute('width', '14');
    expect(screen.getByRole('progressbar')).toHaveAttribute('height', '14');
  });
  it('shows progress on the robot corner and ETA only in a hover tooltip', async () => {
    const user = userEvent.setup();
    renderWithProviders(row());
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByTestId('prediction-arc')).toHaveAttribute('stroke-dasharray', '40 100');
    expect(screen.getByTestId('agent-progress-badge')).toHaveClass(
      'absolute',
      '-right-1.5',
      '-top-1',
    );
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimated time remaining/)).not.toBeInTheDocument();
    await user.hover(screen.getByTestId('agent-working-icon'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Estimated time remaining: ~2m');
    expect(tooltip.closest('[data-side]')).toHaveAttribute('data-side', 'top');
    await user.unhover(screen.getByTestId('agent-working-icon'));
  });
  it('never invents progress from legacy progress or elapsed time', () => {
    renderWithProviders(
      row({ progress_estimate: null, progress: 0.99, created_at: '2020-01-01T00:00:00Z' }),
    );
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(screen.queryByTestId('prediction-arc')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-predicted-eta')).not.toBeInTheDocument();
  });
  it.each([
    ['COMPLETED', 'Completed'],
    ['FAILED', 'Failed'],
    ['PAUSED', 'Paused'],
    ['OUT_OF_CREDITS', 'Out of credits'],
    ['COST_LIMIT_REACHED', 'Cost limit reached'],
  ] as const)('preserves %s distinction', (status, label) => {
    renderWithProviders(row({ status }));
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: label })).toBeInTheDocument();
    expect(document.querySelector('[data-sidebar-agent-icon]')).toBeInTheDocument();
    expect(screen.getByTestId('agent-status-badge')).toContainElement(
      screen.getByRole('img', { name: label }),
    );
    expect(screen.queryByTestId('agent-predicted-eta')).not.toBeInTheDocument();
  });
  it('attention overrides a prediction', () => {
    renderWithProviders(row({}, true, true));
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
  it.each([
    [0, '1m'],
    [3599, '1h'],
    [86400, '1d'],
    [2592000, '1mo'],
    [31536000, '1y'],
  ])('uses supported ETA bin %s', (seconds, label) => {
    expect(formatProgressEta(Number(seconds))).toBe(label);
  });
  it('applies estimate updates without list requests or chat-mode changes', () => {
    let agent = {
      ...makeAgent({ agent_id: 'root', temporal_workflow_id: 'wf' }),
      tools: [],
      verifier: null,
    } as AgentDetail;
    const load = vi.fn();
    const mode = vi.fn();
    handleUpdateAgent(
      { agentId: 'root', temporalWorkflowId: 'wf', progressEstimate: prediction },
      (update) => {
        agent = (typeof update === 'function' ? update(agent) : update)!;
      },
      mode,
      load,
    );
    expect(agent.progress_estimate).toEqual(prediction);
    expect(load).not.toHaveBeenCalled();
    expect(mode).not.toHaveBeenCalled();
  });
  it('hydrates camel case, rejects task leakage, and preserves newer polling predictions', () => {
    const previous = makeAgent({ agent_id: 'root', progress_estimate: prediction });
    expect(
      hydrateProgressEstimate({
        ...previous,
        progress_estimate: undefined,
        progressEstimate: prediction,
      }).progress_estimate,
    ).toEqual(prediction);
    expect(
      hydrateProgressEstimate({
        ...previous,
        progress_estimate: { ...prediction, taskId: 'child' },
      }).progress_estimate,
    ).toBeNull();
    expect(
      reconcileAgent(previous, {
        ...previous,
        progress_estimate: { ...prediction, sequence: 1, progress: 0.1 },
      }).progress_estimate,
    ).toEqual(prediction);
    expect(
      reconcileAgent(previous, { ...previous, status: 'FAILED' }).progress_estimate,
    ).toBeNull();
  });
  it('keeps task estimates separate and rejects mismatched task-map keys', () => {
    const agent = hydrateProgressEstimate({
      ...makeAgent({ agent_id: 'root' }),
      progressEstimate: prediction,
      taskProgressEstimates: {
        child: { ...prediction, taskId: 'child' },
        wrong: { ...prediction, taskId: 'elsewhere' },
      },
    });
    expect(agent.progress_estimate).toEqual(prediction);
    expect(agent.task_progress_estimates).toEqual({ child: { ...prediction, taskId: 'child' } });
  });
  it('clears estimates across run generations in snapshots and realtime', () => {
    const previous = makeAgent({
      agent_id: 'root',
      temporal_workflow_id: 'old',
      progress_estimate: prediction,
      task_progress_estimates: { child: { ...prediction, taskId: 'child' } },
    });
    const next = reconcileAgent(previous, {
      ...previous,
      temporal_workflow_id: 'new',
      progress_estimate: null,
      task_progress_estimates: {},
    });
    expect(next.progress_estimate).toBeNull();
    expect(next.task_progress_estimates).toEqual({});
    let agent = { ...previous, tools: [], verifier: null } as AgentDetail;
    handleUpdateAgent(
      { temporalWorkflowId: 'new' },
      (update) => {
        agent = (typeof update === 'function' ? update(agent) : update)!;
      },
      () => {},
    );
    expect(agent.progress_estimate).toBeNull();
    expect(agent.task_progress_estimates).toEqual({});
    handleUpdateAgent(
      {
        temporalWorkflowId: 'old',
        progressEstimate: { ...prediction, sequence: 99 },
        taskProgressEstimates: { child: { ...prediction, taskId: 'child' } },
      },
      (update) => {
        agent = (typeof update === 'function' ? update(agent) : update)!;
      },
      () => {},
    );
    expect(agent.temporal_workflow_id).toBe('new');
    expect(agent.progress_estimate).toBeNull();
    expect(agent.task_progress_estimates).toEqual({});
  });
  it('rejects stale and cross-agent events, clears terminal predictions', () => {
    let agent = {
      ...makeAgent({ agent_id: 'root', progress_estimate: prediction }),
      tools: [],
      verifier: null,
    } as AgentDetail;
    const setter = (update: React.SetStateAction<AgentDetail | null>) => {
      agent = (typeof update === 'function' ? update(agent) : update)!;
    };
    handleUpdateAgent(
      { agentId: 'root', progressEstimate: { ...prediction, sequence: 1, progress: 0.1 } },
      setter,
      () => {},
    );
    expect(agent.progress_estimate).toEqual(prediction);
    handleUpdateAgent(
      { agentId: 'other', progressEstimate: { ...prediction, sequence: 3 } },
      setter,
      () => {},
    );
    expect(agent.progress_estimate).toEqual(prediction);
    handleUpdateAgent(
      { agentId: 'root', status: 'COMPLETED', progressEstimate: { ...prediction, sequence: 3 } },
      setter,
      () => {},
    );
    expect(agent.progress_estimate).toBeNull();
    handleUpdateAgent(
      { agentId: 'root', progressEstimate: { ...prediction, sequence: 4 } },
      setter,
      () => {},
    );
    expect(agent.progress_estimate).toBeNull();
  });
});
