/**
 * STATE MACHINE: App
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
 *   +--> "/research" --> <Research />
 *   +--> "/download" --> <Download />
 *   +--> "*" --> <NotFound />
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { Analytics } from "@vercel/analytics/react";
import { AppDataProvider } from "@/hooks/useAppData";
import ErrorBoundary from "@/components/ErrorBoundary";
import Index from "./pages/Index";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import NotFound from "./pages/NotFound";
import About from "./pages/About";
import Terminal from "./pages/Terminal";
import Research from "./pages/Research";
import Download from "./pages/Download";

const queryClient = new QueryClient();

const App = () => (
  <ErrorBoundary name="App Root">
    <QueryClientProvider client={queryClient}>
      <AppDataProvider>
        <TooltipProvider>
          <SpeedInsights />
          <Analytics />
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Terminal />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/about" element={<About />} />
              <Route path="/terminal" element={<Index />} />
              <Route path="/research" element={<Research />} />
              <Route path="/download" element={<Download />} />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </AppDataProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
