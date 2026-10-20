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
import { RoseDesktopContext } from '@/hooks/roseDesktopContext';
import { RoseAppsProvider } from '@/features/terminal-component-group';
import { RoseThemeProvider } from '@/features/rose-theme';
import { AttentionScope } from './attention-scope';

interface TestWrapperOptions {
  route?: string;
  routerProps?: MemoryRouterProps;
  /** Rose Desktop flag (lib/roseDesktop.ts). Defaults on; pass false to test the stock UI. */
  roseDesktop?: boolean;
  /**
   * Signed-in user id for RoseThemeProvider (mirrors TerminalLayout). Omitted,
   * the theme stays stock light and the top-right Dark mode toggle is a no-op.
   */
  roseThemeUserId?: string;
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
                <RoseDesktopContext.Provider value={options.roseDesktop ?? true}>
                  <RoseThemeProvider userId={options.roseThemeUserId ?? null}>
                    <RoseAppsProvider>{children}</RoseAppsProvider>
                  </RoseThemeProvider>
                </RoseDesktopContext.Provider>
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
  const { route, routerProps, roseDesktop, roseThemeUserId, ...renderOptions } = options ?? {};
  return render(ui, {
    wrapper: createTestWrapper({ route, routerProps, roseDesktop, roseThemeUserId }),
    ...renderOptions,
  });
}
