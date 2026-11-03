/**
 * Blackbox tests for AgentSettingsDialog.
 * Covers open/close, no-agent state, metrics rendering, price-limit edit/save/cancel,
 * response-schema rendering, the 1.8s delete-confirmation timer (stock gear only; the
 * Rose Desktop drawer panel has no Delete Agent), admin Report bug as its own control
 * outside Agent Settings (including dragged / pasted screenshots), and the panel's anchor direction: the
 * Rose Desktop tab gear (left side of the query box) opens the panel rightward from
 * the gear, staying inside the viewport; the stock right-side gear opens it leftward.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import AgentSettingsDialog from '@/features/terminal-component-group/components/AgentSettingsDialog';
import ReportBugDialog from '@/features/terminal-component-group/components/ReportBugDialog';
import QueryInput from '@/features/terminal-component-group/components/QueryInput';
import type { AgentDetail } from '@/lib/api';

const API_BASE = 'http://localhost:3001/api';
const ANDY_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

function mockSession(userId = 'test-user') {
  const isAdmin = userId === ANDY_USER_ID;
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: userId, is_anonymous: false, phone: isAdmin ? '+19729777432' : undefined },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem(
    'app-user',
    JSON.stringify({
      id: userId,
      is_anonymous: false,
      phone: isAdmin ? '+19729777432' : undefined,
    }),
  );
}

function makeAgent(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent_id: 'agent-xyz',
    goal: 'Test',
    model: 'rose-1-flash',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 0.5,
    status: 'ACTIVE',
    status_message: null,
    temporal_workflow_id: 'wf-1',
    token_count: 1000,
    tokens_in: 500,
    tokens_out: 300,
    tool_tokens_in: 100,
    tool_tokens_out: 50,
    tool_cost_cents: 10,
    context_size: 20_000,
    message_count: 7,
    price_limit_cents: 500,
    tree_cost_cents: 25,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    write_lock_enabled: false,
    parent_agent_id: null,
    parent_goal: null,
    verifier: null,
    tools: [],
    response_schema: null,
    ...overrides,
  } as AgentDetail;
}

describe('AgentSettingsDialog', () => {
  beforeEach(() => {
    mockSession();
    clearCaptures();
    vi.useRealTimers();
  });
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('renders the settings trigger button', () => {
    renderWithProviders(<AgentSettingsDialog agent={makeAgent()} />);
    const trigger = document.querySelector('button');
    expect(trigger).not.toBeNull();
    // lucide Settings icon
    expect(document.querySelector('svg.lucide-settings')).not.toBeNull();
  });

  it('shows the empty state when agent is null', async () => {
    const u = userEvent.setup();
    renderWithProviders(<AgentSettingsDialog agent={null} />);
    await u.click(document.querySelector('button')!);
    await waitFor(() => {
      expect(screen.getByText(/create an agent to view agent settings/)).toBeInTheDocument();
    });
  });

  it('renders metrics (messages / tokens / cost) when opened', async () => {
    const u = userEvent.setup();
    renderWithProviders(<AgentSettingsDialog agent={makeAgent()} />);
    await u.click(document.querySelector('button')!);
    await waitFor(() => {
      expect(screen.getByText('Metrics')).toBeInTheDocument();
    });
    expect(screen.getByText('Messages')).toBeInTheDocument();
    // message_count displayed
    expect(screen.getByText('7')).toBeInTheDocument();
    // tokens combined: 500+100 / 300+50 = 600 / 350
    expect(screen.getByText(/600 \/ 350/)).toBeInTheDocument();
    // cost: 25c → $0.25 appears for both main "Cost" metric and tree-cost subrow
    expect(screen.getAllByText('$0.25').length).toBeGreaterThan(0);
  });

  it('copies the labeled agent ID from the debug row', async () => {
    mockSession(ANDY_USER_ID);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const u = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    renderWithProviders(<AgentSettingsDialog agent={makeAgent()} />);
    await u.click(document.querySelector('button')!);

    expect(screen.getByText('Agent ID')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Copy agent ID' }));
    expect(writeText).toHaveBeenCalledWith('agent-id: <agent-xyz>');
  });

  it('renders response schema fields when provided', async () => {
    const u = userEvent.setup();
    renderWithProviders(
      <AgentSettingsDialog
        agent={makeAgent({
          response_schema: {
            fields: [
              {
                name: 'title',
                type: 'str',
                required: true,
                minLength: 4,
                maxLength: 80,
                description: 'Article title',
              },
              { name: 'count', type: 'int', required: false, description: 'Count thing' },
              {
                name: 'rows',
                type: 'list[object]',
                required: true,
                minItems: 2,
                maxItems: 2,
                properties: [{ name: 'note', type: 'str', required: false }],
              },
            ],
          },
        })}
      />,
    );
    await u.click(document.querySelector('button')!);
    await waitFor(() => {
      expect(screen.getByText('Output Schema')).toBeInTheDocument();
    });
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText('string')).toBeInTheDocument();
    expect(screen.getAllByText('required')).toHaveLength(2);
    expect(screen.getByText('count')).toBeInTheDocument();
    expect(screen.getByText('integer')).toBeInTheDocument();
    expect(screen.getByText('at least 4 characters · at most 80 characters')).toBeInTheDocument();
    expect(screen.getByText('exactly 2 items')).toBeInTheDocument();
    expect(screen.getByText('note: string · optional')).toBeInTheDocument();
    expect(screen.getAllByText('optional')).toHaveLength(1);
  });

  it('shows "Schema generating..." when no response schema', async () => {
    const u = userEvent.setup();
    renderWithProviders(<AgentSettingsDialog agent={makeAgent({ response_schema: null })} />);
    await u.click(document.querySelector('button')!);
    await waitFor(() => {
      expect(screen.getByText('Schema generating...')).toBeInTheDocument();
    });
  });

  it('enters price-limit edit mode and updates input value', async () => {
    const u = userEvent.setup();
    renderWithProviders(<AgentSettingsDialog agent={makeAgent({ price_limit_cents: 250 })} />);
    await u.click(document.querySelector('button')!);

    // Price limit button shows "$2.50" — match first (sub-row with same value exists)
    const priceBtn = (await screen.findAllByText('$2.50'))[0];
    await u.click(priceBtn);

    // Now an input + Save button appear
    const input = screen.getByPlaceholderText('1.00') as HTMLInputElement;
    expect(input.value).toBe('2.50');

    await u.clear(input);
    await u.type(input, '9.99');
    expect(input.value).toBe('9.99');

    // Save button present
    expect(screen.getByRole('button', { name: /Save/ })).toBeInTheDocument();
  });

  it('saves a new price limit via PATCH /api/agents/:id', async () => {
    const u = userEvent.setup();
    server.use(
      http.patch(`${API_BASE}/agents/:agentId`, () => {
        return HttpResponse.json({ agent: { price_limit_cents: 999 } });
      }),
    );
    const onUpdate = vi.fn();
    renderWithProviders(
      <AgentSettingsDialog agent={makeAgent({ price_limit_cents: 250 })} onUpdate={onUpdate} />,
    );
    await u.click(document.querySelector('button')!);
    await u.click((await screen.findAllByText('$2.50'))[0]);

    const input = screen.getByPlaceholderText('1.00') as HTMLInputElement;
    await u.clear(input);
    await u.type(input, '9.99');
    await u.keyboard('{Enter}');

    await waitFor(() => {
      const req = capturedRequests.find(
        (r) => r.method === 'PATCH' && r.url.includes('/api/agents/'),
      );
      expect(req).toBeDefined();
      expect((req!.body as Record<string, unknown>).price_limit_cents).toBe(999);
    });
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  });

  it('rejects price limit lower than tree_cost_cents', async () => {
    const u = userEvent.setup();
    renderWithProviders(
      <AgentSettingsDialog agent={makeAgent({ price_limit_cents: 500, tree_cost_cents: 300 })} />,
    );
    await u.click(document.querySelector('button')!);
    await u.click((await screen.findAllByText('$5.00'))[0]);

    const input = screen.getByPlaceholderText('1.00') as HTMLInputElement;
    await u.clear(input);
    await u.type(input, '0.50'); // below 300c = $3.00
    await u.keyboard('{Enter}');

    // No PATCH request fires
    await new Promise((r) => setTimeout(r, 50));
    const req = capturedRequests.find(
      (r) => r.method === 'PATCH' && r.url.includes('/api/agents/'),
    );
    expect(req).toBeUndefined();
  });

  it('shows delete confirmation and enables confirm after 1.8s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const u = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<AgentSettingsDialog agent={makeAgent()} />);
    await u.click(document.querySelector('button')!);

    const deleteBtn = await screen.findByRole('button', { name: /Delete Agent/ });
    await u.click(deleteBtn);

    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
    // Initially the confirm button shows "Wait..."
    expect(screen.getByRole('button', { name: /Wait/ })).toBeDisabled();

    // Advance past 1.8s
    vi.advanceTimersByTime(2000);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Delete$/ })).toBeEnabled();
    });
    vi.useRealTimers();
  });

  it('cancel button returns to idle state without calling delete', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const u = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<AgentSettingsDialog agent={makeAgent()} />);
    await u.click(document.querySelector('button')!);

    const deleteBtn = await screen.findByRole('button', { name: /Delete Agent/ });
    await u.click(deleteBtn);
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();

    const cancelBtn = screen.getByRole('button', { name: /Cancel/ });
    await u.click(cancelBtn);

    expect(screen.queryByText('Are you sure?')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('hides price-limit section for sub-agents (parent_agent_id set)', async () => {
    const u = userEvent.setup();
    renderWithProviders(
      <AgentSettingsDialog agent={makeAgent({ parent_agent_id: 'parent-001' })} />,
    );
    await u.click(document.querySelector('button')!);
    await waitFor(() => {
      expect(screen.getByText('Metrics')).toBeInTheDocument();
    });
    expect(screen.queryByText('Price Limit')).not.toBeInTheDocument();
  });

  it('hides the Report bug control for non-admin users', () => {
    renderWithProviders(<ReportBugDialog agent={makeAgent()} />);
    expect(screen.queryByTestId('report-bug-trigger')).toBeNull();
  });

  it('opens Report Bug composer and submits description for admins', async () => {
    mockSession(ANDY_USER_ID);
    const u = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    server.use(
      http.post(`${API_BASE}/agents/:agentId/report-bug`, async ({ request, params }) => {
        const body = (await request.json()) as { description?: string };
        expect(params.agentId).toBe('agent-xyz');
        expect(body.description).toBe('Checkout never finished');
        return HttpResponse.json(
          {
            success: true,
            name: 'Checkout never finished',
            url: 'https://boxes.dev/open/desktop?box=rose&automation=ta_bug',
            run_id: 'run-bug-1',
          },
          { status: 201 },
        );
      }),
    );

    renderWithProviders(<ReportBugDialog agent={makeAgent()} />);
    await u.click(screen.getByTestId('report-bug-trigger'));

    const textarea = await screen.findByTestId('report-bug-description');
    expect(screen.queryByText(/SMS/i)).toBeNull();
    await u.type(textarea, 'Checkout never finished');
    await u.click(screen.getByTestId('report-bug-submit'));

    await waitFor(() => {
      expect(
        capturedRequests.some((r) => r.method === 'POST' && r.url.includes('/report-bug')),
      ).toBe(true);
    });
    // Sticky launched panel with an explicit Open button. Submit must not
    // auto-open boxes.dev — that is a user gesture, not a side effect of report.
    expect(await screen.findByTestId('report-bug-launched')).toBeInTheDocument();
    expect(screen.getByTestId('report-bug-url')).toHaveAttribute(
      'href',
      'https://boxes.dev/open/desktop?box=rose&automation=ta_bug',
    );
    expect(screen.getByText('Checkout never finished')).toBeInTheDocument();
    expect(screen.queryByText(/Bug \|/)).toBeNull();
    expect(screen.getByText('boxes.dev agent launched')).toBeInTheDocument();
    expect(screen.getByTestId('report-bug-open-link')).toHaveTextContent('Open in boxes.dev');
    expect(screen.queryByText(/Cursor/)).toBeNull();
    expect(screen.queryByText(/SMS/i)).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();

    await u.click(screen.getByTestId('report-bug-open-link'));
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      'https://boxes.dev/open/desktop?box=rose&automation=ta_bug',
      '_blank',
      'noopener,noreferrer',
    );

    openSpy.mockRestore();
  });

  it('keeps the composer open with the error when the boxes.dev run is rejected', async () => {
    mockSession(ANDY_USER_ID);
    const u = userEvent.setup();
    server.use(
      http.post(`${API_BASE}/agents/:agentId/report-bug`, async () => {
        return HttpResponse.json(
          { error: 'boxes.dev bug report automation is not configured' },
          { status: 503 },
        );
      }),
    );

    renderWithProviders(<ReportBugDialog agent={makeAgent()} />);
    await u.click(screen.getByTestId('report-bug-trigger'));
    const textarea = await screen.findByTestId('report-bug-description');
    await u.type(textarea, 'Unconfigured case');
    await u.click(screen.getByTestId('report-bug-submit'));

    await waitFor(() => {
      expect(
        capturedRequests.some((r) => r.method === 'POST' && r.url.includes('/report-bug')),
      ).toBe(true);
    });
    // Submit re-enables once the rejected request settles; nothing claims a launch.
    await waitFor(() => {
      expect(screen.getByTestId('report-bug-submit')).toBeEnabled();
    });
    expect(screen.queryByTestId('report-bug-launched')).toBeNull();
    expect(screen.getByTestId('report-bug-description')).toHaveValue('Unconfigured case');
  });

  it('uploads a dropped screenshot and submits it as an image link in the description', async () => {
    mockSession(ANDY_USER_ID);
    const u = userEvent.setup();
    const signedUrl =
      'https://kzlurqihzaolhzsbkctf.supabase.co/storage/v1/object/sign/attachments/u/1_live-view.png?token=t';
    // jsdom Files reach MSW through undici as Blobs named "blob", so assert the
    // type here and let the mock answer with the backend's original filename.
    const uploads: Array<{ agentId: string; type: string }> = [];
    let releaseUpload: (() => void) | null = null;
    let submitted: string | undefined;
    server.use(
      http.post(
        `${API_BASE}/agents/:agentId/report-bug/screenshots`,
        async ({ request, params }) => {
          const form = await request.formData();
          const file = form.get('file') as File;
          uploads.push({ agentId: String(params.agentId), type: file.type });
          await new Promise<void>((resolve) => {
            releaseUpload = resolve;
          });
          return HttpResponse.json(
            { success: true, name: 'live-view.png', url: signedUrl, expires_in: 604_800 },
            { status: 201 },
          );
        },
      ),
      http.post(`${API_BASE}/agents/:agentId/report-bug`, async ({ request }) => {
        submitted = ((await request.json()) as { description?: string }).description;
        return HttpResponse.json(
          { success: true, name: 'Live view', url: 'https://boxes.dev/x', run_id: 'run-shot' },
          { status: 201 },
        );
      }),
    );

    renderWithProviders(<ReportBugDialog agent={makeAgent()} />);
    await u.click(screen.getByTestId('report-bug-trigger'));
    const textarea = (await screen.findByTestId('report-bug-description')) as HTMLTextAreaElement;
    expect(screen.getByTestId('report-bug-screenshot-hint')).toHaveTextContent(
      'Drag, drop or paste screenshots',
    );
    await u.type(textarea, 'Live view shows a closed session');

    const screenshot = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'live-view.png', {
      type: 'image/png',
    });
    fireEvent.drop(textarea, { dataTransfer: { files: [screenshot], types: ['Files'] } });

    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]).toEqual({ agentId: 'agent-xyz', type: 'image/png' });
    expect(textarea.value).toBe(
      'Live view shows a closed session\n![Uploading live-view.png #1…]()\n',
    );
    expect(screen.getByTestId('report-bug-screenshot-hint')).toHaveTextContent(
      'Uploading 1 screenshot…',
    );
    expect(screen.getByTestId('report-bug-submit')).toBeDisabled();

    releaseUpload!();
    await waitFor(() =>
      expect(textarea.value).toBe(
        `Live view shows a closed session\n![live-view.png](${signedUrl})\n`,
      ),
    );
    expect(screen.getByTestId('report-bug-submit')).toBeEnabled();

    await u.click(screen.getByTestId('report-bug-submit'));
    await waitFor(() =>
      expect(submitted).toBe(`Live view shows a closed session\n![live-view.png](${signedUrl})`),
    );
  });

  it('attaches a pasted screenshot and ignores dropped non-image files', async () => {
    mockSession(ANDY_USER_ID);
    const u = userEvent.setup();
    const uploads: string[] = [];
    server.use(
      http.post(`${API_BASE}/agents/:agentId/report-bug/screenshots`, async ({ request }) => {
        const file = (await request.formData()).get('file') as File;
        uploads.push(file.type);
        return HttpResponse.json(
          {
            success: true,
            name: 'clipboard.jpg',
            url: 'https://img.example/clipboard.jpg',
            expires_in: 1,
          },
          { status: 201 },
        );
      }),
    );

    renderWithProviders(<ReportBugDialog agent={makeAgent()} />);
    await u.click(screen.getByTestId('report-bug-trigger'));
    const textarea = (await screen.findByTestId('report-bug-description')) as HTMLTextAreaElement;

    const notes = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    fireEvent.drop(textarea, { dataTransfer: { files: [notes], types: ['Files'] } });
    const pasted = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'clipboard.jpg', {
      type: 'image/jpeg',
    });
    fireEvent.paste(textarea, { clipboardData: { files: [pasted], types: ['Files'] } });

    await waitFor(() =>
      expect(textarea.value).toBe('![clipboard.jpg](https://img.example/clipboard.jpg)\n'),
    );
    expect(uploads).toEqual(['image/jpeg']);
  });
});

// ─── Anchor direction (UI #20): the panel opens away from its gear's side ────

const queryProps = {
  value: '',
  onChange: vi.fn(),
  onSubmit: vi.fn(),
  selectedModel: 'rose-labs/rose-1-flash',
  availableModels: [
    { id: 'rose-labs/rose-1-flash', name: 'rose-fast', provider: 'rose-labs', description: 'fast' },
  ],
};

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

/** Pin the opener's on-screen rect (jsdom has no layout). */
function placeOpener(el: Element, box: Box) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    ...box,
    x: box.left,
    y: box.top,
    width: box.right - box.left,
    height: box.bottom - box.top,
    toJSON: () => box,
  } as DOMRect);
}

/** The panel's horizontal extent from its fixed-position inline style. */
function panelX(panel: HTMLElement): { left: number; right: number } {
  const vw = window.innerWidth;
  const max = panel.style.maxWidth.endsWith('vw')
    ? (parseFloat(panel.style.maxWidth) / 100) * vw
    : Infinity;
  const width = Math.min(parseFloat(panel.style.width), max);
  const left =
    panel.style.left && panel.style.left !== 'auto'
      ? parseFloat(panel.style.left)
      : vw - parseFloat(panel.style.right) - width;
  return { left, right: left + width };
}

describe('AgentSettingsDialog anchor direction (UI #20)', () => {
  const realWidth = window.innerWidth;
  const realHeight = window.innerHeight;
  beforeEach(() => mockSession());
  afterEach(() => {
    setViewport(realWidth, realHeight);
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function openRoseDesktopSettings(gearBox: Box) {
    renderWithProviders(<QueryInput {...queryProps} agentDetail={makeAgent()} />, {
      roseDesktop: true,
    });
    const gear = within(screen.getByTestId('query-toolbar-nub')).getByLabelText('Agent settings');
    placeOpener(gear, gearBox);
    fireEvent.click(gear);
    return screen.findByRole('dialog');
  }

  it('Rose Desktop tab gear (left of the box): opens rightward from the gear, above it', async () => {
    setViewport(1280, 800);
    const gear = { left: 180, right: 192, top: 690, bottom: 708 };
    const panel = await openRoseDesktopSettings(gear);
    expect(within(panel).getByText('Agent Settings')).toBeInTheDocument();
    await waitFor(() => expect(panelX(panel).left).toBe(gear.left));
    const x = panelX(panel);
    // Left edges aligned; the panel grows to the right of the gear, on screen.
    expect(x.right).toBeGreaterThan(gear.right);
    expect(x.left).toBeGreaterThanOrEqual(0);
    expect(x.right).toBeLessThanOrEqual(1280);
    // Grows upward from just above the gear.
    expect(panel.style.bottom).toBe(`${800 - gear.top + 8}px`);
    expect(panel.style.top).toBe('auto');
  });

  it('narrow viewport: shifts left only as far as needed to stay on screen', async () => {
    setViewport(375, 700);
    const gear = { left: 150, right: 162, top: 600, bottom: 618 };
    const panel = await openRoseDesktopSettings(gear);
    await waitFor(() => expect(panelX(panel).right).toBeLessThanOrEqual(375));
    const x = panelX(panel);
    expect(x.left).toBeGreaterThanOrEqual(0);
    // Still spans the gear, extending right of it.
    expect(x.left).toBeLessThanOrEqual(gear.left);
    expect(x.right).toBeGreaterThan(gear.right);
  });

  it('opener near the right edge: never runs off the right side', async () => {
    setViewport(1024, 768);
    const gear = { left: 900, right: 912, top: 700, bottom: 718 };
    const panel = await openRoseDesktopSettings(gear);
    await waitFor(() => expect(panelX(panel).right).toBeLessThanOrEqual(1024));
    expect(panelX(panel).left).toBeGreaterThanOrEqual(0);
  });

  it('stock right-side gear keeps opening leftward (right edges aligned)', async () => {
    setViewport(1280, 800);
    renderWithProviders(<QueryInput {...queryProps} agentDetail={makeAgent()} />, {
      roseDesktop: false,
    });
    const gear = document.querySelector('svg.lucide-settings')!.closest('button')!;
    const box = { left: 1180, right: 1208, top: 690, bottom: 718 };
    placeOpener(gear, box);
    fireEvent.click(gear);
    const panel = await screen.findByRole('dialog');
    await waitFor(() => expect(panelX(panel).right).toBe(box.right));
    expect(panelX(panel).left).toBeGreaterThanOrEqual(0);
  });
});
