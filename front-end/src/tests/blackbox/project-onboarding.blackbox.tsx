import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { ProjectOnboardingSection } from '@/features/terminal-component-group/components/rose-sidebar/ProjectOnboardingSection';
import { downloadProjectSetupHelper } from '@/lib/api/projectOnboarding';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { makeProject } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';
import { mockSession } from './app-sidebar.fixtures';
vi.mock('@/lib/api/projectOnboarding', () => ({ downloadProjectSetupHelper: vi.fn() }));
beforeEach(() => {
  mockSession();
  vi.mocked(downloadProjectSetupHelper).mockReset();
  server.use(
    http.get('http://localhost:3001/api/projects/p-rose/env-files', () =>
      HttpResponse.json({
        envFiles: [{ id: 'missing', path: 'back-end/.env', hasContent: false }],
      }),
    ),
  );
});
describe('Project environment onboarding', () => {
  it('shows missing real files and downloads setup client', async () => {
    vi.mocked(downloadProjectSetupHelper).mockResolvedValue(undefined);
    renderWithProviders(<ProjectOnboardingSection project={makeProject({ id: 'p-rose' })} />);
    expect(await screen.findByRole('status')).toHaveTextContent('back-end/.env');
    fireEvent.click(screen.getByRole('button', { name: 'Download setup helper' }));
    expect(await screen.findByText(/Unzip the helper/)).toBeVisible();
    expect(downloadProjectSetupHelper).toHaveBeenCalledWith('p-rose');
  });
  it('reports failed download without claiming setup success', async () => {
    vi.mocked(downloadProjectSetupHelper).mockRejectedValue(new Error('offline'));
    renderWithProviders(<ProjectOnboardingSection project={makeProject({ id: 'p-rose' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download setup helper' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not download');
    expect(screen.queryByText(/Unzip the helper/)).toBeNull();
  });
  it('does not treat a synced checkout as verified startup', () => {
    renderWithProviders(
      <ProjectOnboardingSection
        project={makeProject({
          id: 'p-rose',
          sync: { revision: 2, lastSyncedAt: '2026-10-21T00:00:00Z' },
        })}
      />,
    );
    expect(
      screen.getByText('Checkout imported. Verify workspace startup before using it.'),
    ).toBeVisible();
  });
});
