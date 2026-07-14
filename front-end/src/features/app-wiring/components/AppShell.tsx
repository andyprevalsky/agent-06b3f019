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
 *   +--> "/download" --> <Download />
 *   +--> "/waitlist" --> main Terminal + automatic phone login
 *   +--> "*" --> <NotFound />
 *
 * WaitlistGate overlays every route: authenticated users without a redeemed
 * invite code see "You're On The Waitlist!" instead of being fully signed in.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { Analytics } from '@vercel/analytics/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppDataProvider } from '@/hooks/useAppData';
import ErrorBoundary from '@/components/ErrorBoundary';
import { WaitlistGate } from '@/features/auth';

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
