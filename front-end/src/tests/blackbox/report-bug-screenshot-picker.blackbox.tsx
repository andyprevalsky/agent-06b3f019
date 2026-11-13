/**
 * Report Bug screenshot picker: #bug-report-screenshot-input picks several
 * images, shows removable thumbnails, and appends uploaded image links to the
 * description on submit (the report-bug request stays `{ description }`).
 * Picked thumbnails coexist with drag/drop: both count toward the pending
 * uploads that keep Submit disabled, and both reach the submitted description.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import ReportBugDialog from '@/features/terminal-component-group/components/ReportBugDialog';
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

describe('Report Bug screenshot picker', () => {
  afterEach(() => localStorage.clear());
  it('attaches several picked screenshots as removable thumbnails appended on submit', async () => {
    mockSession(ANDY_USER_ID);
    const u = userEvent.setup({ applyAccept: false });
    const uploads: string[] = [];
    let submitted: string | undefined;
    server.use(
      http.post(`${API_BASE}/agents/:agentId/report-bug/screenshots`, async ({ request }) => {
        const file = (await request.formData()).get('file') as File;
        uploads.push(file.type);
        const ext = file.type.split('/')[1];
        return HttpResponse.json(
          {
            success: true,
            name: `shot.${ext}`,
            url: `https://img.example/shot.${ext}`,
            expires_in: 1,
          },
          { status: 201 },
        );
      }),
      http.post(`${API_BASE}/agents/:agentId/report-bug`, async ({ request }) => {
        submitted = ((await request.json()) as { description?: string }).description;
        return HttpResponse.json(
          { success: true, name: 'Picked', url: 'https://boxes.dev/x', run_id: 'run-pick' },
          { status: 201 },
        );
      }),
    );

    renderWithProviders(<ReportBugDialog agent={makeAgent()} />);
    await u.click(screen.getByTestId('report-bug-trigger'));
    const textarea = (await screen.findByTestId('report-bug-description')) as HTMLTextAreaElement;
    await u.type(textarea, 'Picker case');

    const input = screen.getByTestId('bug-report-screenshot-input') as HTMLInputElement;
    expect(input).toHaveAttribute('id', 'bug-report-screenshot-input');
    expect(input).toHaveAttribute('type', 'file');
    expect(input.multiple).toBe(true);
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'first.png', {
      type: 'image/png',
    });
    const jpg = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'second.jpg', {
      type: 'image/jpeg',
    });
    const notes = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    await u.upload(input, [png, jpg, notes]);

    await waitFor(() => {
      const thumbs = screen.getAllByTestId('bug-report-screenshot-thumbnail');
      expect(thumbs).toHaveLength(2);
      thumbs.forEach((t) => expect(t).toHaveAttribute('data-status', 'ready'));
    });
    expect([...uploads].sort()).toEqual(['image/jpeg', 'image/png']);
    // Thumbnails never touch the typed description.
    expect(textarea.value).toBe('Picker case');

    await u.click(screen.getByRole('button', { name: 'Remove first.png' }));
    expect(screen.getAllByTestId('bug-report-screenshot-thumbnail')).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'second.jpg' })).toBeInTheDocument();

    await u.click(screen.getByTestId('report-bug-submit'));
    await waitFor(() => expect(submitted).toBeDefined());
    expect(submitted).toBe('Picker case\n\n![second.jpg](https://img.example/shot.jpeg)');
  });

  it('rejects oversized picked screenshots without uploading and submits the description unchanged', async () => {
    mockSession(ANDY_USER_ID);
    const u = userEvent.setup();
    const uploads: string[] = [];
    let submitted: string | undefined;
    server.use(
      http.post(`${API_BASE}/agents/:agentId/report-bug/screenshots`, async () => {
        uploads.push('called');
        return HttpResponse.json({ error: 'unexpected' }, { status: 500 });
      }),
      http.post(`${API_BASE}/agents/:agentId/report-bug`, async ({ request }) => {
        submitted = ((await request.json()) as { description?: string }).description;
        return HttpResponse.json(
          { success: true, name: 'Plain', url: 'https://boxes.dev/x', run_id: 'run-plain' },
          { status: 201 },
        );
      }),
    );

    renderWithProviders(<ReportBugDialog agent={makeAgent()} />);
    await u.click(screen.getByTestId('report-bug-trigger'));
    await u.type(await screen.findByTestId('report-bug-description'), 'No screenshots');

    const huge = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.png', {
      type: 'image/png',
    });
    await u.upload(screen.getByTestId('bug-report-screenshot-input'), huge);
    expect(screen.queryByTestId('bug-report-screenshot-thumbnail')).toBeNull();
    expect(uploads).toEqual([]);

    await u.click(screen.getByTestId('report-bug-submit'));
    await waitFor(() => expect(submitted).toBe('No screenshots'));
  });

  it('combines a dropped inline screenshot with a picked thumbnail and waits for both uploads', async () => {
    mockSession(ANDY_USER_ID);
    const u = userEvent.setup();
    let releasePicked: (() => void) | null = null;
    let submitted: string | undefined;
    server.use(
      http.post(`${API_BASE}/agents/:agentId/report-bug/screenshots`, async ({ request }) => {
        const file = (await request.formData()).get('file') as File;
        if (file.type === 'image/webp') {
          await new Promise<void>((resolve) => {
            releasePicked = resolve;
          });
          return HttpResponse.json(
            {
              success: true,
              name: 'picked.webp',
              url: 'https://img.example/p.webp',
              expires_in: 1,
            },
            { status: 201 },
          );
        }
        return HttpResponse.json(
          { success: true, name: 'dropped.png', url: 'https://img.example/d.png', expires_in: 1 },
          { status: 201 },
        );
      }),
      http.post(`${API_BASE}/agents/:agentId/report-bug`, async ({ request }) => {
        submitted = ((await request.json()) as { description?: string }).description;
        return HttpResponse.json(
          { success: true, name: 'Both', url: 'https://boxes.dev/x', run_id: 'run-both' },
          { status: 201 },
        );
      }),
    );

    renderWithProviders(<ReportBugDialog agent={makeAgent()} />);
    await u.click(screen.getByTestId('report-bug-trigger'));
    const textarea = (await screen.findByTestId('report-bug-description')) as HTMLTextAreaElement;
    await u.type(textarea, 'Combined case');

    const picked = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'picked.webp', {
      type: 'image/webp',
    });
    await u.upload(screen.getByTestId('bug-report-screenshot-input'), picked);
    const dropped = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'dropped.png', {
      type: 'image/png',
    });
    fireEvent.drop(textarea, { dataTransfer: { files: [dropped], types: ['Files'] } });

    await waitFor(() =>
      expect(textarea.value).toBe('Combined case\n![dropped.png](https://img.example/d.png)\n'),
    );
    expect(screen.getByTestId('bug-report-screenshot-thumbnail')).toHaveAttribute(
      'data-status',
      'uploading',
    );
    expect(screen.getByTestId('report-bug-screenshot-hint')).toHaveTextContent(
      'Uploading 1 screenshot…',
    );
    expect(screen.getByTestId('report-bug-submit')).toBeDisabled();

    await waitFor(() => expect(releasePicked).not.toBeNull());
    releasePicked!();
    await waitFor(() =>
      expect(screen.getByTestId('bug-report-screenshot-thumbnail')).toHaveAttribute(
        'data-status',
        'ready',
      ),
    );
    expect(screen.getByTestId('report-bug-submit')).toBeEnabled();

    await u.click(screen.getByTestId('report-bug-submit'));
    await waitFor(() =>
      expect(submitted).toBe(
        'Combined case\n![dropped.png](https://img.example/d.png)\n\n![picked.webp](https://img.example/p.webp)',
      ),
    );
  });
});
