/**
 * User-bubble collapse and the agent message meta line (send time + hover copy),
 * exercised by the normal frontend blackbox gate.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MessageBubble from '@/features/terminal-component-group/components/MessageBubble';
import { UserBubble } from '@/features/terminal-component-group/components/message-bubble/UserBubble';
import { formatMessageSentAt } from '@/lib/localDateTime';
import { baseMessage } from './message-bubble.fixtures';

describe('user message collapse', () => {
  it('shows short messages without a toggle', () => {
    render(<UserBubble message={baseMessage({ role: 'USER', text: 'hi rose' })} />);
    expect(screen.getByText('hi rose')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });
  it('collapses overflowing USER text, toggles it, and remeasures on resize', async () => {
    let height = 480;
    let resize: () => void = () => {};
    const disconnect = vi.fn();
    const OriginalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this);
      }
      observe() {}
      disconnect = disconnect;
      unobserve() {}
    };
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function () {
        return height;
      });
    try {
      const text = 'A long message with all its original content. '.repeat(60);
      const view = render(<UserBubble message={baseMessage({ role: 'USER', text })} />);
      const content = screen.getByTestId('user-message-text');
      const preview = content.parentElement!;
      const toggle = screen.getByRole('button', { name: 'Show more' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveAttribute('aria-controls', preview.id);
      expect(preview).toHaveStyle({ maxHeight: '240px', overflow: 'hidden' });
      expect(content.textContent).toBe(text);
      await userEvent.click(toggle);
      expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      expect(preview.style.maxHeight).toBe('');
      await userEvent.click(toggle);
      expect(preview).toHaveStyle({ maxHeight: '240px' });
      height = 100;
      act(() => resize());
      expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
      height = 480;
      act(() => resize());
      expect(screen.getByRole('button', { name: 'Show more' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      view.unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      scrollHeight.mockRestore();
      globalThis.ResizeObserver = OriginalResizeObserver;
    }
  });
});

describe('agent message meta line', () => {
  const SENT_AT = '2026-11-12T19:51:00.000Z';
  const reply = '**Done.** Booked the table\nfor two at 7pm.';
  const agentMessage = (toolStatus: 'IN_PROGRESS' | 'FINISHED') =>
    baseMessage({
      role: 'TOOL',
      text: reply,
      timestamp: SENT_AT,
      metadata: {
        toolName: 'send_message_to_user',
        toolStatus,
        isUserAttentionMessage: true,
        attentionMessage: reply,
      },
    });
  afterEach(() => vi.unstubAllGlobals());

  it('records the send time under a settled agent message with a hover copy and no branch action', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<MessageBubble message={agentMessage('FINISHED')} />);
    const meta = screen.getByTestId('agent-message-meta');
    expect(meta.querySelector('time')).toHaveAttribute('dateTime', SENT_AT);
    expect(meta.firstElementChild?.tagName).toBe('TIME');
    expect(meta.textContent).toBe(formatMessageSentAt(SENT_AT));
    const button = screen.getByRole('button', { name: 'Copy message' });
    expect(meta).toContainElement(button);
    expect(button.className).toContain('opacity-0');
    expect(button.className).toContain('group-hover/message:opacity-100');
    expect(button.closest('.group\\/message')).not.toBeNull();
    expect(meta.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith(reply);
  });

  it('keeps the record on a waiting question and omits it while the reply streams', () => {
    const { rerender } = render(<MessageBubble message={agentMessage('IN_PROGRESS')} />);
    expect(screen.getByTestId('agent-message-meta')).toBeInTheDocument();
    rerender(<MessageBubble message={agentMessage('IN_PROGRESS')} isStreaming />);
    expect(screen.queryByTestId('agent-message-meta')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
  });
});
