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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import type { FilePointer } from '@/lib/api';

// ── Mocks (hoisted before module-under-test imports) ─────────────────────────

// BrowserStatusBar is heavy — it imports realtime subscriptions, xterm adjacents,
// and DOM/ref-heavy behavior. Stub it to a simple placeholder that exposes its props.
// MarkdownText is used by ApprovalChip. Replace with a passthrough to avoid
// having to stub react-markdown.
vi.mock('@/features/terminal-component-group/components/MarkdownText', () => ({
  MarkdownText: ({ text }: { text: string }) => <div data-testid="markdown-text">{text}</div>,
}));

// Mock the hooks module for ApprovalChip: imperative API fns + useToast.
const respondToAttentionRequestMock = vi.fn();
const rejectAttentionRequestMock = vi.fn();
const toastMock = vi.fn();
vi.mock('@/features/terminal-component-group/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/terminal-component-group/hooks')>();
  return {
    ...actual,
    respondToAttentionRequest: (...args: unknown[]) => respondToAttentionRequestMock(...args),
    rejectAttentionRequest: (...args: unknown[]) => rejectAttentionRequestMock(...args),
    useToast: () => ({ toast: toastMock, dismiss: vi.fn() }),
  };
});

// Now the imports (after mocks).
import { CompletionSummaryCard } from '@/features/terminal-component-group/components/CompletionSummaryCard';
import ApprovalChip from '@/features/terminal-component-group/components/ApprovalChip';
import SubAgentToolBubble from '@/features/terminal-component-group/components/SubAgentToolBubble';

// ═══════════════════════════════════════════════════════════════════════════
// CompletionSummaryCard
// ═══════════════════════════════════════════════════════════════════════════

describe('CompletionSummaryCard', () => {
  it('renders task-complete header with summary only', () => {
    renderWithProviders(<CompletionSummaryCard data={{ summary: 'All good.' }} />);
    expect(screen.getByText('Task Complete')).toBeInTheDocument();
    expect(screen.getByText('All good.')).toBeInTheDocument();
  });

  it('renders task-failed header when error=true', () => {
    renderWithProviders(<CompletionSummaryCard data={{ summary: 'Oops', error: true }} />);
    expect(screen.getByText('Task Failed')).toBeInTheDocument();
  });

  it('renders arrays of structured output objects in a human-readable format', () => {
    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          outputs: [
            {
              key: 'search_result_sections',
              label: 'Search Result Sections',
              value: [
                {
                  section_label: 'Best cities to live in during your 20s',
                  search_query: 'best cities to live in your 20s 2024 2025',
                  findings: [
                    'Cities were ranked for quality of life, value, and desirability.',
                    'Young professional lists emphasize jobs, rent, and nightlife.',
                  ],
                },
                {
                  section_label: 'Cheapest cost-of-living places in North America',
                  search_query: 'cheapest cost of living cities in North America 2024 2025',
                  findings: [
                    'Cost indexes compare rent, groceries, restaurants, and local buying power.',
                  ],
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText('Search Result Sections')).toBeInTheDocument();
    expect(screen.getByText('1. Best cities to live in during your 20s')).toBeInTheDocument();
    expect(
      screen.getByText('2. Cheapest cost-of-living places in North America'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Search Query:', { exact: false })).toHaveLength(2);
    expect(
      screen.getByText('Cities were ranked for quality of life, value, and desirability.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it('renders outputs with various value types and copy button', async () => {
    const user = userEvent.setup();
    // userEvent.setup() installs a clipboard stub on navigator (a getter); spy on it instead of reassigning.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');

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
    // Readable report formatting (47c9a09c2): array items render one per paragraph, records as "Key: value".
    expect(screen.getByText('a b c')).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, el) =>
          el?.textContent === 'Foo: bar' &&
          ![...el.children].some((child) => child.textContent === 'Foo: bar'),
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\{"foo"/)).not.toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();

    // Copy button on first output
    const copyButtons = screen.getAllByTitle('Copy to clipboard');
    await user.click(copyButtons[0]);
    expect(writeText).toHaveBeenCalledWith('Alice');
  });

  it('cancels the copied-state reset when the card unmounts', async () => {
    // A reset left pending fired after the test environment was torn down
    // ("window is not defined", an unhandled error that failed coverage).
    const user = userEvent.setup();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const view = renderWithProviders(
        <CompletionSummaryCard
          data={{ summary: 'Done', outputs: [{ key: 'name', label: 'Name', value: 'Alice' }] }}
        />,
      );
      await user.click(screen.getByTitle('Copy to clipboard'));
      const resetIndex = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === 2000);
      expect(resetIndex).toBeGreaterThanOrEqual(0);
      view.unmount();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(setTimeoutSpy.mock.results[resetIndex].value);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('renders FilePointer outputs as download chips (no copy button)', () => {
    const filePointer: FilePointer = {
      id: 'file-1',
      storage_path: 'attachments/foo.pdf',
      original_filename: 'foo.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1024,
      created_at: '2026-01-01T00:00:00Z',
    };
    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          outputs: [
            { key: 'doc', label: 'Document', value: filePointer },
            { key: 'docs', label: 'Documents', value: [filePointer] },
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
    renderWithProviders(<CompletionSummaryCard data={{ summary: 'Done', durationSeconds: 5 }} />);
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
    const { container } = renderWithProviders(<ApprovalChip pendingApproval={null} />);
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

  it('renders payment-card receipt metadata', () => {
    renderWithProviders(
      <ApprovalChip
        pendingApproval={{
          attentionRequestId: 'req-pay',
          question: 'Approve purchase?',
          requestPaymentCard: {
            merchant: 'Example Shop',
            currency: 'USD',
            lineItems: [
              {
                name: 'Desk Lamp',
                imageUrl: 'https://example.com/lamp.png',
                productUrl: 'https://example.com/products/desk-lamp',
                rating: '4.8 stars',
                reviewCount: '312 reviews',
                unitPriceCents: 1299,
                quantity: 2,
                lineTotalCents: 2598,
              },
            ],
            fees: [{ label: 'Tax', amountCents: 210 }],
            subtotalCents: 2598,
            totalCents: 2808,
          },
        }}
      />,
    );

    expect(screen.getByText('Example Shop')).toBeInTheDocument();
    expect(screen.getByText('Desk Lamp')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View product' })).toHaveAttribute(
      'href',
      'https://example.com/products/desk-lamp',
    );
    expect(screen.getByText('Reviews: 4.8 stars · 312 reviews')).toBeInTheDocument();
    expect(screen.getByText('Qty 2 · $12.99')).toBeInTheDocument();
    expect(screen.getAllByText('$25.98').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Tax')).toBeInTheDocument();
    expect(screen.getByText('$2.10')).toBeInTheDocument();
    expect(screen.getAllByText('$28.08').length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText(
        'Rose will charge your saved Stripe billing method, then issue a one-time virtual card.',
      ),
    ).toBeInTheDocument();
  });

  // RCA (agent 90ac106a): on a phone the card's title ("Approve a $22.81
  // purchase from …") rendered half-clipped under the header and the
  // Approve/Reject buttons sat below the fold. Two causes: the question had its
  // own max-h-[300px] nested scroller whose scrollTop could park past line one,
  // and the card had no height budget of its own so the ancestor
  // `overflow-hidden` column cut off whatever did not fit. Cement both: exactly
  // one scroll region, and it must not be the question/title element.
  it('bounds its own height and keeps the title out of a nested scroller', () => {
    const { container } = renderWithProviders(
      <ApprovalChip
        pendingApproval={{
          attentionRequestId: 'req-tall',
          question: 'Approve a $22.81 purchase from Lunette Cambodia - Ferry Building?',
          requestPaymentCard: {
            merchant: 'Lunette Cambodia - Ferry Building',
            currency: 'USD',
            lineItems: Array.from({ length: 8 }, (_, index) => ({
              name: `Lok Lak ${index}`,
              productUrl: `https://order.toasttab.com/online/lunette/item-lok-lak-${index}`,
              rating: '0 stars',
              reviewCount: '0 reviews',
              unitPriceCents: 2100,
              quantity: 1,
              lineTotalCents: 2100,
            })),
            subtotalCents: 16800,
            totalCents: 18100,
          },
        }}
      />,
    );

    // Mobile cap stays under half the viewport so the trajectory behind the
    // card remains readable while the user decides on a real charge.
    const card = container.querySelector('.max-h-\\[55dvh\\]');
    expect(card).not.toBeNull();
    expect(card?.className).toContain('flex-col');
    expect(card?.className).toContain('md:max-h-[70dvh]');

    // The title must not sit inside an element that scrolls independently of
    // the card body — that is what hid it behind the header.
    const title = screen.getByText(
      'Approve a $22.81 purchase from Lunette Cambodia - Ferry Building?',
    );
    const scrollers = Array.from(container.querySelectorAll('.overflow-y-auto'));
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0].contains(title)).toBe(true);
    expect(scrollers[0]).not.toBe(title);
    expect(scrollers[0].className).toContain('min-h-0');

    // Accept/Reject live outside the scroll region so they are always tappable.
    for (const label of [/accept/i, /reject/i]) {
      expect(scrollers[0].contains(screen.getByRole('button', { name: label }))).toBe(false);
    }

    // The scroller must be keyboard-reachable. Purchase details can overflow
    // with no focusable child inside, and a scroll container that cannot take
    // focus cannot be scrolled by keyboard — leaving someone approving a real
    // charge unable to read the items they are paying for.
    expect(scrollers[0].getAttribute('tabindex')).toBe('0');
    expect(scrollers[0].getAttribute('role')).toBe('region');
    expect(scrollers[0].getAttribute('aria-label')).toBeTruthy();
  });

  // CodeRabbit finding on PR #912: AgentChatArea keeps ApprovalChip mounted for
  // as long as SOME approval is pending, so a second request inherited the
  // first one's scrollTop and opened already scrolled past its own title —
  // a residual path to the very cutoff this card was changed to prevent.
  it('rewinds its scroll position when the approval request changes', () => {
    const approval = (id: string, merchant: string) => ({
      attentionRequestId: id,
      question: `Approve a $22.81 purchase from ${merchant}?`,
      requestPaymentCard: {
        merchant,
        currency: 'USD',
        lineItems: Array.from({ length: 8 }, (_, index) => ({
          name: `Item ${index}`,
          productUrl: `https://order.toasttab.com/online/x/item-${index}`,
          rating: '0 stars',
          reviewCount: '0 reviews',
          unitPriceCents: 2100,
          quantity: 1,
          lineTotalCents: 2100,
        })),
        subtotalCents: 16800,
        totalCents: 18100,
      },
    });

    const { container, rerender } = renderWithProviders(
      <ApprovalChip pendingApproval={approval('req-first', 'First Merchant')} />,
    );

    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    expect(scroller).not.toBeNull();

    // Simulate the user having scrolled the first approval's body down.
    scroller.scrollTop = 250;
    expect(scroller.scrollTop).toBe(250);

    // A different request arrives while the component stays mounted.
    rerender(<ApprovalChip pendingApproval={approval('req-second', 'Second Merchant')} />);

    expect(scroller.scrollTop).toBe(0);
    expect(screen.getByText('Approve a $22.81 purchase from Second Merchant?')).toBeInTheDocument();
  });

  it('renders historical payment metadata without undefined values or broken links', () => {
    renderWithProviders(
      <ApprovalChip
        pendingApproval={{
          attentionRequestId: 'req-old-pay',
          question: 'Approve historical purchase?',
          requestPaymentCard: {
            merchant: 'Legacy Shop',
            lineItems: [{ name: 'Old Item', unitPriceCents: 1000, quantity: 1 }],
            totalCents: 1000,
          },
        }}
      />,
    );

    expect(screen.getByText('Review details unavailable')).toBeInTheDocument();
    expect(screen.getByText('Product link unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View product' })).not.toBeInTheDocument();
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
    expect(respondToAttentionRequestMock).toHaveBeenCalledWith('req-1', 'Approved', undefined);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Approved' }));
    expect(onHandled).toHaveBeenCalled();
  });

  it('Accept: uses trimmed context input when provided', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ApprovalChip pendingApproval={{ attentionRequestId: 'req-1', question: 'Go?' }} />,
    );
    await user.type(screen.getByPlaceholderText('Add context (optional)...'), '  custom reason  ');
    await user.click(screen.getByText('Accept'));
    expect(respondToAttentionRequestMock).toHaveBeenCalledWith(
      'req-1',
      'custom reason',
      '  custom reason  ',
    );
  });

  it('Accept: surfaces error toast on failure', async () => {
    respondToAttentionRequestMock.mockRejectedValueOnce(new Error('fail'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    renderWithProviders(
      <ApprovalChip pendingApproval={{ attentionRequestId: 'req-1', question: 'Go?' }} />,
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
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Rejected' }));
    expect(onHandled).toHaveBeenCalled();
  });

  it('Reject: surfaces error toast on failure', async () => {
    rejectAttentionRequestMock.mockRejectedValueOnce(new Error('nope'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    renderWithProviders(
      <ApprovalChip pendingApproval={{ attentionRequestId: 'req-3', question: 'Stop?' }} />,
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
