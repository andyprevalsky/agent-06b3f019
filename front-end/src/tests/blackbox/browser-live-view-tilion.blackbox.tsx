/**
 * Tilion live-view coverage (validation criteria D1/D2 in
 * docs/plans/active/tilion-browser-provider.md). Fixtures mirror
 * browser-live-view-binding.blackbox.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, waitFor, renderHook } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

vi.mock('@/features/terminal-component-group/components/MessageList', () => {
  const MessageListStub = () => <div data-testid="message-list-stub" />;
  return { MessageList: MessageListStub, default: MessageListStub };
});
vi.mock('@/features/terminal-component-group/components/BrowserBorderGlow', () => ({
  default: () => null,
}));
vi.mock('@/features/terminal-component-group/components/BrowserCursorOverlay', () => ({
  default: () => null,
}));
vi.mock('@/components/ThinkingAnimation', () => ({
  default: () => null,
}));

import BrowserStatusBar from '@/features/terminal-component-group/components/BrowserStatusBar';
import { useBrowserSessionBinding } from '@/features/terminal-component-group/components/browser-status-bar/useBrowserSessionBinding';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context/types';
import type { Message } from '@/lib/api';
import {
  publishBrowserSessionBinding,
  type BrowserSessionBinding,
} from '@/lib/browserSessionBindings';

const API_BASE = 'http://localhost:3001/api';
const TASK_ID = 'e264ec23-538b-50bb-9874-30c9830a49d8';

function binding(
  debugUrl: string,
  asOf: number,
  overrides: Partial<BrowserSessionBinding> = {},
): BrowserSessionBinding {
  return {
    taskId: TASK_ID,
    sessionId: debugUrl,
    debugUrl,
    status: 'ACTIVE',
    live: true,
    asOf,
    ...overrides,
  };
}

function browserMessage(
  id: string,
  timestamp: string,
  metadata: Record<string, unknown>,
  text = '',
): Message {
  return {
    message_id: id,
    timestamp,
    text,
    role: 'TOOL',
    metadata: {
      toolName: 'spawn_browser_agent',
      task_id: TASK_ID,
      subAgentId: TASK_ID,
      ...metadata,
    },
  } as Message;
}

function agentContext(messages: Message[]): AgentContextValue {
  return {
    agent: null,
    applyAgentDetail: vi.fn(() => true),
    selectedAgentId: '8b4d4592-c5da-4889-8a01-52824db125d1',
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

function liveIframe(): HTMLIFrameElement | null {
  return document.querySelector('iframe[title="Browser"]');
}

/** Serve GET .../live-view; returns the read counter. */
function serveLiveView(read: () => BrowserSessionBinding | Promise<BrowserSessionBinding>) {
  const reads = { count: 0 };
  server.use(
    http.get(`${API_BASE}/browser-session/task/:taskId/live-view`, async ({ params }) => {
      expect(params.taskId).toBe(TASK_ID);
      reads.count += 1;
      return HttpResponse.json(await read());
    }),
  );
  return reads;
}

const sessionInit = (url: string) =>
  browserMessage(
    'init-1',
    '2026-10-08T18:20:26.721Z',
    {
      toolCallId: '9eb9b329-36a1-4c4c-a46d-5075cd87078c',
      toolStatus: 'FINISHED',
      action_type: 'session_init',
      title: 'Browser session ready',
      browser_url: url,
    },
    'Browser session connected and ready.',
  );

/**
 * Tilion viewer pages carry a view token that expires 1800 s after mint, and
 * every backend live-view read mints a new one. The panel must keep one URL
 * per session (no iframe reload on each focus read), re-mint before expiry,
 * adopt a new session at once, and never log the token.
 */
describe('Tilion live-view token lifecycle', () => {
  const TILION_SESSION = 'sess_3d245e56b86d4bc8ae32095b644117d4';
  const ROTATED_SESSION = 'sess_6ac44536ab704d77b335f09ca281ada1';
  const tilionUrl = (session: string, token: string) =>
    `https://back.tilion.dev/v1/session/${session}/live-view?token=${token}`;

  beforeEach(() => {
    const session = {
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: 'test-user', is_anonymous: false },
    };
    localStorage.setItem('rose-session', JSON.stringify(session));
    localStorage.setItem('app-user', JSON.stringify(session.user));
    window.history.replaceState({}, '', `/?browser-id=${TASK_ID}`);
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  function renderBinding(transcriptUrl: string) {
    return renderHook(() => useBrowserSessionBinding(TASK_ID, transcriptUrl));
  }

  it('holds the URL across re-minting reads and refreshes it before the token expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let mint = 0;
    const reads = serveLiveView(() => {
      mint += 1;
      return binding(tilionUrl(TILION_SESSION, `tok-${mint}`), Date.now());
    });
    const { result } = renderBinding(tilionUrl(TILION_SESSION, 'transcript-stale'));

    await waitFor(() => expect(result.current.browserUrl).toBe(tilionUrl(TILION_SESSION, 'tok-1')));

    // A focus read mints tok-2; the shown URL stays on tok-1 (no iframe reload).
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(reads.count).toBe(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.browserUrl).toBe(tilionUrl(TILION_SESSION, 'tok-1'));

    // 24 minutes in: still held, no timer read yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24 * 60_000);
    });
    expect(reads.count).toBe(2);
    expect(result.current.browserUrl).toBe(tilionUrl(TILION_SESSION, 'tok-1'));

    // 25 minutes: the panel re-mints well before the 30-minute expiry.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await waitFor(() => expect(reads.count).toBe(3));
    await waitFor(() => expect(result.current.browserUrl).toBe(tilionUrl(TILION_SESSION, 'tok-3')));
  });

  it('adopts a rotated Tilion session immediately and reports an expired session as not live', async () => {
    serveLiveView(() => binding(tilionUrl(TILION_SESSION, 'tok-a'), 1));
    const { result } = renderBinding(tilionUrl(TILION_SESSION, 'transcript'));
    await waitFor(() => expect(result.current.browserUrl).toBe(tilionUrl(TILION_SESSION, 'tok-a')));

    act(() => publishBrowserSessionBinding(binding(tilionUrl(ROTATED_SESSION, 'tok-b'), 2)));
    await waitFor(() =>
      expect(result.current.browserUrl).toBe(tilionUrl(ROTATED_SESSION, 'tok-b')),
    );
    expect(result.current.isLive).toBe(true);

    act(() =>
      publishBrowserSessionBinding(
        binding(tilionUrl(ROTATED_SESSION, 'tok-c'), 3, { status: 'CLOSED', live: false }),
      ),
    );
    await waitFor(() => expect(result.current.isLive).toBe(false));
  });

  it('retries a failed refresh and never logs the view token', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = false;
    const reads = { count: 0 };
    server.use(
      http.get(`${API_BASE}/browser-session/task/:taskId/live-view`, () => {
        reads.count += 1;
        if (fail) return new HttpResponse(null, { status: 503 });
        return HttpResponse.json(
          binding(tilionUrl(TILION_SESSION, `secret-${reads.count}`), Date.now()),
        );
      }),
    );
    const { result } = renderBinding(tilionUrl(TILION_SESSION, 'secret-transcript'));
    await waitFor(() =>
      expect(result.current.browserUrl).toBe(tilionUrl(TILION_SESSION, 'secret-1')),
    );

    fail = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25 * 60_000);
    });
    await waitFor(() => expect(reads.count).toBe(2));
    fail = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await waitFor(() => expect(reads.count).toBe(3));
    await waitFor(() =>
      expect(result.current.browserUrl).toBe(tilionUrl(TILION_SESSION, 'secret-3')),
    );
    const logged = JSON.stringify(errors.mock.calls.map((call) => call.map(String)));
    expect(logged).not.toContain('secret-');
    expect(logged).not.toContain('token=');
    errors.mockRestore();
  });

  it('keeps a foreign read-only Tilion view inert with its token intact', async () => {
    const url = tilionUrl(TILION_SESSION, 'tok-ro');
    serveLiveView(() => binding(url, 1));
    server.use(
      http.get(`${API_BASE}/browser-session/task/:taskId/control`, () =>
        HttpResponse.json({ state: 'agent', agentPaused: false, debugUrl: url }),
      ),
    );
    const context = agentContext([sessionInit(url)]);
    context.inspectionContext = {
      user_id: 'c49b4ce3-3489-499d-bfbd-846d04ba6275',
      name: 'Tamara',
      phone: null,
      email: null,
    };
    renderWithProviders(
      <AgentContext.Provider value={context}>
        <BrowserStatusBar taskId={TASK_ID} browserUrl={url} />
      </AgentContext.Provider>,
    );
    await waitFor(() => expect(liveIframe()).toBeInTheDocument());
    expect(liveIframe()).toHaveAttribute('inert');
    expect(liveIframe()).toHaveAttribute('tabindex', '-1');
    const src = new URL(liveIframe()!.src);
    expect(src.origin + src.pathname).toBe(
      `https://back.tilion.dev/v1/session/${TILION_SESSION}/live-view`,
    );
    expect(src.searchParams.get('token')).toBe('tok-ro');
    // Embedded viewer: page-only image (no Tilion bar/padding), so the cursor
    // geometry (1366x625 page, contain top-left) holds at any pane size.
    expect(src.searchParams.get('embed')).toBe('1');
    expect(
      document.querySelector<HTMLElement>('[data-testid="live-view-stream"]')?.style.aspectRatio,
    ).toBe('1366 / 625');
    // Tilion streams the page only: no Steel chrome crop transform.
    expect(liveIframe()!.style.transform).toBe('');
  });
});
