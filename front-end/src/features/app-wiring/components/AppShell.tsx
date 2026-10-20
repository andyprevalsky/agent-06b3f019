/**
 * STATE MACHINE: AppShell
 *
 * This component is stateless - it only provides routing and context providers.
 *
 * [MOUNTED] --> renders route based on URL path
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
 * appears here while impersonating (the exit).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { Analytics } from '@vercel/analytics/react';
import { TooltipProvider } from '@/components/ui/tooltip';
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
            <WaitlistGate />
            <TopRightControls>
              <AdminSwitcherMount />
            </TopRightControls>
            <Routes>
              {ROUTE_TABLE.map(({ path, component: Page }) => (
                <Route key={path} path={path} element={<Page />} />
              ))}
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </AppDataProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default AppShell;
