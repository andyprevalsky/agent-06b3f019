/**
 * Top-level renderer shell for the Electron app.
 *
 * Wraps the inner shell in the required providers, in order:
 *   ErrorBoundary → QueryClientProvider → AppDataProvider → TooltipProvider
 *
 * The QueryClient is instantiated once per module load (module-scope singleton)
 * rather than inside the component, so query caches survive re-renders of the
 * outer shell.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppDataProvider } from '@/hooks/useAppData';
import ErrorBoundary from '@/components/ErrorBoundary';
import ElectronAppInner from './ElectronAppInner';

const queryClient = new QueryClient();

const ElectronApp = () => {
  return (
    <ErrorBoundary name="App Root">
      <QueryClientProvider client={queryClient}>
        <AppDataProvider>
          <TooltipProvider>
            <ElectronAppInner />
          </TooltipProvider>
        </AppDataProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
};

export default ElectronApp;
