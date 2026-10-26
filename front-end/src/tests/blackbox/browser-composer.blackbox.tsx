/** Browser composition stays on the existing owner channel without exposing root controls. */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import QueryInput, {
  type QueryInputProps,
} from '@/features/terminal-component-group/components/QueryInput';
import {
  RoseAppsContext,
  type RoseAppsValue,
} from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
import { postMessage } from '@/lib/api/messages';
import type { Message } from '@/lib/api';
import { UserBubble } from '@/features/terminal-component-group/components/message-bubble/UserBubble';
import { renderWithProviders } from './test-wrapper';

vi.mock('@/lib/api/messages', async (original) => ({
  ...(await original<typeof import('@/lib/api/messages')>()),
  uploadAttachment: vi.fn(async () => ({ id: 'file-pointer', original_filename: 'notes.txt' })),
}));

let slot: HTMLDivElement | undefined;
afterEach(() => slot?.remove());

function browser(value: Partial<RoseAppsValue> = {}) {
  slot = document.createElement('div');
  slot.dataset.agentId = 'owner';
  slot.dataset.taskId = 'browser-task';
  document.body.append(slot);
  return {
    openApp: 'browser',
    browserMode: 'remote',
    browserTabAgentId: 'owner',
    selectedAgentId: 'owner',
    browserComposerSlot: slot,
    tabs: [{ agentId: 'owner', taskId: 'browser-task', live: true }],
    ...value,
  } as RoseAppsValue;
}

it('shows only text, files, Send and an honest read-only model label in the owned Browser slot', () => {
  const onSubmit = vi.fn();
  const onPause = vi.fn();
  renderWithProviders(
    <RoseAppsContext.Provider value={browser()}>
      <QueryInput
        liftAboveApps
        agentId="owner"
        value="Please check the page"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        canSubmit={false}
        onPause={onPause}
        selectedModel="root-model-must-not-be-displayed"
        onModelChange={vi.fn()}
        fastMode
        onFastModeChange={vi.fn()}
        simulatorMode
        onSimulatorModeChange={vi.fn()}
      />
    </RoseAppsContext.Provider>,
  );
  const box = within(screen.getByTestId('browser-query-input'));
  expect(box.queryByTestId('query-toolbar-nub')).toBeNull();
  expect(box.queryByText('Rose')).toBeNull();
  expect(box.queryByRole('combobox')).toBeNull();
  expect(box.queryByText('root-model-must-not-be-displayed')).toBeNull();
  expect(box.getByText('Model unavailable')).toBeVisible();
  expect(box.getByRole('button', { name: 'Attach files' })).toBeEnabled();
  const buttons = box.getAllByRole('button');
  expect(buttons).toHaveLength(2);
  fireEvent.click(box.getByRole('button', { name: 'Send' }));
  expect(onSubmit).toHaveBeenCalledOnce();
  expect(onPause).not.toHaveBeenCalled();
});

it('labels the Browser composer with its Rose pool, never the raw provider model', () => {
  // Prod agent 447576b9 (rose-1-flash root): the browser reported the Cerebras
  // leg "qwen-3.8-27b"; the composer must name the Rose pool it runs on.
  renderWithProviders(
    <RoseAppsContext.Provider
      value={browser({
        tabs: [
          { agentId: 'owner', taskId: 'browser-task', live: true, actualModel: 'qwen-3.8-27b' },
        ],
      })}
    >
      <QueryInput
        liftAboveApps
        agentId="owner"
        agentDetail={{ model: 'rose-labs/rose-1-flash' } as QueryInputProps['agentDetail']}
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        selectedModel="root-selected-model"
      />
    </RoseAppsContext.Provider>,
  );
  const box = within(screen.getByTestId('browser-query-input'));
  // Rows from before pool_name shipped: the owner-model rule.
  expect(box.getByTestId('browser-model-label')).toHaveTextContent('rose-flash');
  expect(box.queryByText('qwen-3.8-27b')).toBeNull();
  expect(box.queryByText('root-selected-model')).toBeNull();
  expect(box.queryByRole('combobox')).toBeNull();
});

it('labels the Browser composer with the pool its own rows report', () => {
  renderWithProviders(
    <RoseAppsContext.Provider
      value={browser({
        tabs: [
          {
            agentId: 'owner',
            taskId: 'browser-task',
            live: true,
            actualModel: 'qwen-3.8-27b',
            rosePool: 'rose-1-browser-use',
          },
        ],
      })}
    >
      <QueryInput
        liftAboveApps
        agentId="owner"
        agentDetail={{ model: 'rose-labs/rose-1-ultra' } as QueryInputProps['agentDetail']}
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    </RoseAppsContext.Provider>,
  );
  const label = within(screen.getByTestId('browser-query-input')).getByTestId(
    'browser-model-label',
  );
  expect(label).toHaveTextContent('rose-browser-use');
});

it('does not attach the agents-running header to the Browser composer', () => {
  const banner = <div data-testid="background-agents-banner">Running 1 agent</div>;
  const tree = (open: boolean) => (
    <RoseAppsContext.Provider value={browser(open ? {} : { openApp: null })}>
      <QueryInput
        liftAboveApps
        agentId="owner"
        topAttachment={banner}
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    </RoseAppsContext.Provider>
  );
  const view = renderWithProviders(tree(true));
  const box = within(screen.getByTestId('browser-query-input'));
  expect(box.queryByTestId('background-agents-banner')).toBeNull();
  expect(box.queryByText('Running 1 agent')).toBeNull();
  // The owner's own composer keeps the header.
  view.rerender(tree(false));
  expect(screen.getByTestId('background-agents-banner')).toBeInTheDocument();
});

it('sends from the Browser composer straight to its browser task', async () => {
  const onSubmit = vi.fn();
  const tree = (open: boolean) => (
    <RoseAppsContext.Provider value={browser(open ? {} : { openApp: null })}>
      <QueryInput
        liftAboveApps
        agentId="owner"
        value="go to instacart instead"
        onChange={vi.fn()}
        onSubmit={onSubmit}
      />
    </RoseAppsContext.Provider>
  );
  const view = renderWithProviders(tree(true));
  fireEvent.click(
    within(screen.getByTestId('browser-query-input')).getByRole('button', { name: 'Send' }),
  );
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith(undefined, { browserTaskId: 'browser-task' });
  // The owner's own composer keeps addressing the agent itself.
  onSubmit.mockClear();
  view.rerender(tree(false));
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith(undefined);

  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ message_id: 'm1' }), { status: 201 }));
  await postMessage('owner', 'go to instacart instead', undefined, {
    browserTaskId: 'browser-task',
  });
  const [url, init] = fetchSpy.mock.calls[0];
  expect(String(url)).toMatch(/\/agents\/owner\/messages$/);
  expect(JSON.parse(String(init?.body))).toEqual({
    message: 'go to instacart instead',
    browser_task_id: 'browser-task',
  });
  fetchSpy.mockRestore();
});

it('labels a Browser-composer message in the owner chat as sent to the Browser', () => {
  const row = (metadata: Record<string, unknown>) =>
    ({
      message_id: `m-${Object.keys(metadata).length}`,
      timestamp: '2026-10-26T15:59:40Z',
      role: 'USER',
      text: 'go to instacart instead',
      metadata,
    }) as Message;
  const view = renderWithProviders(
    <UserBubble message={row({ browserTaskId: 'browser-task', excludeFromModel: true })} />,
  );
  expect(screen.getByText('You → Browser:', { exact: false })).toBeVisible();
  // An attention reply tagged for the browser is still the owner's own message.
  view.rerender(<UserBubble message={row({ browserTaskId: 'browser-task' })} />);
  expect(screen.queryByText('You → Browser:', { exact: false })).toBeNull();
  expect(screen.getByText('go to instacart instead')).toBeVisible();
});

it('keeps the root composer controls when the Browser drawer is closed', () => {
  renderWithProviders(
    <RoseAppsContext.Provider value={browser({ openApp: null })}>
      <QueryInput liftAboveApps value="draft" onChange={vi.fn()} onSubmit={vi.fn()} />
    </RoseAppsContext.Provider>,
  );
  expect(screen.getByTestId('query-toolbar-nub')).toBeInTheDocument();
});

it('retains draft files when moving between the owner composer and Browser, and sends them once', async () => {
  const state = browser();
  const onSubmit = vi.fn();
  const tree = (open: boolean) => (
    <RoseAppsContext.Provider value={{ ...state, openApp: open ? 'browser' : null }}>
      <QueryInput
        liftAboveApps
        agentId="owner"
        value="draft"
        onChange={vi.fn()}
        onSubmit={onSubmit}
      />
    </RoseAppsContext.Provider>
  );
  const view = renderWithProviders(tree(false));
  fireEvent.change(document.querySelector('input[type=file]')!, {
    target: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
  });
  await waitFor(() => expect(screen.getByText('✓')).toBeInTheDocument());
  view.rerender(tree(true));
  const box = within(screen.getByTestId('browser-query-input'));
  expect(box.getByText('notes.txt')).toBeVisible();
  expect(box.getByRole('textbox')).toHaveValue('draft');
  fireEvent.click(box.getByRole('button', { name: 'Send' }));
  // Files only reach models through the owner agent, so they go untargeted.
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith([
    { id: 'file-pointer', original_filename: 'notes.txt' },
  ]);
});

it('keeps the native code composer usable on its original direct channel in Browser', () => {
  const nativeSubmit = vi.fn();
  renderWithProviders(
    <RoseAppsContext.Provider value={browser()}>
      <QueryInput
        liftAboveApps
        directChannel
        value="native draft"
        placeholder="Message Codex directly…"
        canSubmit
        onChange={vi.fn()}
        onSubmit={nativeSubmit}
      />
    </RoseAppsContext.Provider>,
  );
  const box = within(screen.getByTestId('browser-query-input'));
  expect(box.getByPlaceholderText('Message Codex directly…')).toHaveValue('native draft');
  expect(box.queryByText('Model unavailable')).toBeNull();
  expect(box.queryByPlaceholderText('Message Rose about this browser')).toBeNull();
  fireEvent.keyDown(box.getByRole('textbox'), { key: 'Enter' });
  expect(nativeSubmit).toHaveBeenCalledOnce();
});
