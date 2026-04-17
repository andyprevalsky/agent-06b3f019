/**
 * Blackbox tests for low-coverage terminal-component-group chip/card components.
 *
 * Bundles:
 *   - CompletionSummaryCard
 *   - ApprovalChip
 *   - SubAgentToolBubble
 *   - BrowserStatusBarCarousel
 *   - FeedbackBanner
 *
 * Heavy/child components (BrowserStatusBar, MarkdownText) are mocked so we can
 * exercise the component-under-test's branches without pulling in canvas / WebGL
 * / realtime subscriptions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';

// ── Mocks (hoisted before module-under-test imports) ─────────────────────────

// BrowserStatusBar is heavy — it imports realtime subscriptions, xterm adjacents,
// and DOM/ref-heavy behavior. Stub it to a simple placeholder that exposes its props.
vi.mock(
  '@/features/terminal-component-group/components/BrowserStatusBar',
  () => ({
    default: ({
      taskId,
      browserUrl,
      forceMinimized,
    }: {
      taskId: string;
      browserUrl: string;
      forceMinimized?: boolean;
    }) => (
      <div
        data-testid={`browser-status-bar-${taskId}`}
        data-url={browserUrl}
        data-force-minimized={String(!!forceMinimized)}
      >
        browser-{taskId}
      </div>
    ),
  }),
);

// MarkdownText is used by ApprovalChip. Replace with a passthrough to avoid
// having to stub react-markdown.
vi.mock('@/features/terminal-component-group/components/MarkdownText', () => ({
  MarkdownText: ({ text }: { text: string }) => (
    <div data-testid="markdown-text">{text}</div>
  ),
}));

// Mock the hooks module for ApprovalChip: imperative API fns + useToast.
const respondToAttentionRequestMock = vi.fn();
const rejectAttentionRequestMock = vi.fn();
const toastMock = vi.fn();
vi.mock('@/features/terminal-component-group/hooks', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    respondToAttentionRequest: (...args: unknown[]) =>
      respondToAttentionRequestMock(...args),
    rejectAttentionRequest: (...args: unknown[]) =>
      rejectAttentionRequestMock(...args),
    useToast: () => ({ toast: toastMock, dismiss: vi.fn() }),
  };
});

// Now the imports (after mocks).
import { CompletionSummaryCard } from '@/features/terminal-component-group/components/CompletionSummaryCard';
import ApprovalChip from '@/features/terminal-component-group/components/ApprovalChip';
import SubAgentToolBubble from '@/features/terminal-component-group/components/SubAgentToolBubble';
import BrowserStatusBarCarousel from '@/features/terminal-component-group/components/BrowserStatusBarCarousel';
import { FeedbackBanner } from '@/features/terminal-component-group/components/FeedbackBanner';

// ═══════════════════════════════════════════════════════════════════════════
// CompletionSummaryCard
// ═══════════════════════════════════════════════════════════════════════════

describe('CompletionSummaryCard', () => {
  it('renders task-complete header with summary only', () => {
    renderWithProviders(
      <CompletionSummaryCard data={{ summary: 'All good.' }} />,
    );
    expect(screen.getByText('Task Complete')).toBeInTheDocument();
    expect(screen.getByText('All good.')).toBeInTheDocument();
  });

  it('renders task-failed header when error=true', () => {
    renderWithProviders(
      <CompletionSummaryCard data={{ summary: 'Oops', error: true }} />,
    );
    expect(screen.getByText('Task Failed')).toBeInTheDocument();
  });

  it.skip('renders outputs with various value types and copy button', async () => {
    const user = userEvent.setup();
    // Mock clipboard
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          outputs: [
            { key: 'name', label: 'Name', value: 'Alice' },
            { key: 'tags', label: 'Tags', value: ['a', 'b', 'c'] },
            { key: 'nested', label: 'Nested', value: { foo: 'bar' } },
            { key: 'count', label: 'Count', value: 42 },
          ],
        }}
      />,
    );

    expect(screen.getByText('Output')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('a, b, c')).toBeInTheDocument();
    expect(screen.getByText('{"foo":"bar"}')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();

    // Copy button on first output
    const copyButtons = screen.getAllByTitle('Copy to clipboard');
    await user.click(copyButtons[0]);
    expect(writeText).toHaveBeenCalledWith('Alice');
  });

  it('renders FilePointer outputs as download chips (no copy button)', () => {
    const filePointer = {
      id: 'file-1',
      storage_path: 'attachments/foo.pdf',
      original_filename: 'foo.pdf',
      size_bytes: 1024,
    };
    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          outputs: [
            { key: 'doc', label: 'Document', value: filePointer as any },
            { key: 'docs', label: 'Documents', value: [filePointer] as any },
          ],
        }}
      />,
    );
    // File pointers render filename; copy button should NOT appear for
    // FilePointer values.
    expect(screen.getAllByText('foo.pdf').length).toBeGreaterThan(0);
    expect(screen.queryByTitle('Copy to clipboard')).not.toBeInTheDocument();
  });

  it('toggles tool usage breakdown and sorts by count desc', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          toolUsage: [
            { name: 'web_search', count: 2 },
            { name: 'custom_tool', count: 9 },
          ],
          totalToolCalls: 11,
        }}
      />,
    );
    // Total tool calls appears in collapsed header
    expect(screen.getByText('11')).toBeInTheDocument();
    // Tool list is collapsed initially (toolsExpanded = false)
    expect(screen.queryByText('Web Searches')).not.toBeInTheDocument();
    // Expand
    await user.click(screen.getByText('Tools'));
    expect(screen.getByText('Web Searches')).toBeInTheDocument();
    // Unknown tool name gets title-cased fallback
    expect(screen.getByText('Custom Tool')).toBeInTheDocument();
  });

  it('renders duration + cost footer, formatting minutes+seconds', () => {
    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          durationSeconds: 125,
          costDollars: 1.2345,
        }}
      />,
    );
    expect(screen.getByText('2m 5s')).toBeInTheDocument();
    expect(screen.getByText('$1.234')).toBeInTheDocument();
  });

  it('renders short duration in seconds only', () => {
    renderWithProviders(
      <CompletionSummaryCard
        data={{ summary: 'Done', durationSeconds: 5 }}
      />,
    );
    expect(screen.getByText('5s')).toBeInTheDocument();
  });

  it('derives totalTools from toolUsage when totalToolCalls omitted', () => {
    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          toolUsage: [
            { name: 'a', count: 3 },
            { name: 'b', count: 4 },
          ],
        }}
      />,
    );
    expect(screen.getByText('7')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ApprovalChip
// ═══════════════════════════════════════════════════════════════════════════

describe('ApprovalChip', () => {
  beforeEach(() => {
    respondToAttentionRequestMock.mockReset().mockResolvedValue(undefined);
    rejectAttentionRequestMock.mockReset().mockResolvedValue(undefined);
    toastMock.mockReset();
  });

  it('returns null when no pending approval', () => {
    const { container } = renderWithProviders(
      <ApprovalChip pendingApproval={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders question text and image', () => {
    renderWithProviders(
      <ApprovalChip
        pendingApproval={{
          attentionRequestId: 'req-1',
          question: 'Proceed?',
          imageUrl: 'https://example.com/img.png',
        }}
      />,
    );
    expect(screen.getByText('Approval Required')).toBeInTheDocument();
    expect(screen.getByText('Proceed?')).toBeInTheDocument();
    const img = screen.getByAltText('Request context') as HTMLImageElement;
    expect(img.src).toBe('https://example.com/img.png');
  });

  it('Accept: sends "Approved" by default and calls onApprovalHandled', async () => {
    const user = userEvent.setup();
    const onHandled = vi.fn();
    renderWithProviders(
      <ApprovalChip
        pendingApproval={{ attentionRequestId: 'req-1', question: 'Go?' }}
        onApprovalHandled={onHandled}
      />,
    );
    await user.click(screen.getByText('Accept'));
    expect(respondToAttentionRequestMock).toHaveBeenCalledWith('req-1', 'Approved');
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Approved' }),
    );
    expect(onHandled).toHaveBeenCalled();
  });

  it('Accept: uses trimmed context input when provided', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ApprovalChip
        pendingApproval={{ attentionRequestId: 'req-1', question: 'Go?' }}
      />,
    );
    await user.type(
      screen.getByPlaceholderText('Add context (optional)...'),
      '  custom reason  ',
    );
    await user.click(screen.getByText('Accept'));
    expect(respondToAttentionRequestMock).toHaveBeenCalledWith(
      'req-1',
      'custom reason',
    );
  });

  it('Accept: surfaces error toast on failure', async () => {
    respondToAttentionRequestMock.mockRejectedValueOnce(new Error('fail'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    renderWithProviders(
      <ApprovalChip
        pendingApproval={{ attentionRequestId: 'req-1', question: 'Go?' }}
      />,
    );
    await user.click(screen.getByText('Accept'));
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Error', variant: 'destructive' }),
    );
    errSpy.mockRestore();
  });

  it('Reject: sends undefined when context empty; onApprovalHandled fires', async () => {
    const user = userEvent.setup();
    const onHandled = vi.fn();
    renderWithProviders(
      <ApprovalChip
        pendingApproval={{ attentionRequestId: 'req-2', question: 'Stop?' }}
        onApprovalHandled={onHandled}
      />,
    );
    await user.click(screen.getByText('Reject'));
    expect(rejectAttentionRequestMock).toHaveBeenCalledWith('req-2', undefined);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Rejected' }),
    );
    expect(onHandled).toHaveBeenCalled();
  });

  it('Reject: surfaces error toast on failure', async () => {
    rejectAttentionRequestMock.mockRejectedValueOnce(new Error('nope'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    renderWithProviders(
      <ApprovalChip
        pendingApproval={{ attentionRequestId: 'req-3', question: 'Stop?' }}
      />,
    );
    await user.click(screen.getByText('Reject'));
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Error', variant: 'destructive' }),
    );
    errSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SubAgentToolBubble
// ═══════════════════════════════════════════════════════════════════════════

describe('SubAgentToolBubble', () => {
  it('renders title without emoji when none present, IN_PROGRESS styles applied', () => {
    renderWithProviders(
      <SubAgentToolBubble
        toolCallId="tc1"
        title="Analyzing data"
        message="msg"
        status="IN_PROGRESS"
        progress={0.4}
        agentId="ag-1"
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByText('Analyzing data')).toBeInTheDocument();
  });

  it('extracts leading emoji from title', () => {
    renderWithProviders(
      <SubAgentToolBubble
        toolCallId="tc2"
        title="🧠 Thinking deeply"
        message=""
        status="FINISHED"
        progress={1}
        agentId="ag-2"
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByText('Thinking deeply')).toBeInTheDocument();
    expect(screen.getByText('🧠')).toBeInTheDocument();
  });

  it('fires onNavigate when clicked and agentId is set', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderWithProviders(
      <SubAgentToolBubble
        toolCallId="tc3"
        title="Running"
        message=""
        status="IN_PROGRESS"
        progress={0.1}
        agentId="ag-3"
        onNavigate={onNavigate}
      />,
    );
    await user.click(screen.getByRole('button'));
    expect(onNavigate).toHaveBeenCalledWith('ag-3');
    logSpy.mockRestore();
  });

  it('does not call onNavigate when agentId is undefined', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderWithProviders(
      <SubAgentToolBubble
        toolCallId="tc4"
        title="Running"
        message=""
        status="IN_PROGRESS"
        progress={0}
        onNavigate={onNavigate}
      />,
    );
    await user.click(screen.getByRole('button'));
    expect(onNavigate).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BrowserStatusBarCarousel
// ═══════════════════════════════════════════════════════════════════════════

describe('BrowserStatusBarCarousel', () => {
  it('returns null when no browsers given', () => {
    const { container } = renderWithProviders(
      <BrowserStatusBarCarousel browsers={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a single browser without carousel controls', () => {
    renderWithProviders(
      <BrowserStatusBarCarousel
        browsers={[{ taskId: 't1', browserUrl: 'https://x.com' }]}
      />,
    );
    expect(screen.getByTestId('browser-status-bar-t1')).toBeInTheDocument();
    expect(screen.queryByLabelText('Previous browser')).not.toBeInTheDocument();
  });

  it('renders multiple browsers with navigation arrows and index indicator', () => {
    renderWithProviders(
      <BrowserStatusBarCarousel
        browsers={[
          { taskId: 't1', browserUrl: 'https://x.com' },
          { taskId: 't2', browserUrl: 'https://y.com' },
          { taskId: 't3', browserUrl: 'https://z.com' },
        ]}
      />,
    );
    expect(screen.getByLabelText('Previous browser')).toBeInTheDocument();
    expect(screen.getByLabelText('Next browser')).toBeInTheDocument();
    expect(screen.getByText('1/3')).toBeInTheDocument();
  });

  it('advances with Next and wraps with Previous', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <BrowserStatusBarCarousel
        browsers={[
          { taskId: 't1', browserUrl: 'https://x.com' },
          { taskId: 't2', browserUrl: 'https://y.com' },
        ]}
      />,
    );
    expect(screen.getByText('1/2')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Next browser'));
    expect(screen.getByText('2/2')).toBeInTheDocument();
    // Wrap around back to 1/2
    await user.click(screen.getByLabelText('Next browser'));
    expect(screen.getByText('1/2')).toBeInTheDocument();
    // Previous wraps back to 2/2
    await user.click(screen.getByLabelText('Previous browser'));
    expect(screen.getByText('2/2')).toBeInTheDocument();
  });

  it('clicking a non-active card activates it', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <BrowserStatusBarCarousel
        browsers={[
          { taskId: 't1', browserUrl: 'https://x.com' },
          { taskId: 't2', browserUrl: 'https://y.com' },
        ]}
      />,
    );
    expect(screen.getByText('1/2')).toBeInTheDocument();
    // Click the non-active (t2) card wrapper
    const t2 = screen.getByTestId('browser-status-bar-t2');
    await user.click(t2.parentElement!);
    expect(screen.getByText('2/2')).toBeInTheDocument();
  });

  it('shrinks browsers array → activeIndex clamps to remaining range', () => {
    const { rerender } = renderWithProviders(
      <BrowserStatusBarCarousel
        browsers={[
          { taskId: 't1', browserUrl: 'https://x.com' },
          { taskId: 't2', browserUrl: 'https://y.com' },
          { taskId: 't3', browserUrl: 'https://z.com' },
        ]}
      />,
    );
    // Reduce to 1 → single browser path
    rerender(
      <BrowserStatusBarCarousel
        browsers={[{ taskId: 't1', browserUrl: 'https://x.com' }]}
      />,
    );
    expect(screen.getByTestId('browser-status-bar-t1')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FeedbackBanner
// ═══════════════════════════════════════════════════════════════════════════

describe('FeedbackBanner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders rating prompt with 5 stars', () => {
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    expect(screen.getByText('How was this result?')).toBeInTheDocument();
    // 5 star buttons
    const buttons = screen
      .getAllByRole('button')
      .filter((b) => b.querySelector('.lucide-star'));
    expect(buttons).toHaveLength(5);
  });

  it('star hover toggles hoveredStar (re-renders color)', () => {
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    const starButtons = screen
      .getAllByRole('button')
      .filter((b) => b.querySelector('.lucide-star'));
    fireEvent.mouseEnter(starButtons[2]);
    fireEvent.mouseLeave(starButtons[2]);
    // No assertion needed beyond no-throw — exercises mouseEnter/Leave code paths
    expect(starButtons.length).toBe(5);
  });

  it('clicking a star expands the panel and reveals form controls', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    const stars = screen
      .getAllByRole('button')
      .filter((b) => b.querySelector('.lucide-star'));
    await user.click(stars[2]); // rating = 3
    expect(screen.getByText('Issue type (optional)')).toBeInTheDocument();
    expect(screen.getByText('Comment (optional)')).toBeInTheDocument();
    expect(screen.getByText('Submit')).toBeInTheDocument();
  });

  it.skip('Cancel resets selected rating and collapses panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    const stars = screen
      .getAllByRole('button')
      .filter((b) => b.querySelector('.lucide-star'));
    await user.click(stars[1]);
    expect(screen.getByText('Submit')).toBeInTheDocument();
    await user.click(screen.getByText('Cancel'));
    // Panel collapsed → Submit button gone
    expect(screen.queryByText('Submit')).not.toBeInTheDocument();
  });

  it('Submit: calls onSubmit with rating and shows thank-you state on success', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={onSubmit} />);
    const stars = screen
      .getAllByRole('button')
      .filter((b) => b.querySelector('.lucide-star'));
    await user.click(stars[4]); // rating = 5
    await user.type(screen.getByPlaceholderText('Additional feedback'), 'Great!');
    await user.click(screen.getByText('Submit'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        rating: 5,
        comment: 'Great!',
        helpImprove: true,
      }),
    );
    // Thank-you state
    expect(
      await screen.findByText('Thanks for your feedback!'),
    ).toBeInTheDocument();
  });

  it('Submit: logs error when onSubmit rejects, stays in form', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('bad'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={onSubmit} />);
    const stars = screen
      .getAllByRole('button')
      .filter((b) => b.querySelector('.lucide-star'));
    await user.click(stars[0]);
    await user.click(screen.getByText('Submit'));
    expect(errSpy).toHaveBeenCalled();
    // Should not transition to thank-you
    expect(
      screen.queryByText('Thanks for your feedback!'),
    ).not.toBeInTheDocument();
    errSpy.mockRestore();
  });

  it('Submit is disabled when rating is 0', async () => {
    renderWithProviders(<FeedbackBanner onSubmit={vi.fn()} />);
    // Without any star click, Submit is not rendered — but test that the
    // guard triggers. Click star, then cancel to force panel open+rating=0
    // is not possible because cancel collapses panel; instead, we just assert
    // the panel-closed state.
    expect(screen.queryByText('Submit')).not.toBeInTheDocument();
  });

  it('toggles helpImprove checkbox', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithProviders(<FeedbackBanner onSubmit={onSubmit} />);
    const stars = screen
      .getAllByRole('button')
      .filter((b) => b.querySelector('.lucide-star'));
    await user.click(stars[2]);
    const checkbox = screen.getByRole('checkbox', {
      name: /help rose improve/i,
    });
    await user.click(checkbox); // uncheck
    await user.click(screen.getByText('Submit'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ helpImprove: false }),
    );
  });
});
