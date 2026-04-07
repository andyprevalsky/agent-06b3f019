/**
 * Shared test wrapper for blackbox tests.
 * Provides all context providers needed by the component tree.
 */
import React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter, type MemoryRouterProps } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppDataProvider } from '@/hooks/useAppData';

interface TestWrapperOptions {
  route?: string;
  routerProps?: MemoryRouterProps;
}

function createTestWrapper(options: TestWrapperOptions = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });

  return function TestWrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AppDataProvider>
          <TooltipProvider>
            <MemoryRouter
              initialEntries={options.route ? [options.route] : ['/']}
              {...options.routerProps}
            >
              {children}
            </MemoryRouter>
          </TooltipProvider>
        </AppDataProvider>
      </QueryClientProvider>
    );
  };
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: TestWrapperOptions & Omit<RenderOptions, 'wrapper'>
) {
  const { route, routerProps, ...renderOptions } = options ?? {};
  return render(ui, {
    wrapper: createTestWrapper({ route, routerProps }),
    ...renderOptions,
  });
}
