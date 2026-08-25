import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';
import { AppRoutes } from './app-wiring.blackbox';

describe('open-agent durable deep link', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('does not render SPA NotFound for /open-agent?agent-id=', async () => {
    renderWithProviders(<AppRoutes />, {
      route: '/open-agent?agent-id=42cc9eb7-bca7-4d87-8373-faadcd33f8ef',
    });

    // MemoryRouter keeps history in-memory (not window.location). Success is:
    // redirect away from NotFound into the Terminal deep-link route.
    await waitFor(() => {
      expect(screen.queryByText('Oops! Page not found')).not.toBeInTheDocument();
      expect(screen.queryByText('Opening agent…')).not.toBeInTheDocument();
    });
  });

  it('does not 404 when agent-id is missing on /open-agent', async () => {
    renderWithProviders(<AppRoutes />, { route: '/open-agent' });
    await waitFor(() => {
      expect(screen.queryByText('Oops! Page not found')).not.toBeInTheDocument();
    });
  });
});
