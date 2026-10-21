/** Browser composition stays on the existing owner channel without exposing root controls. */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import QueryInput from '@/features/terminal-component-group/components/QueryInput';
import {
  RoseAppsContext,
  type RoseAppsValue,
} from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
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
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith([
    { id: 'file-pointer', original_filename: 'notes.txt' },
  ]);
});

it('never ports a native direct-channel composer into the owner Browser slot', () => {
  renderWithProviders(
    <RoseAppsContext.Provider value={browser()}>
      <QueryInput
        liftAboveApps
        directChannel
        value="native draft"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    </RoseAppsContext.Provider>,
  );
  expect(screen.queryByTestId('browser-query-input')).toBeNull();
});
