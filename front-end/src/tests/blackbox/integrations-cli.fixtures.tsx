import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
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

    // Stock: the CLI card. Desktop: the "CLIs" integration row with account chips.
    const requestLabel = roseDesktop ? 'CLI to connect' : 'Enter the CLI you want to connect';
    const submitName = roseDesktop ? 'Connect CLI' : 'Connect';
    const cliRow = () => within(screen.getByTestId('integration-row-clis'));
    const ycChip = () => {
      const chip = cliRow().getByText('YC CLI').closest<HTMLElement>('[data-tone]');
      if (chip === null) throw new Error('No YC CLI account chip');
      return chip;
    };

    async function openForm(user: UserEvent) {
      const name = roseDesktop ? 'Connect CLIs' : 'Add CLI';
      await user.click(await screen.findByRole('button', { name }));
    }

    /** Pending setup: card text, or a syncing chip under the shared sync bar. */
    async function expectSettingUp() {
      if (!roseDesktop) {
        expect(await screen.findByText('Setting up…')).toBeVisible();
        return;
      }
      await waitFor(() => expect(ycChip()).toHaveAttribute('data-tone', 'syncing'));
      expect(cliRow().getByTestId('sync-progress')).toBeVisible();
    }

    async function expectVerified() {
      if (!roseDesktop) {
        await waitFor(() => expect(screen.queryByText('Setting up…')).not.toBeInTheDocument());
        expect(screen.getByText('Connected', { exact: true })).toBeVisible();
        return;
      }
      await waitFor(() => expect(ycChip()).toHaveAttribute('data-tone', 'synced'));
      expect(ycChip()).toHaveAttribute('title', 'Connected');
      expect(cliRow().queryByTestId('sync-progress')).toBeNull();
    }

    it('keeps the integrations page mounted when the CLI list response has no integrations', async () => {
      server.use(http.get(`${API_BASE}/integrations/cli`, () => HttpResponse.json({})));
      renderWithProviders(<Integrations />, { roseDesktop });
      expect(await screen.findByRole('alert')).toHaveTextContent('Unexpected CLI response');
      expect(
        screen.getByRole('button', { name: roseDesktop ? 'Connect CLIs' : 'Add CLI' }),
      ).toBeVisible();
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
      await openForm(user);
      if (!roseDesktop) expect(screen.getByAltText('Claude')).toBeVisible();
      expect(screen.getByLabelText(requestLabel)).toHaveFocus();
      await user.type(screen.getByLabelText(requestLabel), 'YC CLI');
      await user.click(screen.getByRole('button', { name: submitName }));
      await expectSettingUp();
      if (roseDesktop) {
        expect(screen.queryByRole('form', { name: 'Connect CLI' })).toBeNull();
        expect(within(ycChip()).getByRole('button', { name: 'Open setup' })).toBeVisible();
      }
      expect(submitted?.request).toBe('YC CLI');
      expect(submitted?.request_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(authorization).toMatch(/^Bearer /);
      expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument();
      expect(new URL(window.location.href).searchParams.get('agent-id')).toBe('yc-setup-agent');
    });

    it.each(['json', 'html'])(
      'keeps an ambiguous %s failure retry id and presents an explicit setup failure',
      async (format) => {
        const ids: unknown[] = [];
        server.use(
          http.post(`${API_BASE}/integrations/cli`, async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            ids.push(body.request_id);
            return ids.length === 1
              ? format === 'html'
                ? new HttpResponse('<html>Bad gateway</html>', {
                    status: 502,
                    headers: { 'Content-Type': 'text/html' },
                  })
                : HttpResponse.json({ error: 'Connection interrupted' }, { status: 503 })
              : HttpResponse.json({
                  integration: { ...settingUp, status: 'failed', error: 'Sign-in needs attention' },
                });
          }),
        );
        renderWithProviders(<Integrations />, { roseDesktop });
        const user = userEvent.setup();
        await openForm(user);
        await user.type(screen.getByLabelText(requestLabel), 'YC CLI');
        await user.click(screen.getByRole('button', { name: submitName }));
        expect(await screen.findByRole('alert')).toHaveTextContent(
          format === 'html' ? 'Could not connect CLI' : 'Connection interrupted',
        );
        await user.click(screen.getByRole('button', { name: submitName }));
        expect(await screen.findByText('Sign-in needs attention')).toBeVisible();
        expect(ids).toHaveLength(2);
        expect(ids[1]).toBe(ids[0]);
        if (roseDesktop) {
          // The failure is an error chip with its reason on the line under the chips.
          expect(ycChip()).toHaveAttribute('data-tone', 'error');
          expect(cliRow().getByTestId('account-sync-error')).toHaveTextContent(
            'Sign-in needs attention',
          );
          await user.click(within(ycChip()).getByRole('button', { name: 'Retry' }));
        } else {
          await user.click(screen.getByRole('button', { name: 'Retry' }));
        }
        expect(screen.getByLabelText(requestLabel)).toHaveValue('YC CLI');
      },
    );

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
      await expectSettingUp();
      verified = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      await expectVerified();
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
      await expectSettingUp();
      unmount();
      const before = calls;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(calls).toBe(before);
    });
  });
}
