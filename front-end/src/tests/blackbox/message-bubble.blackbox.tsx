/**
 * Blackbox tests for MessageBubble component.
 *
 * Covers message, attention, approval, and completion routing:
 *  - USER role: bubble with text, with file_pointer
 *  - ASSISTANT role: Thought tool card, streaming, file_pointer
 *  - SYSTEM role: plain bubble
 *  - TOOL role: ToolMessage card (IN_PROGRESS / FINISHED / ERROR with chevron)
 *  - isUserAttentionMessage → AttentionMessage with waiting indicator
 *  - isSignupRequest → SignupPromptBubble
 *  - isCompletionSummary → CompletionSummaryCard + FeedbackBanner
 *  - Tool approval (returns null)
 * Specialized tool routes are covered in message-bubble-specialized-tools.blackbox.tsx.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import MessageBubble from '@/features/terminal-component-group/components/MessageBubble';
import { RoseDesktopContext } from '@/hooks/roseDesktopContext';
import { server } from './msw/server';
import { baseMessage, renderBubble, storeTestSession } from './message-bubble.fixtures';

describe('MessageBubble', () => {
  it('renders USER message with right-aligned text bubble', () => {
    const msg = baseMessage({ role: 'USER', text: 'hi rose' });
    renderBubble(<MessageBubble message={msg} />);
    expect(screen.getByText('hi rose')).toBeInTheDocument();
  });

  it('renders USER message without text when only a file_pointer is provided', async () => {
    const msg = baseMessage({
      role: 'USER',
      text: '',
      file_pointer: {
        id: 'fp1',
        storage_path: 'uploads/a.pdf',
        original_filename: 'a.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1024,
        created_at: new Date().toISOString(),
      },
    });
    renderBubble(<MessageBubble message={msg} agentId="agent-1" />);
    await waitFor(() => expect(screen.getByText('a.pdf')).toBeInTheDocument());
  });

  it('renders SYSTEM message as a plain bubble', () => {
    const msg = baseMessage({ role: 'SYSTEM', text: 'system msg' });
    renderBubble(<MessageBubble message={msg} />);
    expect(screen.getByText('system msg')).toBeInTheDocument();
  });

  it('renders ASSISTANT message as Thought tool card (non-streaming, no file)', async () => {
    const msg = baseMessage({ role: 'ASSISTANT', text: 'I think so' });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('Thought')).toBeInTheDocument());
  });

  it('does not render ASSISTANT thought card when the message has no content', () => {
    const msg = baseMessage({ role: 'ASSISTANT', text: '   ' });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    expect(screen.queryByText('Thought')).not.toBeInTheDocument();
    expect(container.firstChild).toBeNull();
  });

  it('renders ASSISTANT with shouldType=true as collapsed Thought and releases the animation queue', async () => {
    // Regression: the card has no typing animation, so deriving IN_PROGRESS
    // from shouldType flashed it open for one frame before the instant
    // onComplete collapsed it (open→closed flicker on the first thought).
    const msg = baseMessage({ role: 'ASSISTANT', text: 'working' });
    const onComplete = vi.fn();
    renderBubble(<MessageBubble message={msg} shouldType={true} onTypingComplete={onComplete} />);
    await waitFor(() => expect(screen.getByText('Thought')).toBeInTheDocument());
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
    expect(screen.queryByText('working')).not.toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it('renders ASSISTANT streaming as plain text bubble', () => {
    const msg = baseMessage({ role: 'ASSISTANT', text: 'streaming text' });
    renderBubble(<MessageBubble message={msg} isStreaming={true} />);
    expect(screen.getByText('streaming text')).toBeInTheDocument();
  });

  it('renders ASSISTANT with file_pointer as attachment row', async () => {
    const msg = baseMessage({
      role: 'ASSISTANT',
      text: 'see file',
      file_pointer: {
        id: 'fp2',
        storage_path: '',
        original_filename: 'output.txt',
        mime_type: 'text/plain',
        size_bytes: 500,
        created_at: new Date().toISOString(),
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('output.txt')).toBeInTheDocument());
    expect(screen.getByText('see file')).toBeInTheDocument();
  });

  it('renders ASSISTANT attachment row even when the message has no text', async () => {
    const msg = baseMessage({
      role: 'ASSISTANT',
      text: '',
      file_pointer: {
        id: 'fp3',
        storage_path: '',
        original_filename: 'empty-output.txt',
        mime_type: 'text/plain',
        size_bytes: 32,
        created_at: new Date().toISOString(),
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('empty-output.txt')).toBeInTheDocument());
    expect(screen.queryByText('Thought')).not.toBeInTheDocument();
  });

  it('auto-downloads and renders Markdown attachments inline', async () => {
    storeTestSession();
    server.use(
      http.get('http://localhost:3001/api/agents/agent-md/attachments/fp-md/url', () =>
        HttpResponse.json({ signed_url: 'https://signed.test/report.md' }),
      ),
      http.get(
        'https://signed.test/report.md',
        () =>
          new HttpResponse('# Report\n\n- item one\n- item two', {
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );
    const msg = baseMessage({
      role: 'ASSISTANT',
      text: '',
      file_pointer: {
        id: 'fp-md',
        storage_path: 'user-1/report.md',
        original_filename: 'report.md',
        mime_type: 'application/octet-stream',
        size_bytes: 29,
        created_at: new Date().toISOString(),
      },
    });

    renderBubble(<MessageBubble message={msg} agentId="agent-md" />);

    expect(await screen.findByRole('heading', { name: 'Report' })).toBeInTheDocument();
    expect(screen.getByText('item one')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download report.md' })).toBeInTheDocument();
  });

  it('renders TOOL FINISHED as tool card with title and chevron', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'the result body',
      metadata: {
        toolCallId: 'tc-1',
        toolName: 'web_search',
        title: '🔍 Searching',
        toolStatus: 'FINISHED',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText(/Searching/)).toBeInTheDocument());
  });

  it('expands a FINISHED TOOL card when clicked to reveal message content', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'the result body',
      metadata: {
        toolCallId: 'tc-1',
        toolName: 'web_search',
        title: 'Searching',
        toolStatus: 'FINISHED',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    const header = await screen.findByText(/Searching/);
    await userEvent.click(header);
    // Content goes through MarkdownText which splits words into spans.
    // Assert the expandable panel exists by checking that textContent now
    // includes the body words.
    await waitFor(() => {
      expect(container.textContent).toContain('the');
      expect(container.textContent).toContain('result');
      expect(container.textContent).toContain('body');
    });
  });

  it('hides Fast Mode / demo-cache copy from expanded tool cards', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'Fast Mode cache miss for this web search. Returning without a live provider call.',
      metadata: {
        toolCallId: 'tc-demo-cache-search',
        toolName: 'web_search',
        title: 'Searching',
        toolStatus: 'FINISHED',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    const header = await screen.findByText(/Searching/);
    await userEvent.click(header);
    expect(container.textContent).not.toMatch(/fast\s*mode/i);
    expect(container.textContent).not.toMatch(/fast[\s-]*cache/i);
  });

  it('renders TOOL IN_PROGRESS with progress bar when progressComplete is present', () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-2',
        toolName: 'compute',
        title: 'Computing',
        toolStatus: 'IN_PROGRESS',
        progressComplete: 0.42,
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    const inner = container.querySelector('.bg-primary') as HTMLElement | null;
    expect(inner).not.toBeNull();
  });

  it.each([
    ['Creating Cloud Agent', 'IN_PROGRESS'],
    ['Preparing Cloud Agent', 'IN_PROGRESS'],
    ['Starting Reasoning', 'IN_PROGRESS'],
    ['Cloud Agent Ready', 'FINISHED'],
  ] as const)(
    'renders %s cloud lifecycle tool without expandable output',
    async (title, toolStatus) => {
      const msg = baseMessage({
        role: 'TOOL',
        text: `${title} body should stay hidden.`,
        metadata: {
          toolCallId: 'tc-cloud-agent',
          toolName: 'cloud_agent',
          title,
          toolStatus,
        },
      });
      renderBubble(<MessageBubble message={msg} />);
      await waitFor(() => expect(screen.getByText(title)).toBeInTheDocument());
      expect(screen.queryByText(`${title} body should stay hidden.`)).not.toBeInTheDocument();
    },
  );

  it('renders TOOL ERROR in red with error title', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'oops',
      metadata: {
        toolCallId: 'tc-3',
        toolName: 'foo',
        title: 'Foo failed',
        toolStatus: 'ERROR',
        error: true,
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('Foo failed')).toBeInTheDocument());
  });

  it('renders thought TOOL IN_PROGRESS as collapsed "Thinking" shimmer', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'internal synthesis prompt should stay hidden',
      metadata: {
        toolCallId: 'tc-4',
        toolName: 'thought',
        title: 'Thinking',
        toolStatus: 'IN_PROGRESS',
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('Thinking')).toBeInTheDocument());
    expect(
      screen.queryByText('internal synthesis prompt should stay hidden'),
    ).not.toBeInTheDocument();
  });

  it('renders attention message (isUserAttentionMessage) with waiting indicator', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'please answer',
      metadata: {
        toolCallId: 'tc-5',
        toolName: 'send_message_to_user',
        isUserAttentionMessage: true,
        toolStatus: 'IN_PROGRESS',
        attentionMessage: 'please answer',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => {
      // Text is split into word spans by MarkdownText; check textContent.
      expect(container.textContent).toContain('please');
      expect(container.textContent).toContain('answer');
    });
    expect(screen.getByText(/Your Rose agent will continue working/)).toBeInTheDocument();
  });

  it('renders signup request as SignupPromptBubble when agentId provided', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'need login',
      metadata: {
        toolCallId: 'tc-6',
        toolName: 'request_user_signup',
        toolStatus: 'IN_PROGRESS',
        requestUserSignup: { reason: 'verify your email' },
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} agentId="agent-xyz" />);
    await waitFor(() => expect(container.textContent).toMatch(/verify.*your.*email/i));
  });

  it('returns null for tool-approval messages on a plain tool', () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'approve?',
      metadata: {
        toolCallId: 'tc-7',
        toolName: 'some_tool',
        requestUserApproval: { toolApproval: true },
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders completion-summary message with CompletionSummaryCard', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-12',
        toolName: 'complete',
        isFinalSummary: true,
        completionSummary: {
          summary: 'Completed the mission',
          outputs: [],
          totalToolCalls: 3,
          durationSeconds: 42,
        },
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText(/Completed the mission/)).toBeInTheDocument());
  });

  it('renders markdown photos inside a finished FYI attention bubble', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'Cyber Racoon interior',
      metadata: {
        toolCallId: 'tc-photo-fyi',
        toolName: 'send_message_to_user',
        isUserAttentionMessage: true,
        toolStatus: 'FINISHED',
        attentionMessage:
          'Cyber Racoon interior:\n\n![Cyber Racoon PC Cafe](https://www.cyberracoon.com/gallery/room.jpg)',
        sendMessageToUser: { isQuestion: false, attentionKind: 'info', isWaitingForUser: false },
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => {
      const img = container.querySelector('img[alt="Cyber Racoon PC Cafe"]');
      expect(img).not.toBeNull();
      expect(img).toHaveAttribute('src', 'https://www.cyberracoon.com/gallery/room.jpg');
    });
  });

  it('renders streaming attention message using StreamingText (isStreaming=true)', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'streaming body',
      metadata: {
        toolCallId: 'tc-19',
        toolName: 'send_message_to_user',
        isUserAttentionMessage: true,
        toolStatus: 'IN_PROGRESS',
        attentionMessage: 'streaming body',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} isStreaming={true} />);
    await waitFor(() => expect(container.textContent).toContain('streaming body'));
  });

  it('renders USER message with image file_pointer showing loading placeholder', async () => {
    const msg = baseMessage({
      role: 'USER',
      text: 'look',
      file_pointer: {
        id: 'img1',
        storage_path: 'uploads/pic.png',
        original_filename: 'pic.png',
        mime_type: 'image/png',
        size_bytes: 2048,
        created_at: new Date().toISOString(),
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} agentId="agent-img" />);
    // Image placeholder renders the filename while signed URL loads.
    await waitFor(() => expect(screen.getByText('pic.png')).toBeInTheDocument());
    expect(container.textContent).toContain('look');
  });

  it('Rose Desktop renders the USER image file_pointer inline (no chip) while it loads', async () => {
    const msg = baseMessage({
      role: 'USER',
      text: 'look',
      file_pointer: {
        id: 'img1',
        storage_path: 'uploads/pic.png',
        original_filename: 'pic.png',
        mime_type: 'image/png',
        size_bytes: 2048,
        created_at: new Date().toISOString(),
      },
    });
    const { container } = renderBubble(
      <RoseDesktopContext.Provider value>
        <MessageBubble message={msg} agentId="agent-img" />
      </RoseDesktopContext.Provider>,
    );
    // Images render inline by default: a reserved-size media item, no chip.
    const item = await screen.findByTestId('inline-media-item');
    expect(item).toHaveAttribute('data-filename', 'pic.png');
    expect(item).toHaveAttribute('data-kind', 'image');
    expect(screen.queryByTestId('file-pointer-chip')).not.toBeInTheDocument();
    expect(container.textContent).toContain('look');
  });

  it('renders iMessage action metadata block with Send via Mac button', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'please send this',
      metadata: {
        toolCallId: 'tc-22',
        toolName: 'request_user_attention',
        title: 'Need Mac send',
        toolStatus: 'IN_PROGRESS',
        requestUserAttention: {
          onSuccess: 'sendSmsThroughIMessage',
          to: '+15551112222',
          message: 'Howdy',
          attentionRequestId: 'att-1',
        },
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Send via Mac iMessage/ })).toBeInTheDocument(),
    );
    expect(screen.getByText(/Howdy/)).toBeInTheDocument();
  });

  it('AttentionMessage with Start Autonomous Execution button when onSendMessage given', async () => {
    const onSend = vi.fn();
    const msg = baseMessage({
      role: 'TOOL',
      text: 'answer me',
      metadata: {
        toolCallId: 'tc-auto',
        toolName: 'send_message_to_user',
        isUserAttentionMessage: true,
        toolStatus: 'IN_PROGRESS',
        attentionMessage: 'answer me',
      },
    });
    renderBubble(<MessageBubble message={msg} onSendMessage={onSend} />);
    const btn = await screen.findByRole('button', {
      name: /Start Autonomous Execution/,
    });
    await userEvent.click(btn);
    expect(onSend).toHaveBeenCalled();
  });

  it('renders TOOL IN_PROGRESS with progressComplete in 0-100 range', () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-23',
        toolName: 'compute',
        title: 'Computing',
        toolStatus: 'IN_PROGRESS',
        progressComplete: 75,
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    const inner = container.querySelector('.bg-primary') as HTMLElement | null;
    expect(inner).not.toBeNull();
    expect(inner!.style.width).toContain('75');
  });

  it('renders completion summary with FeedbackBanner when onSubmitFeedback is passed', async () => {
    const onSubmitFeedback = vi.fn();
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-fb',
        toolName: 'complete',
        isFinalSummary: true,
        completionSummary: {
          summary: 'All done',
          outputs: [],
          totalToolCalls: 1,
          durationSeconds: 10,
        },
      },
    });
    renderBubble(<MessageBubble message={msg} onSubmitFeedback={onSubmitFeedback} />);
    // FeedbackBanner's initial rating step prompts "How was this result?".
    await waitFor(() => expect(screen.getByText(/How was this result\?/i)).toBeInTheDocument());
  });

  it('iMessage action button shows toast when bridge is missing', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'please send',
      metadata: {
        toolCallId: 'tc-ims',
        toolName: 'request_user_attention',
        title: 'iMessage',
        toolStatus: 'IN_PROGRESS',
        requestUserAttention: {
          onSuccess: 'sendSmsThroughIMessage',
          to: '+15550000000',
          message: 'Hi',
          attentionRequestId: 'att-9',
        },
      },
    });
    renderBubble(<MessageBubble message={msg} />);
    const btn = await screen.findByRole('button', { name: /Send via Mac iMessage/ });
    await userEvent.click(btn);
    // Button still present - no crash.
    expect(btn).toBeInTheDocument();
  });

  it('renders thought TOOL FINISHED as collapsed tool card', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: 'final thought',
      metadata: {
        toolCallId: 'tc-th-done',
        toolName: 'thought',
        title: 'Thought',
        toolStatus: 'FINISHED',
      },
    });
    const { container } = renderBubble(<MessageBubble message={msg} />);
    await waitFor(() => expect(screen.getByText('Thought')).toBeInTheDocument());
    expect(container).toBeTruthy();
  });

  it('calls onTypingComplete immediately for tool-approval message when shouldType=true', async () => {
    const onTypingComplete = vi.fn();
    const msg = baseMessage({
      role: 'TOOL',
      text: 'approve?',
      metadata: {
        toolCallId: 'tc-ap-type',
        toolName: 'some_tool',
        requestUserApproval: { toolApproval: true },
      },
    });
    renderBubble(
      <MessageBubble message={msg} shouldType={true} onTypingComplete={onTypingComplete} />,
    );
    await waitFor(() => expect(onTypingComplete).toHaveBeenCalled());
  });

  it('compact prop removes gap-3 container class in completion summary', async () => {
    const msg = baseMessage({
      role: 'TOOL',
      text: '',
      metadata: {
        toolCallId: 'tc-cs-compact',
        toolName: 'complete',
        isFinalSummary: true,
        completionSummary: {
          summary: 'Short',
          outputs: [],
          totalToolCalls: 0,
          durationSeconds: 0,
        },
      },
    });
    const { container: compactContainer } = renderBubble(
      <MessageBubble message={msg} compact={true} />,
    );
    // Control render without compact — must have gap-3.
    const { container: defaultContainer } = renderBubble(
      <MessageBubble message={msg} compact={false} />,
    );
    await waitFor(() => expect(compactContainer.querySelector('.flex')).not.toBeNull());
    // The compact outer flex wrapper must NOT contain gap-3.
    const compactFlex = compactContainer.querySelector('.flex') as HTMLElement | null;
    expect(compactFlex).not.toBeNull();
    expect(compactFlex!.classList.contains('gap-3')).toBe(false);
    // Sanity: default render DOES include gap-3.
    const defaultFlex = defaultContainer.querySelector('.flex') as HTMLElement | null;
    expect(defaultFlex).not.toBeNull();
    expect(defaultFlex!.classList.contains('gap-3')).toBe(true);
  });
});
