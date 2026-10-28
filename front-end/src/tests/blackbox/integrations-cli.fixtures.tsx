import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import Integrations from '@/pages/Integrations';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

const API_BASE = 'http://localhost:3001/api';

export function registerCliIntegrationTests() {
  // CLI setup is a server-owned verification flow, shared by both presentations.
  describe.each([false, true])('CLI integrations (desktop=%s)', (roseDesktop) => {
    const settingUp = {
      id: 'cli-yc',
      name: 'YC CLI',
      request: 'YC CLI',
      status: 'setting_up',
      agent_id: 'yc-setup-agent',
      error: null,
    };
    beforeEach(() => {
      window.history.replaceState({}, '', '/');
      mockSession();
      server.use(
        http.get(`${API_BASE}/integrations`, () => HttpResponse.json({ integrations: [] })),
        http.get(`${API_BASE}/compute-accounts`, () => HttpResponse.json({ accounts: [] })),
        http.get(`${API_BASE}/integrations/cli`, () => HttpResponse.json({ integrations: [] })),
      );
    });
    afterEach(() => {
      localStorage.clear();
      vi.useRealTimers();
    });

    it('starts the requested CLI once with authentication and opens its setup agent', async () => {
      let submitted: Record<string, unknown> | undefined;
      let authorization: string | null = null;
      server.use(
        http.post(`${API_BASE}/integrations/cli`, async ({ request }) => {
          submitted = (await request.json()) as Record<string, unknown>;
          authorization = request.headers.get('Authorization');
          return HttpResponse.json({ integration: settingUp });
        }),
      );
      renderWithProviders(<Integrations />, { roseDesktop });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Add CLI' }));
      expect(screen.getByAltText('Claude')).toBeVisible();
      expect(screen.getByLabelText('Enter the CLI you want to connect')).toHaveFocus();
      await user.type(screen.getByLabelText('Enter the CLI you want to connect'), 'YC CLI');
      await user.click(screen.getByRole('button', { name: 'Connect' }));
      expect(await screen.findByText('Setting up…')).toBeVisible();
      expect(submitted?.request).toBe('YC CLI');
      expect(submitted?.request_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(authorization).toMatch(/^Bearer /);
      expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
      expect(new URL(window.location.href).searchParams.get('agent-id')).toBe('yc-setup-agent');
    });

    it('keeps an ambiguous failed request retry id and presents an explicit setup failure', async () => {
      const ids: unknown[] = [];
      server.use(
        http.post(`${API_BASE}/integrations/cli`, async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          ids.push(body.request_id);
          return ids.length === 1
            ? HttpResponse.json({ error: 'Connection interrupted' }, { status: 503 })
            : HttpResponse.json({
                integration: { ...settingUp, status: 'failed', error: 'Sign-in needs attention' },
              });
        }),
      );
      renderWithProviders(<Integrations />, { roseDesktop });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Add CLI' }));
      await user.type(screen.getByLabelText('Enter the CLI you want to connect'), 'YC CLI');
      await user.click(screen.getByRole('button', { name: 'Connect' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Connection interrupted');
      await user.click(screen.getByRole('button', { name: 'Connect' }));
      expect(await screen.findByText('Sign-in needs attention')).toBeVisible();
      expect(ids).toHaveLength(2);
      expect(ids[1]).toBe(ids[0]);
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(screen.getByLabelText('Enter the CLI you want to connect')).toHaveValue('YC CLI');
    });

    it('polls pending setup until verification and stops on completion or unmount', async () => {
      let calls = 0;
      let verified = false;
      server.use(
        http.get(`${API_BASE}/integrations/cli`, () => {
          calls += 1;
          return HttpResponse.json({
            integrations: [{ ...settingUp, status: verified ? 'connected' : 'setting_up' }],
          });
        }),
      );
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const { unmount } = renderWithProviders(<Integrations />, { roseDesktop });
      await screen.findByText('Setting up…');
      verified = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      await waitFor(() => expect(screen.queryByText('Setting up…')).not.toBeInTheDocument());
      expect(screen.getByText('Connected', { exact: true })).toBeVisible();
      const afterVerified = calls;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(calls).toBe(afterVerified);
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(calls).toBe(afterVerified);
    });
    it('stops polling pending setup when the integrations panel closes', async () => {
      let calls = 0;
      server.use(
        http.get(`${API_BASE}/integrations/cli`, () => {
          calls += 1;
          return HttpResponse.json({ integrations: [settingUp] });
        }),
      );
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const { unmount } = renderWithProviders(<Integrations />, { roseDesktop });
      await screen.findByText('Setting up…');
      unmount();
      const before = calls;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(calls).toBe(before);
    });
  });
}
