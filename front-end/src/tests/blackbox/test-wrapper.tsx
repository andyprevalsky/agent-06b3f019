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
import {
  AttentionRequestsProvider,
  RoseAppsProvider,
  useAttentionRequests,
} from '@/features/terminal-component-group';

interface TestWrapperOptions {
  route?: string;
  routerProps?: MemoryRouterProps;
}

/**
 * Mirrors the real TerminalLayout wiring: one attention subscription held above
 * the tree, fanned out via context. Runs the actual hook (MSW serves the
 * endpoint) rather than a stub, so components under test exercise the same path
 * they do in the app.
 */
function AttentionScope({ children }: { children: React.ReactNode }) {
  const attention = useAttentionRequests(false);
  return <AttentionRequestsProvider value={attention}>{children}</AttentionRequestsProvider>;
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
            <AttentionScope>
              <MemoryRouter
                initialEntries={options.route ? [options.route] : ['/']}
                {...options.routerProps}
              >
                {/* Mirrors TerminalLayout: the Browser drawer (which replaced the
                    fullscreen browser) is mounted by the RoseApps provider. */}
                <RoseAppsProvider>{children}</RoseAppsProvider>
              </MemoryRouter>
            </AttentionScope>
          </TooltipProvider>
        </AppDataProvider>
      </QueryClientProvider>
    );
  };
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: TestWrapperOptions & Omit<RenderOptions, 'wrapper'>,
) {
  const { route, routerProps, ...renderOptions } = options ?? {};
  return render(ui, {
    wrapper: createTestWrapper({ route, routerProps }),
    ...renderOptions,
  });
}
