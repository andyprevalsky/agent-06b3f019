import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MessageListItems } from '@/features/terminal-component-group/components/MessageListItems';
import { RoseAppIcons } from '@/features/terminal-component-group/components/rose-apps/RoseAppIcons';
import { agentDisplayEntries } from '@/features/terminal-component-group/components/rose-apps/agentDisplayEntries';
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
function panel() {
  return screen.getByTestId('agent-display-drawer');
}
function chatRow() {
  return document.querySelector<HTMLElement>('[data-message-kind="display-media"]')!;
}

describe('Agent Display destination', () => {
  it('comes first, glows for available output and unmounts frames when closed', async () => {
    const complete = vi.fn();
    renderWithProviders(<Scene messages={[output()]} complete={complete} />, {
      selectedAgentId: 'root',
    });
    const icons = within(screen.getByTestId('rose-app-icons')).getAllByRole('button');
    expect(icons.slice(0, 2).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Agent Display',
      'Browser',
    ]);
    expect(within(panel()).queryByTestId('display-html-frame')).toBeNull();
    const displayIcon = screen.getByTestId('rose-app-display');
    await waitFor(() => expect(displayIcon).toHaveAttribute('data-displaying', 'true'));
    expect(displayIcon).toHaveStyle({ color: '#9cddff' });
    expect(displayIcon.querySelector('svg.lucide-monitor')).not.toBeNull();
    expect(complete).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Agent Display' }));
    await waitFor(() => expect(within(panel()).getByTitle('game.html')).toBeInTheDocument());
    const frame = within(panel()).getByTitle('game.html');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-popups');
    expect(frame).toHaveAttribute('src', 'https://usercontent.rose.test/game.html');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(within(panel()).queryByTestId('display-html-frame')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Open agent display/ }));
    expect(within(panel()).getByTitle('game.html')).toBeInTheDocument();
  });

  it('upserts replay and lets users choose older outputs with one mounted frame', async () => {
    const view = renderWithProviders(<Scene messages={[output()]} />, { selectedAgentId: 'root' });
    view.rerender(<Scene messages={[output(), output('second')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agent Display' }));
    const select = await within(panel()).findByRole('combobox', { name: 'Display output' });
    expect(within(select).getAllByRole('option')).toHaveLength(2);
    expect(within(panel()).getByTitle('second.html')).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'game' } });
    expect(within(panel()).getByTitle('game.html')).toBeInTheDocument();
    expect(within(panel()).getAllByTestId('display-html-frame')).toHaveLength(1);
    view.rerender(<Scene messages={[output(), output('second')]} />);
    expect(within(select).getAllByRole('option')).toHaveLength(2);
  });

  it('shows a quiet empty state and does not borrow another agent output', () => {
    renderWithProviders(<Scene messages={[]} />, { selectedAgentId: 'root' });
    fireEvent.click(screen.getByRole('button', { name: 'Agent Display' }));
    expect(within(panel()).getByText('No displays yet for this agent.')).toBeInTheDocument();
    expect(screen.getByTestId('rose-app-display')).not.toHaveAttribute('data-displaying');
    expect(screen.queryByTestId('display-html-frame')).toBeNull();
  });

  it('the app conversation shows the display inline in chat and still opens it full size', () => {
    renderWithProviders(<Scene messages={[output()]} />, { selectedAgentId: 'root' });
    // Inline in the chat row itself, before (and without) opening the panel.
    const inline = within(chatRow()).getByTitle('game.html');
    expect(inline).toHaveAttribute('src', 'https://usercontent.rose.test/game.html');
    expect(inline).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-popups');
    expect(within(chatRow()).getByText('Interactive game')).toBeInTheDocument();
    expect(within(panel()).queryByTestId('display-html-frame')).toBeNull();
    expect(inline).toHaveAttribute('loading', 'lazy');
    // The existing way to open the same output full size is kept; while the panel
    // shows it, the inline copy unmounts (one live frame).
    fireEvent.click(within(chatRow()).getByRole('button', { name: 'Open agent display' }));
    expect(within(panel()).getByTitle('game.html')).toBeInTheDocument();
    expect(screen.getAllByTestId('display-html-frame')).toHaveLength(1);
    expect(within(chatRow()).getByTestId('display-shown-in-panel')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(within(chatRow()).getByTitle('game.html')).toBeInTheDocument();
  });

  it('the panel frame fills the panel height (not a fixed 480px box); the chat copy keeps its size', () => {
    renderWithProviders(<Scene messages={[output()]} />, { selectedAgentId: 'root' });
    expect(within(chatRow()).getByTitle('game.html')).toHaveStyle({ height: '480px' });
    fireEvent.click(screen.getByRole('button', { name: 'Agent Display' }));
    const frame = within(panel()).getByTitle('game.html');
    // A page that never reports its height takes the panel's full content height.
    expect(frame.style.height).toBe('');
    expect(frame).toHaveClass('flex-1');
    const group = within(panel()).getByTestId('display-media');
    expect(group).toHaveClass('flex-1', 'min-h-0');
    const content = within(panel()).getByTestId('agent-display-content');
    expect(content).toHaveClass('flex', 'flex-col', 'min-h-0', 'flex-1');
  });

  it('preserves the existing inline renderer for non-app callers', () => {
    renderWithProviders(<Scene messages={[output()]} />);
    expect(screen.getByTitle('game.html')).toBeInTheDocument();
  });

  it('uses canonical call identity for replayed parent and code-session copies', () => {
    const duplicate = output('native', 'same-call');
    const canonical = output('parent', 'same-call');
    canonical.file_pointer = duplicate.file_pointer;
    expect(agentDisplayEntries('root', [duplicate])[0].id).toBe('same-call');
    expect(agentDisplayEntries('root', [canonical])[0].id).toBe('same-call');
  });
});
