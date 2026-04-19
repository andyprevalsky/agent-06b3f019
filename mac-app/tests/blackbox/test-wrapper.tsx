import React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Shared test wrapper with every provider the mac-app renderer tree needs.
 *
 * Workers who find a component that uses an additional provider should add it
 * here (and document why in the PR body). Do not duplicate this wrapper.
 */
export interface ProvidersOptions {
  initialRoute?: string;
  /**
   * Whether to wrap the rendered tree in MemoryRouter. Default: true.
   * Set to false when rendering a component that already supplies its own
   * router (e.g. ElectronApp's HashRouter) — React Router forbids nested
   * Router instances.
   */
  withRouter?: boolean;
}

export function TestProviders({
  children,
  initialRoute = '/',
  withRouter = true,
}: {
  children: React.ReactNode;
  initialRoute?: string;
  withRouter?: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  const content = <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

  return withRouter ? (
    <MemoryRouter initialEntries={[initialRoute]}>{content}</MemoryRouter>
  ) : (
    content
  );
}

export function renderWithProviders(
  ui: React.ReactElement,
  {
    initialRoute,
    withRouter,
    ...renderOptions
  }: ProvidersOptions & Omit<RenderOptions, 'wrapper'> = {}
) {
  return render(ui, {
    wrapper: ({ children }) => (
      <TestProviders initialRoute={initialRoute} withRouter={withRouter}>
        {children}
      </TestProviders>
    ),
    ...renderOptions,
  });
}
