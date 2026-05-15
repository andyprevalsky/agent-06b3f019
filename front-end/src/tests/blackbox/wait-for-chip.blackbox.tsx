/**
 * Blackbox tests for WaitForChip.
 * Covers both modes (timestamp, condition), status branches, countdown,
 * expand/collapse toggling, and the embedded InlineExploreChip.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WaitForChip, {
  type WaitForCheck,
} from '@/features/terminal-component-group/components/WaitForChip';

// Mock ThinkingAnimation to avoid the rAF-driven SVG replay in jsdom
vi.mock('@/components/ThinkingAnimation', () => ({
  default: () => <div data-testid="thinking-animation" />,
}));

describe('WaitForChip — timestamp mode', () => {
  it('renders "Waiting for {time}" while in progress', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    render(
      <WaitForChip
        title="Waiting"
        message=""
        status="IN_PROGRESS"
        checks={[]}
        metadata={{ waitForMode: 'timestamp', untilTimestamp: future }}
      />,
    );
    expect(screen.getByText(/Waiting for/)).toBeInTheDocument();
    // Countdown for ~60s renders "1m left" or "59s left"
    expect(screen.getByText(/left/)).toBeInTheDocument();
  });

  it('renders "Waited until {time}" when complete', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    render(
      <WaitForChip
        title="Waited"
        message=""
        status="FINISHED"
        checks={[]}
        metadata={{ waitForMode: 'timestamp', untilTimestamp: past, durationSeconds: 120 }}
      />,
    );
    expect(screen.getByText(/Waited until/)).toBeInTheDocument();
    expect(screen.getByText(/2m/)).toBeInTheDocument();
  });

  it('renders error icon on ERROR status', () => {
    render(
      <WaitForChip
        title="Err"
        message=""
        status="ERROR"
        checks={[]}
        metadata={{ waitForMode: 'timestamp', untilTimestamp: new Date().toISOString() }}
      />,
    );
    expect(document.querySelector('.text-red-400')).not.toBeNull();
  });
});

describe('WaitForChip — condition mode', () => {
  function makeCheck(overrides: Partial<WaitForCheck> = {}): WaitForCheck {
    return {
      title: 'check',
      status: 'FINISHED',
      timestamp: new Date(Date.now() - 5_000).toISOString(),
      conditionMet: false,
      checkNum: 1,
      ...overrides,
    } as WaitForCheck;
  }

  it('renders "Waiting for {condition}" with check count while in progress', () => {
    render(
      <WaitForChip
        title="Waiting for inbox empty"
        message=""
        status="IN_PROGRESS"
        checks={[makeCheck({ checkNum: 1 })]}
        metadata={{
          waitForMode: 'condition',
          condition: 'inbox empty',
          checkIntervalSeconds: 60,
        }}
      />,
    );
    expect(screen.getByText('Waiting for inbox empty')).toBeInTheDocument();
    // '1 check · next in ...' content
    expect(screen.getByText(/1 check/)).toBeInTheDocument();
  });

  it('renders "Waited for {condition}" with green icon on completion', () => {
    render(
      <WaitForChip
        title=""
        message=""
        status="FINISHED"
        checks={[makeCheck({ checkNum: 1, conditionMet: true, status: 'FINISHED' })]}
        metadata={{
          waitForMode: 'condition',
          condition: 'file uploaded',
          conditionMet: true,
          data: { condition_met: true, checks_completed: 3 },
        }}
      />,
    );
    expect(screen.getByText('Waited for file uploaded')).toBeInTheDocument();
    expect(document.querySelector('.text-emerald-400')).not.toBeNull();
    expect(screen.getByText(/3 checks/)).toBeInTheDocument();
  });

  it('expands to show check history when clicked', async () => {
    const u = userEvent.setup();
    render(
      <WaitForChip
        title="Waiting for delivery"
        message=""
        status="IN_PROGRESS"
        checks={[
          makeCheck({ checkNum: 1, status: 'FINISHED', conditionMet: false }),
          makeCheck({ checkNum: 2, status: 'ERROR' }),
        ]}
        metadata={{ waitForMode: 'condition', condition: 'delivery', checkIntervalSeconds: 30 }}
      />,
    );
    expect(screen.queryByText('Check History')).not.toBeInTheDocument();

    const header = screen.getByText('Waiting for delivery');
    await u.click(header);

    expect(screen.getByText('Check History')).toBeInTheDocument();
    expect(screen.getByText(/Check 1/)).toBeInTheDocument();
    expect(screen.getByText(/Check 2/)).toBeInTheDocument();
  });

  it('renders InlineExploreChip for a live check and lets it expand', async () => {
    const u = userEvent.setup();
    render(
      <WaitForChip
        title="Waiting"
        message=""
        status="IN_PROGRESS"
        checks={[
          {
            title: 'running',
            status: 'IN_PROGRESS',
            timestamp: new Date().toISOString(),
            explore: {
              title: 'Checking mailbox',
              fullGoal: 'Check if inbox has the order confirmation email',
              message: 'exploring',
              status: 'IN_PROGRESS',
              steps: [
                {
                  title: 'Think about it',
                  status: 'FINISHED',
                  toolName: 'spawn_agent',
                  timestamp: '2026-01-01T00:00:00Z',
                  message: 'thinking...',
                },
                {
                  title: 'Search the web',
                  status: 'IN_PROGRESS',
                  toolName: 'web_search',
                  toolCallId: 'tc-search',
                  timestamp: '2026-01-01T00:00:01Z',
                  message: '',
                },
              ],
            },
          },
        ]}
        metadata={{
          waitForMode: 'condition',
          condition: 'email arrives',
          checkIntervalSeconds: 10,
        }}
      />,
    );
    // Live indicator present
    expect(screen.getByText('live')).toBeInTheDocument();
    // While exploring, the header shows the most recent non-thinking action
    // (here: "Search the web") rather than the static goal.
    expect(screen.getByText('Exploring')).toBeInTheDocument();
    expect(screen.getAllByText('Search the web').length).toBeGreaterThan(0);
    expect(screen.getByTestId('explore-thinking-icon')).toBeInTheDocument();
    expect(screen.getByTestId('explore-active-tool-icon')).toBeInTheDocument();

    // Click the inline chip to expand it
    await u.click(screen.getByText('Exploring'));
    // After expansion the full goal is also visible
    expect(screen.getByText('Check if inbox has the order confirmation email')).toBeInTheDocument();

    // Click a step with content to expand it (target the step row, not header)
    expect(screen.getAllByText('Search the web').length).toBeGreaterThan(0);
  });

  it('shows post-tool thinking immediately after the last tool FINISHED even before tokens stream', () => {
    render(
      <WaitForChip
        title="Waiting"
        message=""
        status="IN_PROGRESS"
        checks={[
          {
            title: 'running',
            status: 'IN_PROGRESS',
            timestamp: new Date().toISOString(),
            explore: {
              title: 'Checking mailbox',
              fullGoal: 'Check if inbox has the order confirmation email',
              message: 'exploring',
              status: 'IN_PROGRESS',
              steps: [
                {
                  title: 'Search the web',
                  status: 'FINISHED',
                  toolName: 'web_search',
                  toolCallId: 'tc-search',
                  timestamp: new Date(Date.now() - 2_000).toISOString(),
                  message: 'looked it up',
                },
              ],
            },
          },
        ]}
        metadata={{
          waitForMode: 'condition',
          condition: 'email arrives',
          checkIntervalSeconds: 10,
        }}
      />,
    );

    expect(screen.getByText('Exploring')).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/\d+\.\ds·0 tokens/);
  });

  it('starts the explore thinking carousel from zero even when the llm call is already streaming', () => {
    render(
      <WaitForChip
        title="Waiting"
        message=""
        status="IN_PROGRESS"
        checks={[
          {
            title: 'running',
            status: 'IN_PROGRESS',
            timestamp: new Date().toISOString(),
            explore: {
              title: 'Checking mailbox',
              fullGoal: 'Check if inbox has the order confirmation email',
              message: 'exploring',
              status: 'IN_PROGRESS',
              steps: [
                {
                  title: 'Search the web for order confirmation email',
                  status: 'FINISHED',
                  toolName: 'web_search',
                  toolCallId: 'tc-search',
                  timestamp: new Date(Date.now() - 1_000).toISOString(),
                  message: 'looked it up',
                },
              ],
            },
          },
        ]}
        thinkingStreamStartedAtMs={Date.now() - 5_000}
        thinkingStreamTokenCount={500}
        metadata={{
          waitForMode: 'condition',
          condition: 'email arrives',
          checkIntervalSeconds: 10,
        }}
      />,
    );

    expect(document.body.textContent).toMatch(/0\.0s·0 tokens/);
  });

  it('renders finished inline explore with state-only header and result body', async () => {
    const u = userEvent.setup();
    render(
      <WaitForChip
        title="Waiting"
        message=""
        status="FINISHED"
        checks={[
          {
            title: 'finished',
            status: 'FINISHED',
            timestamp: new Date().toISOString(),
            conditionMet: true,
            explore: {
              title: 'Checking mailbox',
              fullGoal: 'Check if inbox has the order confirmation email',
              message:
                'The production deployment is ready. Status: READY. URL: https://roselabs.ai',
              status: 'FINISHED',
              steps: [
                {
                  title: 'Search the web for production deployment status',
                  status: 'FINISHED',
                  toolName: 'web_search',
                  timestamp: '2026-01-01T00:00:01Z',
                  message:
                    '**Params Passed:**\n\n- **query**: Vercel production deployment status roselabs.ai\n\n**Result:**\n\nDeployment status READY',
                },
              ],
            },
          },
        ]}
        metadata={{
          waitForMode: 'condition',
          condition: 'email arrives',
          conditionMet: true,
        }}
      />,
    );

    await u.click(screen.getByText('Waited for email arrives'));

    expect(screen.getByText('Explored')).toBeInTheDocument();
    expect(screen.queryByText(/Explored -/)).not.toBeInTheDocument();
    expect(document.body.textContent).toContain('The production deployment is ready');
  });

  it('renders failed inline explore with state-only header and error result body', async () => {
    const u = userEvent.setup();
    render(
      <WaitForChip
        title="Failed waiting for deploy ready"
        message=""
        status="ERROR"
        checks={[
          {
            title: 'failed',
            status: 'ERROR',
            timestamp: new Date().toISOString(),
            conditionMet: false,
            explore: {
              title: 'Checking deployment',
              fullGoal: 'Check whether the production deployment finished',
              message:
                'Activity task failed: web_search_activity failed: Parallel AI search returned HTTP 429 Too Many Requests',
              status: 'ERROR',
              steps: [
                {
                  title: 'Search the web for production deployment status',
                  status: 'ERROR',
                  toolName: 'web_search',
                  timestamp: '2026-01-01T00:00:01Z',
                  message:
                    '**Params Passed:**\n\n- **query**: Vercel production deployment status roselabs.ai\n\n**Error:**\n\nParallel AI search returned HTTP 429 Too Many Requests',
                },
              ],
            },
          },
        ]}
        metadata={{
          waitForMode: 'condition',
          condition: 'deploy ready',
          conditionMet: false,
        }}
      />,
    );

    await u.click(screen.getByText('Failed waiting for deploy ready'));

    expect(screen.getByText('Explore Failed')).toBeInTheDocument();
    expect(screen.queryByText(/Explore Failed -/)).not.toBeInTheDocument();
    expect(document.body.textContent).toContain(
      'Parallel AI search returned HTTP 429 Too Many Requests',
    );
  });

  it('renders ERROR status with title fallback', () => {
    render(
      <WaitForChip
        title="Hit max checks"
        message=""
        status="ERROR"
        checks={[]}
        metadata={{ waitForMode: 'condition', condition: 'thing' }}
      />,
    );
    expect(screen.getByText('Hit max checks')).toBeInTheDocument();
    expect(document.querySelector('.text-red-400')).not.toBeNull();
  });

  it('fires onTypingComplete immediately on mount', async () => {
    let done = false;
    render(
      <WaitForChip
        title="x"
        message=""
        status="IN_PROGRESS"
        checks={[]}
        metadata={{ waitForMode: 'condition', condition: 'x' }}
        onTypingComplete={() => {
          done = true;
        }}
      />,
    );
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(done).toBe(true);
  });
});
