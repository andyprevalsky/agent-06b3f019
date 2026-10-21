/* eslint-disable max-lines */
/**
 * Blackbox tests for four terminal-component-group components.
 *
 * Components covered:
 *  - QueryInput: textarea, model selector, price-limit edit, submit/pause button
 *  - AttentionInbox: empty vs populated, accept / reject / skip actions
 *  - BrowserStatusBar: minimized / expanded / Browser drawer + write-lock approval
 *
 * The tests lean on the shared `renderWithProviders` wrapper from
 * `test-wrapper.tsx` (QueryClient, TooltipProvider, MemoryRouter, AppDataProvider)
 * and, for BrowserStatusBar, also wrap the tree in an
 * `AgentContext.Provider` with a manually-constructed mock value so the
 * components can read `messages`/etc without standing up a live realtime
 * subscription.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

import QueryInput from '@/features/terminal-component-group/components/QueryInput';
import AsciiLoader from '@/features/terminal-component-group/components/AsciiLoader';
import { OpeningMessageDisplay } from '@/features/terminal/components/OpeningMessageDisplay';
import { ChatScrollArea } from '@/features/terminal/components/ChatScrollArea';
import { OPENING_MESSAGES } from '@/features/terminal/config';
import AttentionInbox from '@/features/terminal-component-group/components/AttentionInbox';
import BrowserStatusBar from '@/features/terminal-component-group/components/BrowserStatusBar';
import BrowserStatusBarCarousel from '@/features/terminal-component-group/components/BrowserStatusBarCarousel';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context/types';
import type { AgentDetail, Message } from '@/lib/api';

const API_BASE = 'http://localhost:3001/api';

// ─── Child stubs for components whose rendering pulls in heavy extras ─────
// MessageList is used by BrowserStatusBar and mounts a
// framer-motion tree keyed to the full AgentContext. Stubbing it keeps the
// tests focused on the parent's own DOM contract.
vi.mock('@/features/terminal-component-group/components/MessageList', () => {
  const MessageListStub = ({ subAgentId }: { subAgentId?: string }) => (
    <div data-testid="message-list-stub" data-subagent-id={subAgentId || ''} />
  );
  // The components barrel re-exports MessageList from this module's DEFAULT
  // export (`export { default as MessageList }`), so the default must be
  // stubbed too — otherwise the barrel-level `MessageList` is undefined.
  return { MessageList: MessageListStub, default: MessageListStub };
});

vi.mock('@/features/terminal-component-group/components/BrowserBorderGlow', () => ({
  default: () => <div data-testid="browser-border-glow" />,
}));

vi.mock('@/features/terminal-component-group/components/BrowserCursorOverlay', () => ({
  default: () => <div data-testid="browser-cursor-overlay" />,
}));

vi.mock('@/components/ThinkingAnimation', () => ({
  default: () => <div data-testid="thinking-animation" />,
}));

// The MarkdownText component in AttentionInbox is heavy (react-markdown +
// remark plugins) and not the subject of these tests — stub to plain text.
vi.mock('@/features/terminal-component-group/components/MarkdownText', () => ({
  MarkdownText: ({ text }: { text: string }) => <div data-testid="markdown-text">{text}</div>,
}));

// Polyfill Element.prototype.scrollIntoView (used by cmdk inside the Popover)
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

function resetTestUrl() {
  window.history.replaceState({}, '', '/');
}

function makeAgentDetail(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent_id: 'agent-123',
    goal: 'Test goal',
    model: 'rose-labs/rose-1-flash',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 0,
    status: 'ACTIVE',
    status_message: null,
    temporal_workflow_id: 'wf-abc',
    token_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    tool_tokens_in: 0,
    tool_tokens_out: 0,
    tool_cost_cents: 0,
    context_size: 0,
    message_count: 0,
    price_limit_cents: 500,
    tree_cost_cents: 100,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    write_lock_enabled: true,
    parent_agent_id: null,
    parent_goal: null,
    verifier: null,
    tools: [],
    ...overrides,
  } as unknown as AgentDetail;
}

function makeMockAgentContext(messages: Message[] = []): AgentContextValue {
  return {
    agent: null,
    applyAgentDetail: vi.fn(() => true),
    selectedAgentId: null,
    setSelectedAgentId: vi.fn(),
    messages,
    streamingBubbles: new Map(),
    streamingPlan: null,
    streamingAttention: null,
    streamingTools: new Map(),
    streamedTextsRef: { current: new Set<string>() },
    registerMessageHandler: vi.fn(() => () => {}),
    sendMessage: vi.fn(async () => {}),
    isLoadingAgent: false,
    forceResubscribe: vi.fn(),
    isChatMode: false,
    inspectionContext: null,
    stagePendingAgentCreation: vi.fn(),
    reconcilePendingAgentCreation: vi.fn(async () => {}),
    rollbackPendingAgentCreation: vi.fn(() => false),
  };
}

function withAgentCtx(messages: Message[], children: React.ReactNode, agentId?: string) {
  const context = makeMockAgentContext(messages);
  if (agentId !== undefined) {
    context.agent = makeAgentDetail({ agent_id: agentId });
    context.selectedAgentId = agentId;
  } else {
    // A browser chip always belongs to the selected agent; the Browser drawer
    // keys its tabs by that agent id.
    context.selectedAgentId = 'agent-selected';
  }
  return <AgentContext.Provider value={context}>{children}</AgentContext.Provider>;
}

// ═══════════════════════════════════════════════════════════════════════════
// QueryInput
// ═══════════════════════════════════════════════════════════════════════════

/** Rose Desktop: toolbar items live on the tab behind the box; hover it open first. */
async function clickNubItem(user: ReturnType<typeof userEvent.setup>, el: Element) {
  await user.hover(screen.getByTestId('query-toolbar-nub'));
  await user.click(el);
}

describe('QueryInput (blackbox)', () => {
  beforeEach(() => {
    mockSession();
  });

  afterEach(() => {
    localStorage.clear();
    resetTestUrl();
  });

  const defaultProps = {
    value: '',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    // Pin the selected model so these tests are decoupled from the component's
    // default (which is rose-1-ultra); they assert chip rendering/clicking, not
    // the default value.
    selectedModel: 'rose-labs/rose-1-flash',
    availableModels: [
      {
        id: 'rose-labs/rose-1-flash',
        name: 'rose-fast',
        provider: 'rose-labs',
        description: 'fast',
      },
      {
        id: 'rose-labs/rose-1-ultra',
        name: 'rose-1-ultra',
        provider: 'rose-labs',
        description: 'powerful',
      },
    ],
  };

  it('renders placeholder and shows selected model in footer', () => {
    renderWithProviders(<QueryInput {...defaultProps} placeholder="Enter any goal" />);

    expect(screen.getByPlaceholderText('Enter any goal')).toBeInTheDocument();
    // Rose Desktop (#77): only the short pool name.
    expect(screen.getByText('rose-flash')).toBeInTheDocument();
    expect(screen.queryByText('rose-labs/rose-fast')).toBeNull();
  });

  it('typing updates value via onChange (controlled)', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <QueryInput {...defaultProps} onChange={onChange} placeholder="type here" />,
    );

    const textarea = screen.getByPlaceholderText('type here');
    await user.type(textarea, 'abc');
    // onChange fired once per keystroke with the incremental text
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.some((c) => c[0] === 'a')).toBe(true);
  });

  it('plain Enter submits (handleSubmitWithAttachments path)', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<QueryInput {...defaultProps} value="hello" onSubmit={onSubmit} />);

    const textarea = screen.getByPlaceholderText('Type your message...');
    textarea.focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Cmd+Enter and Shift+Enter keep the native multiline behavior', () => {
    const onSubmit = vi.fn();
    renderWithProviders(<QueryInput {...defaultProps} value="hello" onSubmit={onSubmit} />);

    const textarea = screen.getByPlaceholderText('Type your message...');
    expect(fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disabled prop disables the textarea', () => {
    renderWithProviders(<QueryInput {...defaultProps} disabled />);
    const textarea = screen.getByPlaceholderText('Type your message...');
    expect(textarea).toBeDisabled();
  });

  it('clicking the send button invokes onSubmit', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<QueryInput {...defaultProps} value="query" onSubmit={onSubmit} />);
    // Submit button is the only button whose icon renders inside a LiquidWhiteButton,
    // but we can target by the SVG arrow's parent button more loosely — use
    // the very last <button> in the form (ArrowUp icon).
    const buttons = screen.getAllByRole('button');
    // Grab the final button — the send button
    await user.click(buttons[buttons.length - 1]);
    expect(onSubmit).toHaveBeenCalled();
  });

  it('send tooltip advertises plain Enter, not Cmd+Enter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QueryInput {...defaultProps} value="query" />);
    const buttons = screen.getAllByRole('button');

    await user.hover(buttons[buttons.length - 1]);

    expect((await screen.findAllByText('Enter')).length).toBeGreaterThan(0);
    expect(screen.queryByText('⌘')).not.toBeInTheDocument();
  });

  it('when canSubmit=false renders Stop button wired to onPause', async () => {
    const onPause = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<QueryInput {...defaultProps} canSubmit={false} onPause={onPause} />);
    const buttons = screen.getAllByRole('button');
    await user.click(buttons[buttons.length - 1]);
    expect(onPause).toHaveBeenCalled();
  });

  it('isPausing disables the stop button', () => {
    renderWithProviders(
      <QueryInput {...defaultProps} canSubmit={false} onPause={vi.fn()} isPausing />,
    );
    const buttons = screen.getAllByRole('button');
    const stop = buttons[buttons.length - 1];
    expect(stop).toBeDisabled();
  });

  it('renders cost-limit chip with default pending limit when no agent', () => {
    renderWithProviders(<QueryInput {...defaultProps} pendingPriceLimitCents={250} />);
    expect(screen.getByText('0.00 / 2.50')).toBeInTheDocument();
  });

  it('clicking cost chip (no agent) enters edit mode and shows an input', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QueryInput {...defaultProps} pendingPriceLimitCents={100} />);
    const chip = screen.getByText('0.00 / 1.00');
    await clickNubItem(user, chip.closest('button')!);

    const input = document.querySelector('input[placeholder="1.00"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
  });

  it('renders cost chip for root agent (with price limit) and allows clicking to edit', async () => {
    const agent = makeAgentDetail({ tree_cost_cents: 50, price_limit_cents: 500 });
    const user = userEvent.setup();
    renderWithProviders(<QueryInput {...defaultProps} agentDetail={agent} />);

    // root agent shows "cost / limit" with dollar formatting
    expect(screen.getByText('0.50 / 5.00')).toBeInTheDocument();

    // clicking opens the input
    const chip = screen.getByText('0.50 / 5.00').closest('button')!;
    await clickNubItem(user, chip);
    const input = document.querySelector('input[placeholder="1.00"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
  });

  it('renders cost chip for child agent (disabled, only cost visible)', () => {
    const agent = makeAgentDetail({
      parent_agent_id: 'parent-1',
      tree_cost_cents: 250,
    });
    renderWithProviders(<QueryInput {...defaultProps} agentDetail={agent} />);
    // Just the cost, no slash — spans render inline, content match is loose
    expect(screen.getByText('2.50')).toBeInTheDocument();
    // The button should be disabled for child agents
    const btn = screen.getByText('2.50').closest('button')!;
    expect(btn).toBeDisabled();
  });

  it('context percentage badge shows numeric value', () => {
    renderWithProviders(<QueryInput {...defaultProps} contextPercentage={42} />);
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('shows the switched model in the model-selector (Rose Desktop: rose-ultra)', () => {
    const { unmount } = renderWithProviders(
      <QueryInput {...defaultProps} selectedModel="rose-labs/rose-1-ultra" />,
    );
    expect(screen.getByText('rose-ultra')).toBeInTheDocument();
    unmount();
    renderWithProviders(<QueryInput {...defaultProps} selectedModel="rose-labs/rose-1-ultra" />, {
      roseDesktop: false,
    });
    expect(screen.getByText('rose-labs/rose-1-ultra')).toBeInTheDocument();
  });

  it('shows COMPLETED agent still renders (paperclip still present)', () => {
    const agent = makeAgentDetail({ status: 'COMPLETED' });
    const { container } = renderWithProviders(<QueryInput {...defaultProps} agentDetail={agent} />);
    // Target the paperclip button specifically: the <Paperclip> lucide icon
    // (class lucide-paperclip) is unique to the attachment trigger.
    const paperclipIcon = container.querySelector('svg.lucide-paperclip');
    expect(paperclipIcon).not.toBeNull();
    const paperclipBtn = paperclipIcon!.closest('button');
    expect(paperclipBtn).not.toBeNull();
    expect(paperclipBtn).toBeDisabled();
  });

  it('opens model picker popover and renders model names + descriptions', async () => {
    const onModelChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <QueryInput {...defaultProps} onModelChange={onModelChange} showModelSelector />,
    );

    // Click the model chip button to open the popover
    const chip = screen.getByText('rose-flash').closest('button')!;
    await user.click(chip);

    // Model picker shows both model options with their descriptions
    await waitFor(() => {
      expect(
        screen.getByText(
          'Super fast execution with full-strength planning. Avg tok/s: not yet measured. Intelligence vs frontier: not yet benchmarked.',
        ),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        'Maximum reasoning for complex, long-horizon tasks. For example: get more calls on my calendar with people who match my ideal customer profile.',
      ),
    ).toBeInTheDocument();
    // Rose Desktop (#77): the options read rose-flash / rose-ultra too.
    const options = screen.getAllByRole('option').map((o) => o.querySelector('.font-medium'));
    expect(options.map((o) => o?.textContent)).toEqual(['rose-flash', 'rose-ultra']);
  });

  it('stock model picker keeps provider/name on the chip and model names in the options', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QueryInput {...defaultProps} showModelSelector />, {
      roseDesktop: false,
    });
    await user.click(screen.getByText('rose-labs/rose-fast').closest('button')!);
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    const options = screen.getAllByRole('option').map((o) => o.querySelector('.font-medium'));
    expect(options.map((o) => o?.textContent)).toEqual(['rose-fast', 'rose-1-ultra']);
  });

  it('shows Rose Local in the querybox with an honest privacy and speed description', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <QueryInput
        {...defaultProps}
        showModelSelector
        availableModels={[
          ...defaultProps.availableModels,
          {
            id: 'rose-labs/rose-local',
            name: 'rose-local',
            provider: 'rose-labs',
            description: 'local',
          },
        ]}
      />,
      { roseDesktop: true },
    );
    await user.click(screen.getByText('rose-flash').closest('button')!);
    expect(screen.getByText('rose-local')).toBeInTheDocument();
    expect(screen.getByText(/Agent data still uses Rose cloud services/)).toBeInTheDocument();
    expect(screen.getByText(/Avg tok\/s and max throughput: unmeasured/)).toBeInTheDocument();
  });

  it('selecting an unknown-provider model fallbacks to provider description', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <QueryInput
        {...defaultProps}
        availableModels={[
          {
            id: 'other/alpha',
            name: 'alpha',
            provider: 'other-provider',
          },
          ...defaultProps.availableModels,
        ]}
      />,
    );

    const chip = screen.getByText('rose-flash').closest('button')!;
    await user.click(chip);

    await waitFor(() => {
      expect(screen.getByText('other-provider')).toBeInTheDocument();
    });
    // Non-Rose models keep their own name.
    expect(screen.getByText('alpha')).toBeInTheDocument();
  });

  it('renders attachment paperclip button and it is enabled for running agent', () => {
    const { container } = renderWithProviders(<QueryInput {...defaultProps} />);
    // Target the paperclip button by its lucide-paperclip icon — unique to the
    // attachment trigger. Button must NOT be disabled when no completed agent.
    const paperclipIcon = container.querySelector('svg.lucide-paperclip');
    expect(paperclipIcon).not.toBeNull();
    const paperclipBtn = paperclipIcon!.closest('button');
    expect(paperclipBtn).not.toBeNull();
    expect(paperclipBtn).not.toBeDisabled();
  });

  it('clicking the paperclip button triggers the hidden file input click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QueryInput {...defaultProps} />);

    // The hidden file input is the only <input type="file">
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const spy = vi.spyOn(fileInput, 'click');

    // Find the paperclip — it's the first icon-only button after the settings cluster.
    // Simpler: spy then click any button that renders a Paperclip SVG by querying for svg.lucide-paperclip parent.
    const paperclipSvg = document.querySelector('.lucide-paperclip');
    expect(paperclipSvg).toBeTruthy();
    const paperclipBtn = paperclipSvg!.closest('button')!;
    await user.click(paperclipBtn);

    expect(spy).toHaveBeenCalled();
  });

  it('Rose Desktop removes the info button next to the model selector (stock keeps it)', () => {
    const infoSelector = 'svg path[d*="M13 16h-1v-4h-1"]';
    const { unmount } = renderWithProviders(
      <QueryInput {...defaultProps} selectedModel="rose-labs/rose-1-flash" />,
    );
    expect(screen.getByText('rose-flash')).toBeInTheDocument();
    expect(document.querySelector(infoSelector)).toBeNull();
    unmount();

    renderWithProviders(<QueryInput {...defaultProps} selectedModel="rose-labs/rose-1-flash" />, {
      roseDesktop: false,
    });
    expect(screen.getByText('rose-labs/rose-fast')).toBeInTheDocument();
    expect(document.querySelector(infoSelector)).not.toBeNull();
  });

  it('drag over + drag leave cycle toggles the drop overlay class', async () => {
    const { container } = renderWithProviders(<QueryInput {...defaultProps} />);
    // The outer wrap is the first div under max-w-4xl — trigger drag events on its child
    const dragWrapper = container.querySelector('[class*="rounded-xl"]') as HTMLElement;
    expect(dragWrapper).toBeTruthy();

    // Use fireEvent.dragOver / dragLeave — they sidestep jsdom's missing DragEvent
    fireEvent.dragOver(dragWrapper);
    await waitFor(() => {
      expect(screen.getByText('Drop files here')).toBeInTheDocument();
    });

    fireEvent.dragLeave(dragWrapper);
    await waitFor(() => {
      expect(screen.queryByText('Drop files here')).toBeNull();
    });
  });

  it('price-limit edit for pending (no agent) saves new limit via onPendingPriceLimitChange', async () => {
    const onPendingPriceLimitChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <QueryInput
        {...defaultProps}
        pendingPriceLimitCents={100}
        onPendingPriceLimitChange={onPendingPriceLimitChange}
      />,
    );

    // Click chip to enter edit mode
    const chip = screen.getByText('0.00 / 1.00').closest('button')!;
    await clickNubItem(user, chip);

    const input = document.querySelector('input[placeholder="1.00"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    // Update value + press Enter to save
    await user.clear(input);
    await user.type(input, '3.25');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(onPendingPriceLimitChange).toHaveBeenCalledWith(325);
    });
  });

  it('price-limit input sanitizes to digits + one decimal only', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QueryInput {...defaultProps} pendingPriceLimitCents={100} />);
    const chip = screen.getByText('0.00 / 1.00').closest('button')!;
    await clickNubItem(user, chip);

    const input = document.querySelector('input[placeholder="1.00"]') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '1.2.3abc');
    // Should end up with only digits and one decimal point
    expect(input.value).toBe('1.23');
  });

  it('cost chip shows amber when tree cost is >= 80% of limit (root agent)', () => {
    const agent = makeAgentDetail({ tree_cost_cents: 85, price_limit_cents: 100 });
    renderWithProviders(<QueryInput {...defaultProps} agentDetail={agent} />);
    const btn = screen.getByText('0.85 / 1.00').closest('button')!;
    expect(btn).toHaveAttribute('data-warning', 'amber');
  });

  it('cost chip shows red when tree cost reaches/exceeds the limit (root agent)', () => {
    const agent = makeAgentDetail({ tree_cost_cents: 150, price_limit_cents: 100 });
    renderWithProviders(<QueryInput {...defaultProps} agentDetail={agent} />);
    const btn = screen.getByText('1.50 / 1.00').closest('button')!;
    expect(btn).toHaveAttribute('data-warning', 'red');
  });

  it('saving price limit for existing agent calls PATCH /api/agents/:id', async () => {
    let patched = false;
    let patchedBody: { price_limit_cents?: number } | null = null;
    server.use(
      http.patch(`${API_BASE}/agents/:agentId`, async ({ request }) => {
        patched = true;
        patchedBody = (await request.json()) as { price_limit_cents?: number };
        return HttpResponse.json({
          agent: { price_limit_cents: patchedBody.price_limit_cents },
        });
      }),
    );

    const agent = makeAgentDetail({ tree_cost_cents: 50, price_limit_cents: 500 });
    const onAgentUpdate = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <QueryInput {...defaultProps} agentDetail={agent} onAgentUpdate={onAgentUpdate} />,
    );

    const chip = screen.getByText('0.50 / 5.00').closest('button')!;
    await clickNubItem(user, chip);

    const input = document.querySelector('input[placeholder="1.00"]') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '8.00');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(patched).toBe(true));
    expect(patchedBody?.price_limit_cents).toBe(800);
  });

  it('rejects saving a limit below current tree cost', async () => {
    const agent = makeAgentDetail({ tree_cost_cents: 500, price_limit_cents: 1000 });
    const user = userEvent.setup();
    renderWithProviders(<QueryInput {...defaultProps} agentDetail={agent} />);

    const chip = screen.getByText('5.00 / 10.00').closest('button')!;
    await clickNubItem(user, chip);

    const input = document.querySelector('input[placeholder="1.00"]') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '1.00'); // Below tree cost of 5.00
    await user.keyboard('{Enter}');

    // Input is still showing (not saved)
    await waitFor(() => {
      const still = document.querySelector('input[placeholder="1.00"]') as HTMLInputElement;
      expect(still).not.toBeNull();
    });
  });

  it('rejects a NaN price-limit value', async () => {
    const onPendingPriceLimitChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <QueryInput
        {...defaultProps}
        pendingPriceLimitCents={100}
        onPendingPriceLimitChange={onPendingPriceLimitChange}
      />,
    );
    const chip = screen.getByText('0.00 / 1.00').closest('button')!;
    await clickNubItem(user, chip);

    const input = document.querySelector('input[placeholder="1.00"]') as HTMLInputElement;
    await user.clear(input); // empty -> NaN
    await user.keyboard('{Enter}');

    expect(onPendingPriceLimitChange).not.toHaveBeenCalled();
  });

  it('file input change processes file and adds attachment chip', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QueryInput {...defaultProps} />);

    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);

    await waitFor(() => {
      expect(screen.getByText('hello.txt')).toBeInTheDocument();
    });
    // Filesize chip shows "B" for small files
    expect(screen.getByText('5 B')).toBeInTheDocument();
  });

  it('rejects files over MAX_FILE_SIZE (>20MB)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QueryInput {...defaultProps} />);

    // Create a file bigger than 20MB (21MB)
    const big = new File(['x'.repeat(21 * 1024 * 1024)], 'big.bin', {
      type: 'application/octet-stream',
    });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, big);

    // No attachment chip should be added
    await waitFor(() => {
      expect(screen.queryByText('big.bin')).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AttentionInbox
// ═══════════════════════════════════════════════════════════════════════════

describe('AttentionInbox (blackbox)', () => {
  beforeEach(() => {
    mockSession();
  });

  afterEach(() => {
    localStorage.clear();
    resetTestUrl();
  });

  it('renders the bell button even with no requests', async () => {
    renderWithProviders(<AttentionInbox />);
    // Bell is the single button rendered inline
    const btn = screen.getByRole('button');
    expect(btn).toBeInTheDocument();
    // No badge when unansweredCount is 0
    expect(screen.queryByText(/^\d+$/)).toBeNull();
  });

  it('shows unanswered count badge when requests exist', async () => {
    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'req-1',
              agent_id: 'agent-1',
              workflow_id: 'wf-1',
              question: 'Do you approve?',
              image_url: null,
              metadata: null,
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
            {
              id: 'req-2',
              agent_id: 'agent-2',
              workflow_id: 'wf-2',
              question: 'Also do you approve?',
              image_url: null,
              metadata: null,
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
    );

    renderWithProviders(<AttentionInbox />);

    // Badge with "2" appears next to the bell
    await waitFor(() => {
      expect(screen.getByText('2')).toBeInTheDocument();
    });
  });

  it('opening the inbox with no requests renders the empty state', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox />);

    const bell = screen.getByRole('button');
    await user.click(bell);

    await waitFor(() => {
      expect(screen.getByText(/Congrats/)).toBeInTheDocument();
    });
    expect(screen.getByText(/All your agents are unblocked/i)).toBeInTheDocument();
  });

  it('opening the inbox shows the first unanswered request (Accept/Skip/Reject)', async () => {
    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'req-1',
              agent_id: 'agent-1',
              workflow_id: 'wf-1',
              question: 'Approve this purchase?',
              image_url: null,
              metadata: null,
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox />);

    // Wait for badge showing one request
    await waitFor(() => {
      expect(screen.getByText('1')).toBeInTheDocument();
    });

    const bell = screen.getAllByRole('button')[0];
    await user.click(bell);

    await waitFor(() => {
      expect(screen.getByText('Approve this purchase?')).toBeInTheDocument();
    });

    // Action buttons present
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('clicking Accept calls the respond endpoint', async () => {
    let respondCalled = false;

    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'req-42',
              agent_id: 'agent-42',
              workflow_id: 'wf-42',
              question: 'Ready?',
              image_url: null,
              metadata: null,
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
      http.post(`${API_BASE}/attention-requests/:id/respond`, () => {
        respondCalled = true;
        return HttpResponse.json({ success: true });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox />);

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('Ready?')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(respondCalled).toBe(true));
  });

  it('clicking Reject calls the reject endpoint', async () => {
    let rejectCalled = false;

    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'req-99',
              agent_id: 'agent-99',
              workflow_id: 'wf-99',
              question: 'Reject me',
              image_url: null,
              metadata: null,
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
      http.post(`${API_BASE}/attention-requests/:id/reject`, () => {
        rejectCalled = true;
        return HttpResponse.json({ success: true });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox />);

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('Reject me')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(rejectCalled).toBe(true));
  });

  it('clicking Skip calls the skip endpoint', async () => {
    let skipCalled = false;

    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'req-9',
              agent_id: 'agent-9',
              workflow_id: 'wf-9',
              question: 'Skip me',
              image_url: null,
              metadata: null,
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
      http.post(`${API_BASE}/attention-requests/:id/skip`, () => {
        skipCalled = true;
        return HttpResponse.json({ success: true });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox />);

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('Skip me')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(skipCalled).toBe(true));
  });

  it('shows the image thumbnail when image_url is present', async () => {
    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'req-img',
              agent_id: 'agent-img',
              workflow_id: 'wf-img',
              question: 'Has image',
              image_url: 'https://example.com/cat.png',
              metadata: null,
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox />);

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button')[0]);

    await waitFor(() => {
      const img = document.querySelector('img[src="https://example.com/cat.png"]');
      expect(img).toBeTruthy();
    });
  });

  it('shows the iMessage block when metadata.onSuccess is sendSmsThroughIMessage', async () => {
    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'req-sms',
              agent_id: 'agent-sms',
              workflow_id: 'wf-sms',
              question: 'Send to Bob?',
              image_url: null,
              metadata: {
                onSuccess: 'sendSmsThroughIMessage',
                to: '+15555551234',
                message: 'Hi Bob',
              },
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox />);

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button')[0]);

    await waitFor(() => {
      expect(screen.getByText('Send via iMessage on your Mac')).toBeInTheDocument();
    });
    expect(screen.getByText(/\+15555551234/)).toBeInTheDocument();
    expect(screen.getByText(/Hi Bob/)).toBeInTheDocument();
    // Button reads the no-bridge label
    expect(screen.getByText(/Open Mac app to send/)).toBeInTheDocument();
  });

  it('renders auth assistance as a live-browser completion request', async () => {
    const selectedAgent = vi.fn();
    const liveViewUrl = 'https://debug.steel.dev/session/auth-1?interactive=true&showControls=true';

    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'auth-req-1',
              agent_id: 'agent-auth',
              workflow_id: 'wf-auth',
              question: 'Sign in to amazon.com',
              image_url: null,
              metadata: {
                attentionKind: 'auth_assistance',
                authAssistance: {
                  requestId: 'auth-req-1',
                  authRealm: 'amazon.com',
                  mode: 'live_view',
                  steelSessionId: 'steel-session-1',
                  browserSessionId: 'task-auth',
                  liveViewUrl,
                },
              },
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
      http.post(`${API_BASE}/auth-assistance/:id/refresh-session`, ({ params }) =>
        HttpResponse.json({
          request: { id: String(params.id), steelSessionId: 'steel-refreshed' },
          handoff: { type: 'live_view', steelSessionId: 'steel-refreshed', liveViewUrl },
          liveViewUrl,
          refreshed: false,
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox onSelectAgent={selectedAgent} />);

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button')[0]);

    await waitFor(() => {
      expect(screen.getByText('Authentication')).toBeInTheDocument();
    });
    expect(screen.getByText('amazon.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Authentication Complete' })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Open Live Browser/i }));

    expect(selectedAgent).toHaveBeenCalledWith('agent-auth');
    expect(new URL(window.location.href).searchParams.get('agent-id')).toBe('agent-auth');
    expect(new URL(window.location.href).searchParams.get('browser-id')).toBe('task-auth');
  });

  it('clicking "Send via iMessage" with a bridge calls window.api.sendIMessage + respond endpoint', async () => {
    let respondCalled = false;
    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'req-sms-bridge',
              agent_id: 'agent-sms',
              workflow_id: 'wf-sms',
              question: 'Send to Bob?',
              image_url: null,
              metadata: {
                onSuccess: 'sendSmsThroughIMessage',
                to: '+15555551234',
                message: 'Hello from bridge',
              },
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
      http.post(`${API_BASE}/attention-requests/:id/respond`, () => {
        respondCalled = true;
        return HttpResponse.json({ success: true });
      }),
    );

    // Stub the Mac-app bridge
    const sendIMessage = vi.fn(async () => ({ success: true }));
    const bridgeWindow = window as unknown as {
      api?: { sendIMessage: typeof sendIMessage };
    };
    bridgeWindow.api = { sendIMessage };

    try {
      const user = userEvent.setup();
      renderWithProviders(<AttentionInbox />);

      await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
      await user.click(screen.getAllByRole('button')[0]);

      await waitFor(() => {
        expect(screen.getByText('Send via iMessage')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: 'Send via iMessage' }));

      await waitFor(() => expect(sendIMessage).toHaveBeenCalled());
      expect(sendIMessage).toHaveBeenCalledWith({
        to: '+15555551234',
        message: 'Hello from bridge',
      });
      await waitFor(() => expect(respondCalled).toBe(true));
    } finally {
      delete bridgeWindow.api;
    }
  });

  it('Cmd+Enter keyboard shortcut submits the first unanswered request', async () => {
    let respondCalled = false;
    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'req-kbd',
              agent_id: 'agent-kbd',
              workflow_id: 'wf-kbd',
              question: 'via keyboard?',
              image_url: null,
              metadata: null,
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
      http.post(`${API_BASE}/attention-requests/:id/respond`, () => {
        respondCalled = true;
        return HttpResponse.json({ success: true });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox />);

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('via keyboard?')).toBeInTheDocument());

    // Dispatch Cmd+Enter — the component listens on window
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
      );
    });

    await waitFor(() => expect(respondCalled).toBe(true));
  });

  it('Cmd+S keyboard shortcut skips the first unanswered request', async () => {
    let skipCalled = false;
    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'req-kbd-skip',
              agent_id: 'agent-kbd',
              workflow_id: 'wf-kbd',
              question: 'skip me?',
              image_url: null,
              metadata: null,
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
      http.post(`${API_BASE}/attention-requests/:id/skip`, () => {
        skipCalled = true;
        return HttpResponse.json({ success: true });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox />);

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('skip me?')).toBeInTheDocument());

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }),
      );
    });

    await waitFor(() => expect(skipCalled).toBe(true));
  });

  it('Cmd+S keyboard shortcut does not skip auth assistance requests', async () => {
    let skipCalled = false;
    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'req-kbd-auth',
              agent_id: 'agent-auth',
              workflow_id: 'wf-auth',
              question: 'Sign in to amazon.com',
              image_url: null,
              metadata: {
                attentionKind: 'auth_assistance',
                authAssistance: {
                  requestId: 'req-kbd-auth',
                  authRealm: 'amazon.com',
                  mode: 'live_view',
                  steelSessionId: 'steel-session-1',
                  liveViewUrl: 'https://debug.steel.dev/session/auth?interactive=true',
                },
              },
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
      http.post(`${API_BASE}/attention-requests/:id/skip`, () => {
        skipCalled = true;
        return HttpResponse.json({ success: true });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox />);

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('Authentication')).toBeInTheDocument());

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }),
      );
    });

    expect(skipCalled).toBe(false);
  });

  it('typing in the textarea updates the response input', async () => {
    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'req-text',
              agent_id: 'agent-text',
              workflow_id: 'wf-text',
              question: 'add context?',
              image_url: null,
              metadata: null,
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox />);

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('add context?')).toBeInTheDocument());

    const textarea = screen.getByPlaceholderText(
      'Add context (optional)...',
    ) as HTMLTextAreaElement;
    await user.type(textarea, 'yes please');
    expect(textarea.value).toBe('yes please');
  });

  it('clicking "View agent" calls onSelectAgent and closes inbox', async () => {
    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'req-view',
              agent_id: 'agent-xyz',
              workflow_id: 'wf-view',
              question: 'View?',
              image_url: null,
              metadata: null,
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
    );

    const onSelectAgent = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox onSelectAgent={onSelectAgent} />);

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(screen.getByText('View?')).toBeInTheDocument());

    await user.click(screen.getByText('View agent →'));
    expect(onSelectAgent).toHaveBeenCalledWith('agent-xyz');
    // Clicking "View agent →" must also dismiss the inbox popover — the question
    // text ("View?") should no longer be visible once the inbox closes.
    await waitFor(() => {
      expect(screen.queryByText('View?')).toBeNull();
    });
  });

  it('shows "N more requests waiting" indicator when multiple unanswered', async () => {
    server.use(
      http.get(`${API_BASE}/attention-requests`, () =>
        HttpResponse.json({
          requests: [
            {
              id: 'req-a',
              agent_id: 'a',
              workflow_id: 'wf',
              question: 'first',
              image_url: null,
              metadata: null,
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
            {
              id: 'req-b',
              agent_id: 'b',
              workflow_id: 'wf',
              question: 'second',
              image_url: null,
              metadata: null,
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
            {
              id: 'req-c',
              agent_id: 'c',
              workflow_id: 'wf',
              question: 'third',
              image_url: null,
              metadata: null,
              user_response: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              answered: false,
            },
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox />);

    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
    await user.click(screen.getAllByRole('button')[0]);

    await waitFor(() => {
      expect(screen.getByText(/2 more requests waiting/)).toBeInTheDocument();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BrowserStatusBar
// ═══════════════════════════════════════════════════════════════════════════

describe('BrowserStatusBar (blackbox)', () => {
  beforeEach(() => {
    mockSession();
  });

  afterEach(() => {
    localStorage.clear();
    resetTestUrl();
  });

  it('renders minimized with default title when no messages', () => {
    renderWithProviders(
      withAgentCtx([], <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />),
    );
    expect(screen.getByText('Browser session active')).toBeInTheDocument();
  });

  it('shows lastActionTitle from the most recent browser message', () => {
    const messages: Message[] = [
      {
        message_id: 'm1',
        timestamp: '2026-01-01T00:00:00Z',
        text: '',
        role: 'TOOL',
        metadata: { task_id: 'task-9', action_type: 'click', title: 'Clicked submit' },
      },
    ];
    renderWithProviders(
      withAgentCtx(messages, <BrowserStatusBar taskId="task-9" browserUrl="about:blank" />),
    );
    expect(screen.getByText('Clicked submit')).toBeInTheDocument();
  });

  it('shows browser proxy location metadata on the location chip tooltip', async () => {
    const messages: Message[] = [
      {
        message_id: 'm1',
        timestamp: '2026-01-01T00:00:00Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-proxy',
          action_type: 'session_started',
          title: 'Browser ready',
          browser_session_metadata: {
            provider: 'steel',
            proxy_source: 'steel',
            proxy_location: { city: 'DALLAS', state: 'TX', country: 'US' },
          },
        },
      },
    ];

    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx(messages, <BrowserStatusBar taskId="task-proxy" browserUrl="about:blank" />),
    );

    await user.hover(screen.getByLabelText('Browser proxy location'));

    await waitFor(() => {
      expect(screen.getAllByText('Proxy: Steel').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Location: DALLAS, TX, US').length).toBeGreaterThan(0);
    });
  });

  it('shows "Disconnected" state when a session_paused message is present (expanded view)', async () => {
    const messages: Message[] = [
      {
        message_id: 'm1',
        timestamp: '2026-01-01T00:00:00Z',
        text: '',
        role: 'TOOL',
        metadata: { task_id: 'task-x', action_type: 'session_paused', title: 'Paused' },
      },
    ];

    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx(messages, <BrowserStatusBar taskId="task-x" browserUrl="about:blank" />),
    );

    // Click the outer minimized container to expand
    const title = screen.getByText('Paused');
    await user.click(title);

    await waitFor(() => {
      expect(screen.getByText('Disconnected')).toBeInTheDocument();
    });
  });

  it('expand click reveals Task progress panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx([], <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />),
    );

    // Click the minimized bar to expand
    await user.click(screen.getByText('Browser session active'));

    await waitFor(() => {
      expect(screen.getByText(/Task progress/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Agent's Browser")).toBeInTheDocument();
  });

  it('step progress bar renders when steps_taken/total_steps metadata is present', async () => {
    const messages: Message[] = [
      {
        message_id: 'm1',
        timestamp: '2026-01-01T00:00:00Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-1',
          action_type: 'click',
          title: 'step msg',
          steps_taken: 3,
          total_steps: 10,
        },
      },
    ];

    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx(messages, <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />),
    );

    // Must expand to see the Task progress block
    await user.click(screen.getByText('step msg'));
    await waitFor(() => {
      expect(screen.getByText(/Steps Taken 3\/10/)).toBeInTheDocument();
    });
  });

  it('forceMinimized prop keeps the bar minimized and non-clickable', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx(
        [],
        <BrowserStatusBar taskId="task-1" browserUrl="about:blank" forceMinimized />,
      ),
    );
    await user.click(screen.getByText('Browser session active'));
    // Task progress should NOT show — still minimized
    expect(screen.queryByText(/Task progress/i)).toBeNull();
  });

  it('renders BrowserWriteLockApproval when pending approval message exists (fullscreen)', async () => {
    const messages: Message[] = [
      {
        message_id: 'approval-1',
        timestamp: '2026-01-01T00:00:00Z',
        text: 'Approve my write?',
        role: 'TOOL',
        metadata: {
          task_id: 'task-1',
          action_type: 'click',
          title: 'doing stuff',
          toolStatus: 'IN_PROGRESS',
          requestUserApproval: {
            writePermission: true,
            attentionRequestId: 'attention-1',
          },
        },
      },
    ];
    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx(messages, <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />),
    );

    // Expand first
    await user.click(screen.getByText('doing stuff'));

    // Click Maximize button to go fullscreen
    await waitFor(() => {
      expect(screen.getByText("Agent's Browser")).toBeInTheDocument();
    });
    // Fullscreen toggle button has the Maximize2 icon — find by looking for the Maximize2 title
    // Trigger fullscreen by clicking thumbnail which is an iframe container
    // The expanded header has a "Maximize2" button; find all buttons and click the 2nd to last
    // before the Collapse (ChevronDown) button.
    const expandedHeader = screen.getByText("Agent's Browser").closest('div')!.parentElement!;
    const buttons = within(expandedHeader).getAllByRole('button');
    // There are 2 buttons in the controls cluster: Maximize then Collapse
    await user.click(buttons[buttons.length - 2]);

    await waitFor(() => {
      expect(screen.getByText('Approval Required')).toBeInTheDocument();
    });
    expect(screen.getByText('Approve my write?')).toBeInTheDocument();
  });

  it('uses auth liveViewUrl for the fullscreen browser iframe while auth assistance is pending', async () => {
    let completedRequestId: string | null = null;
    const resizedViewports: Array<{ taskId: string; width: number; height: number }> = [];
    let emitResize: ((width: number, height: number) => void) | null = null;
    let releaseFirstResize: (() => void) | null = null;
    const originalResizeObserver = window.ResizeObserver;
    class ImmediateResizeObserver {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe(target: Element) {
        emitResize = (width, height) => {
          this.callback(
            [
              {
                target,
                contentRect: { width, height } as DOMRectReadOnly,
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        };
        emitResize(1180, 720);
      }

      unobserve() {}
      disconnect() {}
    }
    window.ResizeObserver = ImmediateResizeObserver as unknown as typeof ResizeObserver;
    server.use(
      http.post(`${API_BASE}/auth-assistance/:id/complete`, ({ params }) => {
        completedRequestId = String(params.id);
        return HttpResponse.json({ success: true });
      }),
      http.post(`${API_BASE}/auth-assistance/:id/refresh-session`, ({ params }) =>
        HttpResponse.json({
          request: { id: String(params.id), steelSessionId: 'steel-refreshed' },
          handoff: { type: 'live_view', steelSessionId: 'steel-refreshed', liveViewUrl },
          liveViewUrl,
          refreshed: false,
        }),
      ),
      http.post(
        `${API_BASE}/browser-session/task/:taskId/viewport`,
        async ({ params, request }) => {
          const body = (await request.json()) as { width: number; height: number };
          resizedViewports.push({ taskId: String(params.taskId), ...body });
          if (resizedViewports.length === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstResize = resolve;
            });
          }
          return HttpResponse.json({ success: true, resized: true, viewport: body });
        },
      ),
    );

    const liveViewUrl =
      'https://debug.steel.dev/session/auth-live?interactive=true&showControls=true';
    const messages: Message[] = [
      {
        message_id: 'auth-assist-1',
        timestamp: '2026-01-01T00:00:00Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-auth',
          action_type: 'auth_assistance',
          title: 'Requesting User Assistance for amazon.com Login',
          toolStatus: 'IN_PROGRESS',
          requestUserAuthentication: {
            requestId: 'auth-req-1',
            authRealm: 'amazon.com',
            taskId: 'task-auth',
            liveViewUrl,
          },
        },
      },
    ];

    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx(
        messages,
        <BrowserStatusBar taskId="task-auth" browserUrl="https://debug.steel.dev/session/base" />,
      ),
    );

    await user.click(screen.getByText('Requesting User Assistance for amazon.com Login'));
    await waitFor(() => expect(screen.getByText("Agent's Browser")).toBeInTheDocument());
    expect(screen.getByText('Agent waiting for assistance')).toBeInTheDocument();
    const header = screen.getByText("Agent's Browser").closest('div')!.parentElement!;
    const hdrButtons = within(header).getAllByRole('button');
    await user.click(hdrButtons[hdrButtons.length - 2]);

    await waitFor(() => {
      const iframe = document.querySelector('iframe[title="Browser"]') as HTMLIFrameElement | null;
      expect(iframe?.src).toBe(liveViewUrl);
    });
    expect(screen.getByText('Sign in to amazon.com so I can continue')).toBeInTheDocument();
    expect(screen.getByText('Agent waiting for assistance')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Agent' })).toBeInTheDocument();
    expect(screen.queryByText('Agent in progress')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take control' })).toBeNull();
    expect(screen.queryByTestId('thinking-animation')).toBeNull();
    expect(screen.queryByTestId('browser-border-glow')).toBeNull();
    expect(screen.queryByTestId('browser-cursor-overlay')).toBeNull();
    expect(resizedViewports).toEqual([]);
    const livePane = document.querySelector('[data-testid="live-view-pane"]');
    expect(livePane).toHaveClass('overflow-hidden');
    await act(async () => {
      emitResize?.(1280, 760);
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    });
    releaseFirstResize?.();
    expect(resizedViewports).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Start Agent' }));
    await waitFor(() => expect(completedRequestId).toBe('auth-req-1'));
    window.ResizeObserver = originalResizeObserver;
  });

  it('clicking Accept in fullscreen BrowserWriteLockApproval calls respond endpoint', async () => {
    let respondCalled = false;
    server.use(
      http.post(`${API_BASE}/attention-requests/:id/respond`, () => {
        respondCalled = true;
        return HttpResponse.json({ success: true });
      }),
    );

    const messages: Message[] = [
      {
        message_id: 'approval-accept',
        timestamp: '2026-01-01T00:00:00Z',
        text: 'Can I write?',
        role: 'TOOL',
        metadata: {
          task_id: 'task-1',
          action_type: 'click',
          title: 'writing',
          toolStatus: 'IN_PROGRESS',
          requestUserApproval: {
            writePermission: true,
            attentionRequestId: 'ar-bar-accept',
          },
        },
      },
    ];

    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx(messages, <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />),
    );

    // Expand -> go fullscreen
    await user.click(screen.getByText('writing'));
    await waitFor(() => expect(screen.getByText("Agent's Browser")).toBeInTheDocument());
    const header = screen.getByText("Agent's Browser").closest('div')!.parentElement!;
    const hdrButtons = within(header).getAllByRole('button');
    await user.click(hdrButtons[hdrButtons.length - 2]);

    await waitFor(() => expect(screen.getByText('Approval Required')).toBeInTheDocument());

    // Optional: type context
    const ctx = screen.getByPlaceholderText('Add context (optional)...');
    await user.type(ctx, 'looks good');

    // Click the Accept button
    await user.click(screen.getByRole('button', { name: /Accept/i }));
    await waitFor(() => expect(respondCalled).toBe(true));
  });

  it('clicking Reject in fullscreen BrowserWriteLockApproval calls reject endpoint', async () => {
    let rejectCalled = false;
    server.use(
      http.post(`${API_BASE}/attention-requests/:id/reject`, () => {
        rejectCalled = true;
        return HttpResponse.json({ success: true });
      }),
    );

    const messages: Message[] = [
      {
        message_id: 'approval-reject',
        timestamp: '2026-01-01T00:00:00Z',
        text: 'Can I write?',
        role: 'TOOL',
        metadata: {
          task_id: 'task-1',
          action_type: 'click',
          title: 'writing',
          toolStatus: 'IN_PROGRESS',
          requestUserApproval: {
            writePermission: true,
            attentionRequestId: 'ar-bar-reject',
          },
        },
      },
    ];

    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx(messages, <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />),
    );

    await user.click(screen.getByText('writing'));
    await waitFor(() => expect(screen.getByText("Agent's Browser")).toBeInTheDocument());
    const header = screen.getByText("Agent's Browser").closest('div')!.parentElement!;
    const hdrButtons = within(header).getAllByRole('button');
    await user.click(hdrButtons[hdrButtons.length - 2]);

    await waitFor(() => expect(screen.getByText('Approval Required')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Reject/i }));
    await waitFor(() => expect(rejectCalled).toBe(true));
  });

  it('clicking "Take control" on a live browser enables interaction and can hand control back', async () => {
    let resumeCalled = false;
    let agentResumeCalls = 0;
    const controlModes: string[] = [];
    let controlStateReads = 0;
    let controlRequested = false;
    server.use(
      http.post(`${API_BASE}/agents/:agentId/resume`, () => {
        agentResumeCalls += 1;
        return HttpResponse.json({ success: true });
      }),
      http.post(`${API_BASE}/browser-session/resume`, async ({ request }) => {
        resumeCalled = true;
        const body = (await request.json()) as { task_id?: string };
        expect(body.task_id).toBe('task-1');
        return HttpResponse.json({ success: true, debug_url: 'https://unexpected.example' });
      }),
      http.post(`${API_BASE}/browser-session/task/task-1/control`, async ({ request }) => {
        const body = (await request.json()) as { mode?: string };
        controlModes.push(body.mode ?? '');
        controlRequested = body.mode === 'user';
        return HttpResponse.json({
          state: controlRequested ? 'user' : 'agent',
          agentPaused: false,
        });
      }),
      http.get(`${API_BASE}/browser-session/task/task-1/control`, () => {
        controlStateReads += 1;
        return HttpResponse.json({
          state: controlRequested ? 'user' : 'agent',
          agentPaused: false,
        });
      }),
    );

    const messages: Message[] = [
      {
        message_id: 'm-taketaketake',
        timestamp: '2026-01-01T00:00:00Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-1',
          action_type: 'click',
          title: 'Clicking around',
        },
      },
    ];

    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx(messages, <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />),
    );

    // Expand -> open in the Browser drawer
    await user.click(screen.getByText('Clicking around'));
    await waitFor(() => expect(screen.getByText("Agent's Browser")).toBeInTheDocument());
    const header = screen.getByText("Agent's Browser").closest('div')!.parentElement!;
    const hdrButtons = within(header).getAllByRole('button');
    await user.click(hdrButtons[hdrButtons.length - 2]);

    // In the Browser drawer + not disconnected: "Take control" chip is visible
    // on the agent's live view (the fullscreen portal no longer exists).
    const drawer = screen.getByTestId('browser-app-drawer');
    await waitFor(() => expect(within(drawer).getByText('Take control')).toBeInTheDocument());
    await user.click(within(drawer).getByText('Take control'));
    expect(resumeCalled).toBe(false);
    expect(
      await within(drawer).findByRole('button', { name: 'Hand back control' }),
    ).toBeInTheDocument();
    expect(controlModes).toEqual(['user']);
    expect(controlStateReads).toBeLessThanOrEqual(1);
    expect(screen.getByTitle('Browser')).toHaveAttribute(
      'src',
      expect.stringContaining('interactive=true'),
    );

    await user.click(screen.getByRole('button', { name: 'Hand back control' }));
    expect(await screen.findByRole('button', { name: 'Take control' })).toBeInTheDocument();
    expect(controlModes).toEqual(['user', 'agent']);
    expect(agentResumeCalls).toBe(0);
    expect(screen.getByTitle('Browser')).toHaveAttribute('src', 'about:blank');
  });

  it('keeps user control after the live browser URL updates from agent navigation', async () => {
    server.use(
      http.post(`${API_BASE}/browser-session/task/task-nav/control`, async ({ request }) => {
        const body = (await request.json()) as { mode?: string };
        return HttpResponse.json({
          state: body.mode === 'user' ? 'user' : 'agent',
          agentPaused: false,
        });
      }),
      http.get(`${API_BASE}/browser-session/task/task-nav/control`, () =>
        HttpResponse.json({ state: 'agent', agentPaused: false }),
      ),
    );

    const initialMessages: Message[] = [
      {
        message_id: 'm-nav-1',
        timestamp: '2026-01-01T00:00:00Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-nav',
          action_type: 'click',
          title: 'Opening checkout',
          browser_url: 'https://kernel.example/session?v=1',
        },
      },
    ];
    const navigatedMessages: Message[] = [
      ...initialMessages,
      {
        message_id: 'm-nav-2',
        timestamp: '2026-01-01T00:00:10Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-nav',
          action_type: 'navigate',
          title: 'Moved to cart',
          browser_url: 'https://kernel.example/session?v=2',
        },
      },
    ];

    const user = userEvent.setup();
    const { rerender } = renderWithProviders(
      withAgentCtx(
        initialMessages,
        <BrowserStatusBar taskId="task-nav" browserUrl="https://kernel.example/session?v=1" />,
      ),
    );

    await user.click(screen.getByText('Opening checkout'));
    await waitFor(() => expect(screen.getByText("Agent's Browser")).toBeInTheDocument());
    const header = screen.getByText("Agent's Browser").closest('div')!.parentElement!;
    const hdrButtons = within(header).getAllByRole('button');
    await user.click(hdrButtons[hdrButtons.length - 2]);

    await user.click(await screen.findByRole('button', { name: 'Take control' }));
    expect(await screen.findByRole('button', { name: 'Hand back control' })).toBeInTheDocument();

    rerender(
      withAgentCtx(
        navigatedMessages,
        <BrowserStatusBar taskId="task-nav" browserUrl="https://kernel.example/session?v=2" />,
      ),
    );

    expect(await screen.findByRole('button', { name: 'Hand back control' })).toBeInTheDocument();
    expect(screen.getByTitle('Browser')).toHaveAttribute(
      'src',
      expect.stringContaining('interactive=true'),
    );
  });

  it('browser status chip carousel can take control from fullscreen after navigation updates the live URL', async () => {
    server.use(
      http.post(`${API_BASE}/browser-session/task/task-chip/control`, async ({ request }) => {
        const body = (await request.json()) as { mode?: string };
        return HttpResponse.json({
          state: body.mode === 'user' ? 'user' : 'agent',
          agentPaused: false,
        });
      }),
      http.get(`${API_BASE}/browser-session/task/task-chip/control`, () =>
        HttpResponse.json({ state: 'agent', agentPaused: false }),
      ),
    );

    const initialMessages: Message[] = [
      {
        message_id: 'm-chip-1',
        timestamp: '2026-01-01T00:00:00Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-chip',
          action_type: 'session_started',
          title: 'Browser ready',
          browser_url: 'https://kernel.example/session?step=1',
        },
      },
    ];
    const navigatedMessages: Message[] = [
      ...initialMessages,
      {
        message_id: 'm-chip-2',
        timestamp: '2026-01-01T00:00:05Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-chip',
          action_type: 'click',
          title: 'Clicked add to cart',
          browser_url: 'https://kernel.example/session?step=2',
        },
      },
    ];

    const user = userEvent.setup();
    const { rerender } = renderWithProviders(
      withAgentCtx(
        initialMessages,
        <BrowserStatusBarCarousel
          browsers={[{ taskId: 'task-chip', browserUrl: 'https://kernel.example/session?step=1' }]}
        />,
      ),
    );

    expect(screen.getByTestId('browser-status-chip')).toBeInTheDocument();
    await user.click(screen.getByText('Browser ready'));
    await waitFor(() => expect(screen.getByText("Agent's Browser")).toBeInTheDocument());
    const header = screen.getByText("Agent's Browser").closest('div')!.parentElement!;
    const hdrButtons = within(header).getAllByRole('button');
    await user.click(hdrButtons[hdrButtons.length - 2]);

    await user.click(await screen.findByRole('button', { name: 'Take control' }));
    expect(await screen.findByRole('button', { name: 'Hand back control' })).toBeInTheDocument();

    rerender(
      withAgentCtx(
        navigatedMessages,
        <BrowserStatusBarCarousel
          browsers={[{ taskId: 'task-chip', browserUrl: 'https://kernel.example/session?step=2' }]}
        />,
      ),
    );

    expect(await screen.findByRole('button', { name: 'Hand back control' })).toBeInTheDocument();
    expect(screen.getByTitle('Browser')).toHaveAttribute(
      'src',
      expect.stringContaining('interactive=true'),
    );
  });

  it('takes control of the second carousel browser on the same live URL without resume', async () => {
    const firstUrl = 'https://connect.steel.dev/v1/sessions/first/player?interactive=false';
    const secondUrl = 'https://connect.steel.dev/v1/sessions/second/player?interactive=false';
    const controlPosts: string[] = [];
    let resumeCalled = false;
    server.use(
      http.post(`${API_BASE}/browser-session/resume`, () => {
        resumeCalled = true;
        return HttpResponse.json({ success: true, debug_url: 'https://unexpected.example' });
      }),
      http.post(`${API_BASE}/browser-session/task/:taskId/control`, async ({ params, request }) => {
        const body = (await request.json()) as { mode?: string };
        controlPosts.push(`${params.taskId}:${body.mode ?? ''}`);
        return HttpResponse.json({
          state: body.mode === 'user' ? 'user' : 'agent',
          agentPaused: false,
          debugUrl: params.taskId === 'task-second' ? secondUrl : firstUrl,
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx(
        [
          {
            message_id: 'm-first',
            timestamp: '2026-01-01T00:00:00Z',
            text: '',
            role: 'TOOL',
            metadata: {
              task_id: 'task-first',
              toolName: 'spawn_browser_agent',
              action_type: 'session_started',
              title: 'First browser',
              browser_url: firstUrl,
            },
          },
          {
            message_id: 'm-second',
            timestamp: '2026-01-01T00:00:05Z',
            text: '',
            role: 'TOOL',
            metadata: {
              task_id: 'task-second',
              toolName: 'spawn_browser_agent',
              action_type: 'session_started',
              title: 'Second browser',
              browser_url: secondUrl,
            },
          },
        ],
        <BrowserStatusBarCarousel
          browsers={[
            { taskId: 'task-first', browserUrl: firstUrl },
            { taskId: 'task-second', browserUrl: secondUrl },
          ]}
        />,
      ),
    );

    await user.click(screen.getByLabelText('Next browser'));
    await user.click(screen.getByText('Second browser'));
    await waitFor(() => expect(screen.getByText("Agent's Browser")).toBeInTheDocument());
    const header = screen.getByText("Agent's Browser").closest('div')!.parentElement!;
    const hdrButtons = within(header).getAllByRole('button');
    await user.click(hdrButtons[hdrButtons.length - 2]);

    await user.click(await screen.findByRole('button', { name: 'Take control' }));
    expect(await screen.findByRole('button', { name: 'Hand back control' })).toBeInTheDocument();
    expect(resumeCalled).toBe(false);
    expect(controlPosts).toEqual(['task-second:user']);
    expect(screen.getByTitle('Browser')).toHaveAttribute(
      'src',
      expect.stringContaining('sessions/second'),
    );
    expect(screen.getByTitle('Browser')).toHaveAttribute(
      'src',
      expect.stringContaining('interactive=true'),
    );
  });

  it('restores hand-back control after the frontend reloads during a leased handoff', async () => {
    let agentResumeCalls = 0;
    server.use(
      http.get(`${API_BASE}/browser-session/task/task-1/control`, () =>
        HttpResponse.json({
          state: 'user',
          agentPaused: true,
          debugUrl: 'https://steel.example/replacement-live',
        }),
      ),
      // Same BrowserSession row as /control: the live view binds to it too.
      http.get(`${API_BASE}/browser-session/task/task-1/live-view`, () =>
        HttpResponse.json({
          taskId: 'task-1',
          sessionId: 'replacement',
          debugUrl: 'https://steel.example/replacement-live',
          status: 'ACTIVE',
          live: true,
          asOf: 1,
        }),
      ),
      http.post(`${API_BASE}/agents/agent-reload-control/resume`, () => {
        agentResumeCalls += 1;
        return HttpResponse.json({ success: true });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx(
        [
          {
            message_id: 'reload-control',
            timestamp: '2026-01-01T00:00:00Z',
            text: '',
            role: 'TOOL',
            metadata: { task_id: 'task-1', action_type: 'session_paused', title: 'Paused' },
          },
        ],
        <BrowserStatusBar taskId="task-1" browserUrl="https://kernel.example/dead-live" />,
        'agent-reload-control',
      ),
    );

    await user.click(screen.getByText('Paused'));
    const header = await screen.findByText("Agent's Browser");
    const buttons = within(header.closest('div')!.parentElement!).getAllByRole('button');
    await user.click(buttons[buttons.length - 2]);

    expect(await screen.findByRole('button', { name: 'Hand back control' })).toBeInTheDocument();
    expect(screen.getByTitle('Browser')).toHaveAttribute(
      'src',
      expect.stringContaining('steel.example/replacement-live'),
    );
    await user.click(screen.getByRole('button', { name: 'Hand back control' }));
    await waitFor(() => expect(agentResumeCalls).toBe(1));
    expect(await screen.findByRole('button', { name: 'Take control' })).toBeInTheDocument();
  });

  it('fullscreen with disconnected session shows the reconnect Take Control overlay', async () => {
    const messages: Message[] = [
      {
        message_id: 'm-disc',
        timestamp: '2026-01-01T00:00:00Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-1',
          action_type: 'session_paused',
          title: 'Paused',
        },
      },
    ];

    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx(messages, <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />),
    );

    // Expand -> open in the Browser drawer
    await user.click(screen.getByText('Paused'));
    await waitFor(() => expect(screen.getByText("Agent's Browser")).toBeInTheDocument());
    const header = screen.getByText("Agent's Browser").closest('div')!.parentElement!;
    const hdrButtons = within(header).getAllByRole('button');
    await user.click(hdrButtons[hdrButtons.length - 2]);

    // Disconnected sessions expose the reconnect overlay, not an active-session control.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Take Control$/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /^Take control$/ })).toBeNull();
    expect(screen.getByText('Take Control')).toBeInTheDocument();
  });

  it('automatically reconnects the iframe when a replacement session arrives', async () => {
    const paused: Message = {
      message_id: 'paused-old-session',
      timestamp: '2026-01-01T00:00:00Z',
      text: '',
      role: 'TOOL',
      metadata: {
        task_id: 'task-1',
        action_type: 'session_paused',
        title: 'Paused',
      },
    };
    const user = userEvent.setup();
    const view = renderWithProviders(
      withAgentCtx(
        [paused],
        <BrowserStatusBar
          taskId="task-1"
          browserUrl="https://kernel.example/live/old?readOnly=true"
        />,
      ),
    );

    await user.click(screen.getByText('Paused'));
    const header = await screen.findByText("Agent's Browser");
    const hdrButtons = within(header.closest('div')!.parentElement!).getAllByRole('button');
    await user.click(hdrButtons[hdrButtons.length - 2]);
    const oldIframe = await screen.findByTitle('Browser');
    expect(screen.getByRole('button', { name: /^Take Control$/ })).toBeInTheDocument();

    const replacement: Message = {
      message_id: 'replacement-session',
      timestamp: '2026-01-01T00:00:01Z',
      text: '',
      role: 'TOOL',
      metadata: {
        task_id: 'task-1',
        action_type: 'browser',
        title: 'Browser provider switched',
        browser_url: 'https://steel.example/live/new?interactive=false',
      },
    };
    view.rerender(
      withAgentCtx(
        // Realtime and hydration can merge out of array order; timestamps are
        // authoritative for the current session lifecycle.
        [replacement, paused],
        <BrowserStatusBar
          taskId="task-1"
          browserUrl="https://steel.example/live/new?interactive=false"
        />,
      ),
    );

    const newIframe = await screen.findByTitle('Browser');
    expect(newIframe).not.toBe(oldIframe);
    expect(newIframe).toHaveAttribute('src', 'https://steel.example/live/new?interactive=false');
    expect(screen.getByRole('button', { name: /^Take control$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Take Control$/ })).toBeNull();
  });

  it('resumes a disconnected fullscreen session instead of completing stale auth assistance', async () => {
    let resumeCalls = 0;
    let agentResumeCalls = 0;
    let authCompletionCalls = 0;
    server.use(
      http.post(`${API_BASE}/browser-session/resume`, () => {
        resumeCalls += 1;
        return HttpResponse.json({ success: true, debug_url: 'https://kernel.example/resumed' });
      }),
      // Resume rebinds the task's row; the live view reads that binding.
      http.get(`${API_BASE}/browser-session/task/task-1/live-view`, () =>
        resumeCalls === 0
          ? HttpResponse.json({ error: 'Session not found' }, { status: 404 })
          : HttpResponse.json({
              taskId: 'task-1',
              sessionId: 'resumed',
              debugUrl: 'https://kernel.example/resumed',
              status: 'ACTIVE',
              live: true,
              asOf: 1,
            }),
      ),
      http.post(`${API_BASE}/browser-session/task/task-1/control`, async ({ request }) => {
        const body = (await request.json()) as { mode?: string };
        return HttpResponse.json({ state: body.mode === 'user' ? 'user' : 'agent' });
      }),
      http.post(`${API_BASE}/agents/agent-control-test/resume`, () => {
        agentResumeCalls += 1;
        return HttpResponse.json({ success: true });
      }),
      http.post(`${API_BASE}/auth-assistance/:id/complete`, () => {
        authCompletionCalls += 1;
        return HttpResponse.json({ success: true });
      }),
      http.post(`${API_BASE}/auth-assistance/:id/refresh-session`, () =>
        HttpResponse.json({
          request: { id: 'auth-stale', steelSessionId: 'steel-stale' },
          handoff: {
            type: 'live_view',
            steelSessionId: 'steel-stale',
            liveViewUrl: 'https://debug.steel.dev/session/stale',
          },
          liveViewUrl: 'https://debug.steel.dev/session/stale',
          refreshed: false,
        }),
      ),
    );
    const messages: Message[] = [
      {
        message_id: 'auth-stale',
        timestamp: '2026-01-01T00:00:00Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-1',
          action_type: 'auth_assistance',
          title: 'Waiting for login',
          toolStatus: 'IN_PROGRESS',
          requestUserAuthentication: {
            requestId: 'auth-stale',
            authRealm: 'example.com',
            taskId: 'task-1',
            liveViewUrl: 'https://debug.steel.dev/session/stale',
          },
        },
      },
      {
        message_id: 'pause-after-auth',
        timestamp: '2026-01-01T00:00:01Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-1',
          action_type: 'session_paused',
          title: 'Paused after login request',
        },
      },
    ];

    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx(
        messages,
        <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />,
        'agent-control-test',
      ),
    );

    await user.click(screen.getByText('Paused after login request'));
    await waitFor(() => expect(screen.getByText("Agent's Browser")).toBeInTheDocument());
    const header = screen.getByText("Agent's Browser").closest('div')!.parentElement!;
    const headerButtons = within(header).getAllByRole('button');
    await user.click(headerButtons[headerButtons.length - 2]);

    await user.click(await screen.findByRole('button', { name: 'Take Control' }));
    await waitFor(() => expect(resumeCalls).toBe(1));
    expect(await screen.findByRole('button', { name: 'Hand back control' })).toBeInTheDocument();
    expect(screen.getByTitle('Browser')).toHaveAttribute(
      'src',
      expect.stringContaining('kernel.example/resumed'),
    );
    expect(authCompletionCalls).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Hand back control' }));
    await waitFor(() => expect(agentResumeCalls).toBe(1));
    expect(await screen.findByRole('button', { name: 'Take control' })).toBeInTheDocument();
  });

  it('opens the Browser drawer on the agent tab and closing it returns to the expanded chip', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx([], <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />),
    );

    await user.click(screen.getByText('Browser session active'));
    await waitFor(() => expect(screen.getByText("Agent's Browser")).toBeInTheDocument());
    const header = screen.getByText("Agent's Browser").closest('div')!.parentElement!;
    const hdrButtons = within(header).getAllByRole('button');
    await user.click(hdrButtons[hdrButtons.length - 2]);

    // The drawer (not a fullscreen portal) shows this agent's live browser.
    const drawer = screen.getByTestId('browser-app-drawer');
    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'open'));
    expect(within(drawer).getByTestId('browser-tab-agent-selected')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(drawer).getByTestId('browser-agent-pane')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: /^Take control$/ })).toBeInTheDocument();

    // No close X on desktop (UI ledger row 67): Escape / the Browser icon close it.
    await user.keyboard('{Escape}');

    await waitFor(() => expect(drawer).toHaveAttribute('data-state', 'closed'));
    expect(screen.queryByTestId('browser-agent-pane')).not.toBeInTheDocument();
    // Back to the expanded chip — Task progress heading is present.
    expect(screen.getByText(/Task progress/i)).toBeInTheDocument();
  });

  it('shows SchemaChip with output_schema fields + hovering reveals the tooltip', async () => {
    const messages: Message[] = [
      {
        message_id: 'init-msg',
        timestamp: '2026-01-01T00:00:00Z',
        text: '',
        role: 'TOOL',
        metadata: {
          task_id: 'task-1',
          title: 'booted',
          output_schema: {
            fields: [
              { name: 'title', type: 'str', description: 'The page title' },
              { name: 'count', type: 'int', description: 'A count' },
            ],
          },
        },
      },
    ];
    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx(messages, <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />),
    );

    // The FileJson icon is rendered as an SVG — its closest mouse-region div is the trigger.
    // Hover to reveal the tooltip rendered into document.body via portal.
    const svg = document.querySelector('.lucide-file-json');
    expect(svg).toBeTruthy();
    const trigger = (svg as SVGElement).closest('div[class*="flex-shrink-0"]') as HTMLElement;
    expect(trigger).toBeTruthy();
    await user.hover(trigger);

    await waitFor(() => {
      expect(screen.getByText('Output Schema')).toBeInTheDocument();
    });
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText('count')).toBeInTheDocument();
  });

  it('collapse button in expanded view re-minimizes the bar', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      withAgentCtx([], <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />),
    );

    await user.click(screen.getByText('Browser session active'));
    await waitFor(() => expect(screen.getByText(/Task progress/i)).toBeInTheDocument());

    // Click the last button in the expanded header (ChevronDown = collapse)
    const expandedHeader = screen.getByText("Agent's Browser").closest('div')!.parentElement!;
    const hdrButtons = within(expandedHeader).getAllByRole('button');
    await user.click(hdrButtons[hdrButtons.length - 1]);

    // Back to minimized: Task progress panel is gone
    await waitFor(() => expect(screen.queryByText(/Task progress/i)).toBeNull());
  });
});

// ─── OpeningMessageDisplay (blackbox) ────────────────────────────────────
describe('OpeningMessageDisplay (blackbox)', () => {
  const LAST_INDEX = OPENING_MESSAGES.length - 1;

  it('renders caption text for non-final messages without a CTA button', () => {
    renderWithProviders(
      <OpeningMessageDisplay
        currentMessageIndex={0}
        animationPhase="revealing"
        revealProgress={50}
      />,
    );

    expect(screen.getByText(OPENING_MESSAGES[0][0])).toBeInTheDocument();
    expect(screen.queryByTestId('opening-join-waitlist')).toBeNull();
  });

  it('renders caption text for the final message (CTA is no longer the terminal frame)', () => {
    renderWithProviders(
      <OpeningMessageDisplay
        currentMessageIndex={LAST_INDEX}
        animationPhase="revealing"
        revealProgress={100}
      />,
    );

    // The final message shows its caption text — the CTA moved to a persistent
    // overlay on the ASCII loader, not the last text-animation frame.
    expect(screen.getByText(OPENING_MESSAGES[LAST_INDEX][0])).toBeInTheDocument();
    expect(screen.queryByTestId('opening-join-waitlist')).toBeNull();
  });
});

// ─── AsciiLoader CTA overlay (blackbox) ──────────────────────────────────
describe('AsciiLoader CTA overlay (blackbox)', () => {
  it('renders a transparent CTA whose pill tints the SAME frame chars + fills whitespace', () => {
    const onClick = vi.fn();
    const { container } = renderWithProviders(
      <AsciiLoader
        showWarmingUp={false}
        size="large"
        variant="engine"
        cta={{ label: 'Join Waitlist', onClick }}
      />,
    );

    const button = screen.getByTestId('opening-join-waitlist');
    expect(button).toHaveTextContent('Join Waitlist');
    // A button that opens the login modal — no site redirect.
    expect(button.tagName).toBe('BUTTON');
    expect(button).not.toHaveAttribute('href');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    // Transparent capsule with a 1px rose border, centered on the animation.
    // No fill, no glow (drop shadow) — the border warms on hover.
    expect(button.className).toContain('bg-transparent');
    expect(button.className).toContain('border-[#E062CC]');
    expect(button.className).not.toContain('shadow-');
    expect(button.style.top).toBe('calc(50% + 0px)');
    // Clickable despite the loader overlay's pointer-events-none wrapper.
    expect(button.className).toContain('pointer-events-auto');

    // The primary action stays readable without hover/focus, including on
    // touch devices: no arrow-only rest state or hidden label animation.
    expect(within(button).queryByTestId('opening-join-icon')).toBeNull();
    const label = within(button).getByTestId('opening-join-label') as HTMLElement;
    expect(label).toHaveTextContent('Join Waitlist');
    expect(label.className).not.toContain('translate-y-[150%]');
    expect(label.className).not.toContain('opacity-0');
    expect(label.className).not.toContain('group-hover:translate-y-0');
    expect(label.className).not.toContain('group-hover:opacity-100');
    // Plain white glyphs (no chrome gradient) so they don't fight the animation.
    expect(label.style.color).toMatch(/#ffffff|rgb\(255,\s*255,\s*255\)|white/);

    // The prism layer re-renders the SAME frame as the animation beneath —
    // every real glyph keeps its exact position (no chars-on-chars) — and only
    // whitespace cells are filled, so the pill is fully packed.
    const prism = screen.getByTestId('opening-join-prism') as HTMLElement;
    expect(prism).toHaveAttribute('aria-hidden');
    const basePre = container.querySelector('pre:not([data-testid])') as HTMLElement;
    const baseText = basePre.textContent || '';
    const prismText = prism.textContent || '';
    expect(prismText.length).toBe(baseText.length);
    expect(prismText).not.toMatch(/ /); // whitespace filled, fully packed
    for (let i = 0; i < baseText.length; i++) {
      if (baseText[i] !== ' ' || baseText[i] === '\n') {
        expect(prismText[i]).toBe(baseText[i]); // real glyphs align 1:1
      }
    }
    // Rose gradient is background-clipped into the glyphs (no solid rectangle)
    // and pill-clipped via clip-path (no border/frame on the region).
    expect(prism.style.backgroundImage.toLowerCase()).toContain('gradient');
    expect(prism.style.backgroundImage.toLowerCase()).toMatch(/#ff6b00|255,\s*107,\s*0/);
    expect(prism.style.backgroundClip || prism.style.webkitBackgroundClip).toBe('text');
    expect(prism.style.clipPath).toContain('round');

    // The glyph shadow is gradient-colored: a twin gradient-clipped layer
    // rendered beneath the prism, offset down + tightly blurred + dimmed (a
    // single-color drop-shadow can't follow the gradient). Same content, so
    // shadow shapes match glyphs 1:1; blur stays small (no haze between chars).
    const shadow = screen.getByTestId('opening-join-prism-shadow') as HTMLElement;
    expect(shadow).toHaveAttribute('aria-hidden');
    expect(shadow.textContent).toBe(prism.textContent);
    expect(shadow.style.backgroundImage).toBe(prism.style.backgroundImage);
    expect(shadow.style.transform).toContain('translateY');
    expect(shadow.style.filter).toContain('blur');
    expect(shadow.style.clipPath).toContain('round');
    expect(prism.compareDocumentPosition(shadow) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('omits the CTA overlay entirely when no cta prop is passed', () => {
    renderWithProviders(<AsciiLoader showWarmingUp={false} size="large" variant="engine" />);
    expect(screen.queryByTestId('opening-join-waitlist')).toBeNull();
    expect(screen.queryByTestId('opening-join-prism')).toBeNull();
    expect(screen.queryByTestId('opening-join-prism-shadow')).toBeNull();
  });
});

// ─── ChatScrollArea waitlist CTA auth-gating (blackbox) ──────────────────
//
// The terminal's opening "Join Waitlist" CTA must disappear once a user is
// signed in with a real (non-anonymous) account, but stay visible for
// logged-out AND anonymous-bootstrap visitors (every landing visitor gets an
// anonymous session — they are not "logged in").
describe('ChatScrollArea Join Waitlist auth-gating (blackbox)', () => {
  function makeAgentSlice(auth: { isAuthenticated: boolean; isAnonymous: boolean }) {
    // Opening state that surfaces the CTA: no selected agent, no messages,
    // nothing loading. Only the fields ChatScrollArea reads are populated.
    return {
      selectedAgentId: null,
      agentDetail: null,
      messages: [],
      isLoadingAgent: false,
      isLoadingNetwork: false,
      loadingDots: '',
      isAuthenticated: auth.isAuthenticated,
      isAnonymous: auth.isAnonymous,
      handleJoinWaitlist: vi.fn(),
      handleSelectAgent: vi.fn(),
      handleSubmitFeedback: vi.fn(),
      setShowCreditModal: vi.fn(),
      setShowCostLimitModal: vi.fn(),
    } as unknown as Parameters<typeof ChatScrollArea>[0]['agents'];
  }

  const drip = {
    dripStyles: { blur: 0, saturation: 1, brightness: 1 },
    blur: 0,
  } as unknown as Parameters<typeof ChatScrollArea>[0]['drip'];

  const opening = {
    currentMessageIndex: 0,
    animationPhase: 'revealing',
    revealProgress: 100,
  } as unknown as Parameters<typeof ChatScrollArea>[0]['opening'];

  function renderChat(auth: { isAuthenticated: boolean; isAnonymous: boolean }) {
    return renderWithProviders(
      <ChatScrollArea
        agents={makeAgentSlice(auth)}
        drip={drip}
        opening={opening}
        messagesEndRef={React.createRef<HTMLDivElement>()}
      />,
    );
  }

  it('shows the Join Waitlist CTA for a logged-out visitor', () => {
    renderChat({ isAuthenticated: false, isAnonymous: false });
    expect(screen.getByTestId('opening-join-waitlist')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-opening-loader')).toHaveStyle({ opacity: 1 });
  });

  it('shows the Join Waitlist CTA for an anonymous-bootstrap session', () => {
    renderChat({ isAuthenticated: true, isAnonymous: true });
    expect(screen.getByTestId('opening-join-waitlist')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-opening-loader')).toHaveStyle({ opacity: 1 });
  });

  it('hides the Join Waitlist CTA when signed in with a real account', () => {
    renderChat({ isAuthenticated: true, isAnonymous: false });
    expect(screen.queryByTestId('opening-join-waitlist')).toBeNull();
    expect(screen.getByTestId('terminal-opening-loader')).toHaveStyle({ opacity: 0.2 });
  });
});
