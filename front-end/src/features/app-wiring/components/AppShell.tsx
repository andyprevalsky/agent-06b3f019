/**
 * STATE MACHINE: AppShell
 *
 * This component is stateless - it only provides routing and context providers.
 *
 * [MOUNTED] --> app route immediately; public routes [LOADING] -> [READY]
 *   |
 *   +--> "/" --> <Terminal />
 *   +--> "/privacy" --> <Privacy />
 *   +--> "/terms" --> <Terms />
 *   +--> "/about" --> <About />
 *   +--> "/terminal" --> <Index />
 *   +--> "/research" --> <ResearchBlog />
 *   +--> "/research/:slug" --> <ResearchBlogPost />
 *   +--> "/careers" --> <Careers />
 *   +--> "/careers/:slug" --> <CareersRole />
 *   +--> "/download" --> <Download />
 *   +--> "/waitlist" --> main Terminal + automatic phone login
 *   +--> "/open-agent" --> <OpenAgentRedirect /> (durable ?agent-id deep link)
 *   +--> "*" --> <NotFound />
 *
 * WaitlistGate overlays every route: authenticated users without a redeemed
 * invite code see "You're On The Waitlist!" instead of being fully signed in.
 *
 * TopRightControls overlays every route and owns the layout of the inspection
 * and admin account pills. AdminSwitcherMount stays reachable from every route,
 * while an inspected run can add its read-only identity without overlapping it.
 * Rose Desktop accounts keep the switcher in Settings instead; their pill only
 * appears here while impersonating (the exit). Phone fullscreen slots own the same
 * persistent rail host; closing restores normal placement without remounting it.
 */

import { Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { Analytics } from '@vercel/analytics/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { GlobalControlsLayoutProvider } from '@/components/GlobalControlsLayout';
import { TopRightControls } from '@/components/TopRightControls';
import { AppDataProvider } from '@/hooks/useAppData';
import ErrorBoundary from '@/components/ErrorBoundary';
import { WaitlistGate } from '@/features/auth';

import { AdminSwitcherMount } from './AdminSwitcherMount';

import { ROUTE_TABLE } from '../config';

const queryClient = new QueryClient();

const AppShell = () => (
  <ErrorBoundary name="App Root">
    <QueryClientProvider client={queryClient}>
      <AppDataProvider>
        <TooltipProvider>
          <SpeedInsights />
          <Analytics />
          <BrowserRouter>
            <GlobalControlsLayoutProvider>
              <WaitlistGate />
              <TopRightControls>
                <AdminSwitcherMount />
              </TopRightControls>
              <Suspense
                fallback={
                  <div role="status" className="p-6 text-sm text-muted-foreground">
                    Loading…
                  </div>
                }
              >
                <Routes>
                  {ROUTE_TABLE.map(({ path, component: Page }) => (
                    <Route key={path} path={path} element={<Page />} />
                  ))}
                </Routes>
              </Suspense>
            </GlobalControlsLayoutProvider>
          </BrowserRouter>
        </TooltipProvider>
      </AppDataProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default AppShell;
