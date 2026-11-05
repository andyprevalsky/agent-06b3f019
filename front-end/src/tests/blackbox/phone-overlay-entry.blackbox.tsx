/** Legacy fullscreen entry: owned events open once; collapsed/foreign events remain idle. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { usePhoneFullscreenEntry } from '@/features/terminal-component-group/components/browser-status-bar/phone/usePhoneFullscreenEntry';
import { BrowserStatusBarFullscreen } from '@/features/terminal-component-group/components/browser-status-bar/BrowserStatusBarFullscreen';
import type { Message } from '@/features/terminal-component-group/hooks';
import { fixture as transport, props } from './fixtures/phone-attention.fixture';

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/lib/api/client', () => ({
  API_BASE_WITH_PATH: 'http://localhost:3001/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer synthetic-user' }),
}));
vi.mock('@/features/terminal-component-group/components/BrowserBorderGlow', () => ({
  default: () => null,
}));
vi.mock('@/features/terminal-component-group/components/BrowserCursorOverlay', () => ({
  default: () => null,
}));
vi.mock(
  '@/features/terminal-component-group/components/browser-status-bar/BrowserTaskProgressPanel',
  () => ({
    TaskProgressSidebar: () => <div>Task progress</div>,
  }),
);
vi.mock(
  '@/features/terminal-component-group/components/browser-status-bar/BrowserProxyLocationChip',
  () => ({
    BrowserProxyLocationChip: () => null,
  }),
);
const state = { expanded: true, fullscreen: false, messages: [] as Message[] };
export function Entry() {
  usePhoneFullscreenEntry(
    'task-a',
    state.messages,
    {
      isExpanded: state.expanded,
      isFullscreen: state.fullscreen,
    },
    false,
  );
  return state.fullscreen ? (
    <BrowserStatusBarFullscreen
      {...props()}
      messages={state.messages}
      isWaitingForAuthAssistance={false}
    />
  ) : null;
}
const event = (taskId: string): Message => ({
  message_id: 'phone-1',
  timestamp: 'now',
  role: 'TOOL',
  text: '',
  metadata: { task_id: taskId, toolName: 'phone' },
});
beforeEach(() => {
  Object.assign(state, { expanded: true, fullscreen: false, messages: [] });
  window.history.replaceState({}, '', '/');
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:entry');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('legacy expanded browser phone entry', () => {
  it('opens the real fullscreen once for owned activity and does not reopen on close', async () => {
    const f = transport();
    const open = vi.fn();
    window.addEventListener('navi-open-browser', open);
    try {
      state.messages = [event('task-a')];
      const view = render(<Entry />);
      expect(open).toHaveBeenCalledOnce();
      expect((open.mock.calls[0][0] as CustomEvent).detail.taskId).toBe('task-a');
      state.fullscreen = true;
      view.rerender(<Entry />);
      expect(await screen.findByRole('region', { name: 'Cloud iPhone' })).toBeVisible();
      await waitFor(() =>
        expect(screen.getByAltText('Cloud iPhone screen')).toHaveAttribute('src', 'blob:entry'),
      );
      expect(screen.getByTitle('Browser')).toBeInTheDocument();
      expect(f.calls.some((call) => call.endsWith('/interactions/task-a'))).toBe(true);
      state.fullscreen = false;
      view.rerender(<Entry />);
      expect(screen.queryByRole('region', { name: 'Cloud iPhone' })).toBeNull();
      expect(open).toHaveBeenCalledOnce();
      expect(URL.revokeObjectURL).toHaveBeenCalled();
    } finally {
      window.removeEventListener('navi-open-browser', open);
    }
  });
  it('keeps collapsed and foreign task activity passive', () => {
    const f = transport();
    const open = vi.fn();
    window.addEventListener('navi-open-browser', open);
    try {
      state.messages = [event('foreign')];
      const view = render(<Entry />);
      expect(open).not.toHaveBeenCalled();
      state.expanded = false;
      state.messages = [event('task-a')];
      view.rerender(<Entry />);
      expect(open).not.toHaveBeenCalled();
      expect(f.calls).toEqual([]);
      expect(screen.queryByTitle('Browser')).toBeNull();
    } finally {
      window.removeEventListener('navi-open-browser', open);
    }
  });
});
