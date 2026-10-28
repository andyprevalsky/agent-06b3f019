import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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

  it('is collapsed by default and expands to full size without remounting the frame', () => {
    renderWithProviders(<Scene messages={[output()]} />, { selectedAgentId: 'root' });
    const row = chatRow();
    const toggle = within(row).getByTestId('display-toggle');
    const body = within(row).getByTestId('display-body');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAccessibleName('Expand display: Interactive game');
    expect(toggle.querySelector('svg.lucide-chevron-right')).not.toBeNull();
    expect(toggle.className).not.toMatch(/\b(border|bg-|rounded|ring|shadow)/);
    expect(body).toHaveClass('max-h-[240px]', 'overflow-hidden');
    expect(toggle).toHaveTextContent('Interactive game');
    // The caption lives in the disclosure row only (not repeated in the body).
    expect(within(body).queryByText('Interactive game')).toBeNull();
    const frame = within(row).getByTitle('game.html');
    expect(frame).toHaveStyle({ height: '480px' });

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAccessibleName('Collapse display: Interactive game');
    expect(toggle.querySelector('svg.lucide-chevron-down')).not.toBeNull();
    expect(body).not.toHaveClass('max-h-[240px]');
    expect(body).toHaveClass('h-[80vh]', 'flex', 'flex-col');
    // Same frame element: it fills the expanded height instead of a 480px box.
    expect(within(row).getByTitle('game.html')).toBe(frame);
    expect(frame.style.height).toBe('');
    expect(frame).toHaveClass('flex-1');
    expect(within(body).getByTestId('display-media')).toHaveClass('flex-1', 'min-h-0');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(body).toHaveClass('max-h-[240px]');
    expect(within(row).getByTitle('game.html')).toBe(frame);
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
    expect(within(rows[1]).getByTestId('display-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(within(rows[0]).getByTestId('display-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('labels a caption-less display by its filename', () => {
    const message = output('chart');
    (message.metadata!.display as { caption?: string }).caption = undefined;
    renderWithProviders(<Scene messages={[message]} />, { selectedAgentId: 'root' });
    expect(within(chatRow()).getByTestId('display-toggle')).toHaveAccessibleName(
      'Expand display: chart.html',
    );
  });

  it('renders inline for non-app callers too', () => {
    renderWithProviders(<Scene messages={[output()]} />);
    expect(screen.getByTitle('game.html')).toBeInTheDocument();
  });
});
