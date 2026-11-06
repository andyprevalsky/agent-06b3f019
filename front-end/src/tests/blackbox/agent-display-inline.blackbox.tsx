import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HTML_FRAME_FULL_MAX_HEIGHT } from '@/features/terminal-component-group/components/inline-media/DisplayMediaGroup';
import { MessageListItems } from '@/features/terminal-component-group/components/MessageListItems';
import { RoseAppIcons } from '@/features/terminal-component-group/components/rose-apps/RoseAppIcons';
import type { Message } from '@/lib/api';
import { renderWithProviders } from './test-wrapper';

function output(id = 'game', canonical = id): Message {
  return {
    message_id: id,
    role: 'ASSISTANT',
    text: 'Interactive game',
    timestamp: '2026-10-20T12:00:00Z',
    metadata: {
      display: {
        placement: 'inline',
        kind: 'media',
        media_kind: 'page',
        mime_type: 'text/html',
        caption: 'Interactive game',
        canonical_id: canonical,
      },
    },
    file_pointer: {
      id,
      original_filename: `${id}.html`,
      storage_path: `display/${id}.html`,
      mime_type: 'text/html',
      size_bytes: 100,
      created_at: '2026-10-20T12:00:00Z',
      usercontent_url: `https://usercontent.rose.test/${id}.html`,
    },
  } as Message;
}
const empty = new Map();
function Scene({ messages, complete = () => {} }: { messages: Message[]; complete?: () => void }) {
  return (
    <>
      <RoseAppIcons />
      <MessageListItems
        filteredMessages={messages}
        selectedAgentId="root"
        currentAnimatingId={messages[0]?.message_id ?? null}
        onAnimationComplete={complete}
        exploreStepMap={empty}
        waitForCheckMap={empty}
        streamingMetricsBySubAgentId={empty}
      />
    </>
  );
}
function chatRows() {
  return [...document.querySelectorAll<HTMLElement>('[data-message-kind="display-media"]')];
}
function chatRow() {
  return chatRows()[0]!;
}
/** The framed page reports its content height (the usercontent height reporter). */
function reportHeight(frame: HTMLIFrameElement, height: number) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'rose:resize', height },
        origin: 'null',
        source: frame.contentWindow,
      }),
    );
  });
}
function toolRow(id: string, title: string, toolStatus: string, error?: string): Message {
  return {
    message_id: id,
    role: 'TOOL',
    text: title,
    timestamp: '2026-10-20T12:00:01Z',
    metadata: {
      toolName: 'display',
      title,
      toolStatus,
      ...(error ? { error } : {}),
      display: { placement: 'inline', items: [] },
    },
  } as Message;
}

describe('Agent displays render inline (no Agent Display icon or panel)', () => {
  it('has no Agent Display icon or panel; the display shows inline in the chat', async () => {
    const complete = vi.fn();
    renderWithProviders(<Scene messages={[output()]} complete={complete} />, {
      selectedAgentId: 'root',
    });
    const icons = within(screen.getByTestId('rose-app-icons')).getAllByRole('button');
    expect(icons.map((b) => b.getAttribute('aria-label'))).not.toContain('Agent Display');
    expect(screen.queryByTestId('rose-app-display')).toBeNull();
    expect(screen.getByTestId('rose-app-icons').querySelector('svg.lucide-monitor')).toBeNull();
    expect(screen.queryByTestId('agent-display-drawer')).toBeNull();
    expect(screen.queryByRole('button', { name: /Open agent display/ })).toBeNull();
    await waitFor(() => expect(complete).toHaveBeenCalled());
    const inline = within(chatRow()).getByTitle('game.html');
    expect(inline).toHaveAttribute('src', 'https://usercontent.rose.test/game.html');
    expect(inline).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-popups');
    expect(inline).toHaveAttribute('loading', 'lazy');
    expect(screen.getAllByTestId('display-html-frame')).toHaveLength(1);
  });

  it("starts expanded at the page's full height (no scroll inside the display), collapsing to a preview without remounting", () => {
    renderWithProviders(<Scene messages={[output()]} />, { selectedAgentId: 'root' });
    const row = chatRow();
    const toggle = within(row).getByTestId('display-toggle');
    const body = within(row).getByTestId('display-body');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAccessibleName('Collapse display: Interactive game');
    expect(toggle.querySelector('svg.lucide-chevron-down')).not.toBeNull();
    expect(toggle.className).not.toMatch(/\b(border|bg-|rounded|ring|shadow)/);
    expect(toggle).toHaveTextContent('Interactive game');
    // The caption lives in the disclosure row only (not repeated in the body).
    expect(within(body).queryByText('Interactive game')).toBeNull();
    // Nothing boxes the display: no clip, no own scroll area, no fixed height.
    expect(body.className).not.toMatch(/\b(max-h-|h-\[|overflow-)/);
    const frame = within(row).getByTitle('game.html') as HTMLIFrameElement;
    // Before the page reports its height it gets most of the screen.
    expect(frame.style.height).toBe('80vh');
    reportHeight(frame, 2400);
    expect(frame.style.height).toBe('2400px');
    reportHeight(frame, 50_000);
    expect(frame.style.height).toBe(`${HTML_FRAME_FULL_MAX_HEIGHT}px`);
    expect(HTML_FRAME_FULL_MAX_HEIGHT).toBeGreaterThanOrEqual(10_000);
    reportHeight(frame, 120);
    expect(frame.style.height).toBe('200px');
    reportHeight(frame, 2400);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAccessibleName('Expand display: Interactive game');
    expect(toggle.querySelector('svg.lucide-chevron-right')).not.toBeNull();
    expect(body).toHaveClass('max-h-[240px]', 'overflow-hidden');
    // Same frame element, now a bounded preview box.
    expect(within(row).getByTitle('game.html')).toBe(frame);
    expect(frame.style.height).toBe('900px');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(body).not.toHaveClass('max-h-[240px]');
    expect(within(row).getByTitle('game.html')).toBe(frame);
    expect(frame.style.height).toBe('2400px');
  });

  it('a collapsed page that never reports its height previews a 480px box', () => {
    renderWithProviders(<Scene messages={[output()]} />, { selectedAgentId: 'root' });
    fireEvent.click(within(chatRow()).getByTestId('display-toggle'));
    expect(within(chatRow()).getByTitle('game.html')).toHaveStyle({ height: '480px' });
  });

  it('hides the display tool row ("Displayed for the user"); a failed display keeps its error', () => {
    renderWithProviders(
      <Scene
        messages={[
          toolRow('call', 'Displayed for the user', 'FINISHED'),
          output(),
          toolRow('failed', '❌ Display failed', 'ERROR', 'storage unavailable'),
        ]}
      />,
      { selectedAgentId: 'root' },
    );
    expect(chatRows()).toHaveLength(1);
    expect(screen.queryByText('Displayed for the user')).toBeNull();
    expect(document.querySelector('[data-message-id="call"]')).toBeNull();
    expect(screen.getAllByText(/Display failed/).length).toBeGreaterThan(0);
  });

  it('every display of the agent stays reachable inline, each independently expandable', () => {
    renderWithProviders(<Scene messages={[output(), output('second')]} />, {
      selectedAgentId: 'root',
    });
    const rows = chatRows();
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByTitle('game.html')).toBeInTheDocument();
    expect(within(rows[1]).getByTitle('second.html')).toBeInTheDocument();
    fireEvent.click(within(rows[1]).getByTestId('display-toggle'));
    expect(within(rows[1]).getByTestId('display-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(within(rows[0]).getByTestId('display-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  it('labels a caption-less display by its filename', () => {
    const message = output('chart');
    (message.metadata!.display as { caption?: string }).caption = undefined;
    renderWithProviders(<Scene messages={[message]} />, { selectedAgentId: 'root' });
    expect(within(chatRow()).getByTestId('display-toggle')).toHaveAccessibleName(
      'Collapse display: chart.html',
    );
  });

  it('renders inline for non-app callers too', () => {
    renderWithProviders(<Scene messages={[output()]} />);
    expect(screen.getByTitle('game.html')).toBeInTheDocument();
  });
});
