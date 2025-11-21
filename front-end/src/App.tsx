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
