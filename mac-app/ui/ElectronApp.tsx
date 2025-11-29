import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Routes, Route } from "react-router-dom";
import { AppDataProvider } from "@/hooks/useAppData";
import ErrorBoundary from "@/components/ErrorBoundary";
import Terminal from "@/pages/Terminal";
import Privacy from "@/pages/Privacy";
import Terms from "@/pages/Terms";
import NotFound from "@/pages/NotFound";

const queryClient = new QueryClient();

// Electron-specific App using HashRouter (file:// URLs don't work with BrowserRouter)
const ElectronApp = () => (
  <ErrorBoundary name="App Root">
    <QueryClientProvider client={queryClient}>
      <AppDataProvider>
        <TooltipProvider>
          <HashRouter>
            <Routes>
              <Route path="/" element={<Terminal />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </HashRouter>
        </TooltipProvider>
      </AppDataProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default ElectronApp;
