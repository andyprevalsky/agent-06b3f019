/** Guest chrome must never retain browser metadata from the previous account. */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Terminal from '@/pages/Terminal';
import { ROSE_THEME_ACTIVE_KEY } from '@/features/rose-theme/config';
import { useRoseApps } from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
import { renderWithProviders } from './test-wrapper';

// Exercise the actual terminal provider and logout action with a browser-tab producer.
vi.mock('@/features/terminal/components/TerminalMainContent', () => ({
  MainContent: function BrowserStateProbe() {
    const apps = useRoseApps()!;
    return (
      <>
        <button
          onClick={() =>
            apps.registerAgentBrowser({
              agentId: 'private-agent',
              taskId: 'private-task',
              live: true,
              taskLabel: 'Private account task',
              pageUrl: 'https://private.example/account',
            })
          }
        >
          Register browser
        </button>
        <button onClick={apps.onLogout}>Sign out of test account</button>
        <output data-testid="account-browser-tabs">{JSON.stringify(apps.tabs)}</output>
      </>
    );
  },
}));

describe('default desktop account isolation', () => {
  it('clears browser metadata on logout while keeping the new guest chrome', async () => {
    localStorage.setItem(
      'rose-session',
      JSON.stringify({
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: 'signed-in-account', is_anonymous: false },
      }),
    );
    renderWithProviders(<Terminal />);
    await screen.findByTestId('rose-sidebar');
    await waitFor(() =>
      expect(localStorage.getItem(ROSE_THEME_ACTIVE_KEY)).toBe('signed-in-account'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Register browser' }));
    expect(screen.getByTestId('account-browser-tabs')).toHaveTextContent('private.example');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of test account' }));
    await waitFor(() =>
      expect(localStorage.getItem('rose-session') ?? '').not.toContain('signed-in-account'),
    );
    await waitFor(() => expect(screen.getByTestId('account-browser-tabs')).toHaveTextContent('[]'));
    expect(screen.getByTestId('rose-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('rose-app-icons')).toBeInTheDocument();
  });
});
