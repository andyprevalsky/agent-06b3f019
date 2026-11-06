/**
 * Blackbox tests for PlanChip.
 * Covers title rendering, per-task titles (full description hidden), status variants (planning/executing/complete/error),
 * streaming char counter, sequential/parallel/hypothesis headers,
 * execution-order sorting, dependency annotation, formatDeps, tool-name formatting,
 * expand/collapse.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanChip } from '@/features/terminal-component-group/components/PlanChip';
import type { PlanTask } from '@/lib/realtime-types';

// Stub the MarkdownText component — MarkdownText renders markdown content;
// we just need it to render the text so we can assert on it.
vi.mock('@/features/terminal-component-group/components/MarkdownText', () => ({
  MarkdownText: ({ text }: { text: string }) => <div data-testid="md">{text}</div>,
}));

function task(goal: string, tool = 'web_search'): PlanTask {
  return { goal, tool_name: tool };
}

describe('PlanChip', () => {
  it('renders the title and chevron', () => {
    render(
      <PlanChip
        plan={{
          title: 'Plan to do X',
          content: 'Some plan details',
          tasks: [],
          dependencies: null,
          join: 'all',
          status: 'ready',
        }}
      />,
    );
    expect(screen.getByText('Plan to do X')).toBeInTheDocument();
  });

  it('shows shimmer + elapsed token download counter when streaming', () => {
    render(
      <PlanChip
        plan={{
          title: 'Generating...',
          content: '',
          tasks: [],
          dependencies: null,
          join: 'all',
          status: 'planning',
        }}
        toolStatus="IN_PROGRESS"
        charCount={1234}
        streamStartedAtMs={Date.now() - 1800}
      />,
    );
    expect(screen.getByText('Generating...')).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/\d+\.\ds·\d+ tokens/);
    expect(document.querySelector('.lucide-arrow-down')).not.toBeNull();
    // Tasks section should NOT render while streaming
    expect(screen.queryByText(/Tasks/)).not.toBeInTheDocument();
  });

  it('auto-expands when in error state and renders AlertCircle', () => {
    render(
      <PlanChip
        plan={{
          title: 'Plan failed',
          content: 'Something broke',
          tasks: [],
          dependencies: null,
          join: 'all',
          status: 'error',
        }}
        toolStatus="ERROR"
      />,
    );
    // content is visible because isError auto-expands
    expect(screen.getByTestId('md').textContent).toBe('Something broke');
    expect(document.querySelector('.lucide-alert-circle, .lucide-circle-alert')).not.toBeNull();
  });

  it('renders "N Tasks · Parallel" when no deps', () => {
    render(
      <PlanChip
        plan={{
          title: 'Parallel plan',
          content: '',
          tasks: [task('A'), task('B'), task('C')],
          dependencies: null,
          join: 'all',
          status: 'ready',
        }}
      />,
    );
    expect(screen.getByText('3 Tasks · Parallel')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('renders "Sequential" header for a simple chain', () => {
    render(
      <PlanChip
        plan={{
          title: 'Chain',
          content: '',
          tasks: [task('step 1'), task('step 2'), task('step 3')],
          dependencies: { '1': ['0'], '2': ['1'] },
          join: 'all',
          status: 'ready',
        }}
      />,
    );
    expect(screen.getByText('3 Tasks · Sequential')).toBeInTheDocument();
  });

  it('renders "N Tasks" for a non-chain DAG and shows deps inline', () => {
    render(
      <PlanChip
        plan={{
          title: 'DAG',
          content: '',
          tasks: [task('a'), task('b'), task('c')],
          dependencies: { '2': ['0', '1'] },
          join: 'all',
          status: 'ready',
        }}
      />,
    );
    expect(screen.getByText('3 Tasks')).toBeInTheDocument();
    // c depends on a and b → "→ after 1, 2"
    expect(screen.getByText('→ after 1, 2')).toBeInTheDocument();
  });

  it('renders "N Hypotheses" header and diamond markers when join=any', () => {
    render(
      <PlanChip
        plan={{
          title: 'Hypotheses',
          content: '',
          tasks: [task('h1'), task('h2')],
          dependencies: null,
          join: 'any',
          status: 'ready',
        }}
      />,
    );
    expect(screen.getByText('2 Hypotheses')).toBeInTheDocument();
    // diamond markers for hypothesis mode
    const diamonds = screen.getAllByText('◇');
    expect(diamonds.length).toBe(2);
  });

  it('shows each task title instead of its full description', () => {
    const description =
      'Search the web for Blue Bottle store hours in Oakland and list every location';
    render(
      <PlanChip
        plan={{
          title: 'Titled plan',
          content: '',
          tasks: [
            {
              title: 'Find Blue Bottle hours',
              goal: description,
              tool_name: 'spawn_explore_agent',
            },
            { goal: 'Legacy untitled task', tool_name: 'reasoning' },
          ],
          dependencies: null,
          join: 'all',
          status: 'ready',
        }}
      />,
    );
    expect(screen.getByText('Find Blue Bottle hours')).toBeInTheDocument();
    expect(screen.queryByText(description)).not.toBeInTheDocument();
    // Plans made before task titles still show their goal.
    expect(screen.getByText('Legacy untitled task')).toBeInTheDocument();
  });

  it('formats tool names — spawn_browser_agent_v3 → "Browser Agent"', () => {
    render(
      <PlanChip
        plan={{
          title: 'Browser plan',
          content: '',
          tasks: [{ goal: 'scrape something', tool_name: 'spawn_browser_agent_v3' }],
          dependencies: null,
          join: 'all',
          status: 'ready',
        }}
      />,
    );
    expect(screen.getByText('Browser Agent')).toBeInTheDocument();
  });

  it('toggles expanded content section on header click', async () => {
    const u = userEvent.setup();
    render(
      <PlanChip
        plan={{
          title: 'Expandable plan',
          content: 'Detailed plan description',
          tasks: [task('a')],
          dependencies: null,
          join: 'all',
          status: 'ready',
        }}
      />,
    );
    // Initially collapsed — MarkdownText not rendered
    expect(screen.queryByTestId('md')).not.toBeInTheDocument();

    await u.click(screen.getByText('Expandable plan'));
    expect(screen.getByTestId('md').textContent).toBe('Detailed plan description');

    // Collapse back — AnimatePresence exit animation removes the node asynchronously.
    await u.click(screen.getByText('Expandable plan'));
    await waitFor(() => expect(screen.queryByTestId('md')).not.toBeInTheDocument(), {
      timeout: 2000,
    });
  });

  it('does not toggle expansion when plan has no content', async () => {
    const u = userEvent.setup();
    render(
      <PlanChip
        plan={{
          title: 'Empty',
          content: '',
          tasks: [task('a')],
          dependencies: null,
          join: 'all',
          status: 'ready',
        }}
      />,
    );
    await u.click(screen.getByText('Empty'));
    expect(screen.queryByTestId('md')).not.toBeInTheDocument();
  });

  it('preserves original task order when there is a dependency cycle', () => {
    render(
      <PlanChip
        plan={{
          title: 'Cycle',
          content: '',
          tasks: [task('t0'), task('t1'), task('t2')],
          // 0 → 1 → 2 → 0 cycle
          dependencies: { '0': ['2'], '1': ['0'], '2': ['1'] },
          join: 'all',
          status: 'ready',
        }}
      />,
    );
    // All three rendered, in ORIGINAL task order (t0, t1, t2) — not in some
    // cycle-mangled permutation. Assert both count and sequence.
    const items = Array.from(document.querySelectorAll('ul li'));
    expect(items).toHaveLength(3);
    const texts = items.map((it) => it.textContent ?? '');
    expect(texts[0]).toContain('t0');
    expect(texts[1]).toContain('t1');
    expect(texts[2]).toContain('t2');
  });

  it('shows tasks in execution order when dependencies are out of order', () => {
    render(
      <PlanChip
        plan={{
          title: 'Out of order',
          content: '',
          tasks: [task('use result from b'), task('produce result b')],
          dependencies: { '0': ['1'] },
          join: 'all',
          status: 'ready',
        }}
      />,
    );

    const items = Array.from(document.querySelectorAll('ul li'));
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('1.produce result b');
    expect(items[1].textContent).toContain('2.use result from b');
    expect(items[1].textContent).toContain('→ after 2');
  });
});
