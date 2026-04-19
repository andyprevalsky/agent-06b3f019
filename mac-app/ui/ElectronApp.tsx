import { useState, useEffect } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { AppDataProvider } from '@/hooks/useAppData';
import { useAuth } from '@/features/auth';
import { getSession } from '@/lib/supabase';
import ErrorBoundary from '@/components/ErrorBoundary';
import Terminal from '@/pages/Terminal';
import Privacy from '@/pages/Privacy';
import Terms from '@/pages/Terms';
import NotFound from '@/pages/NotFound';
import Onboarding from './onboarding/Onboarding';

const backendUrl =
  (import.meta.env.VITE_BACKEND_API_URL as string | undefined) ?? 'http://localhost:3001';

const queryClient = new QueryClient();

// FOR DEVELOPMENT: Force show onboarding (set to false for production logic)
const FORCE_SHOW_ONBOARDING = false;
// FOR DEVELOPMENT: Skip auth step and go directly to data/integrations step
const FORCE_SKIP_AUTH = false;

// Sync completed-onboarding state to electron (store + shortcuts).
const syncElectronOnboardingComplete = async (): Promise<void> => {
  if (window.api?.onboarding?.setComplete !== undefined) {
    await window.api.onboarding.setComplete(true);
  }
  if (window.api?.shortcut?.enable !== undefined) {
    await window.api.shortcut.enable();
  }
};

// Fetch onboarding-complete flag from backend. Returns null on any failure.
const fetchOnboardingComplete = async (): Promise<boolean | null> => {
  const session = getSession();
  if (session?.access_token === undefined || session.access_token === '') {
    console.log('[ElectronApp] No session token, showing onboarding');
    return false;
  }

  console.log('[ElectronApp] Fetching onboarding status from backend...');
  const response = await fetch(`${backendUrl}/api/user-settings`, {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (!response.ok) {
    console.error('[ElectronApp] Failed to fetch user-settings:', response.status);
    return false;
  }

  const data = (await response.json()) as { onboardingCompletedAt?: string | null };
  const complete = data.onboardingCompletedAt !== null && data.onboardingCompletedAt !== undefined;
  console.log('[ElectronApp] Onboarding status from backend:', {
    onboardingCompletedAt: data.onboardingCompletedAt,
    complete,
  });
  return complete;
};

// Mark onboarding complete on the backend (best-effort).
const markOnboardingCompleteOnBackend = async (): Promise<void> => {
  const session = getSession();
  console.log('[ElectronApp] Session for onboarding complete:', {
    hasSession: session !== null && session !== undefined,
    hasToken: session?.access_token !== undefined && session.access_token !== '',
  });
  if (session?.access_token === undefined || session.access_token === '') return;

  const response = await fetch(`${backendUrl}/api/auth/complete-onboarding`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
  });
  const data = (await response.json()) as unknown;
  console.log('[ElectronApp] Backend complete-onboarding response:', {
    status: response.status,
    data,
  });
};

interface AuthState {
  isFullySignedIn: boolean;
  isAnonymous: boolean;
  loading: boolean;
  refreshAuthState: (reason: string) => Promise<void>;
}

// Orchestrate the onboarding-status check. Called from ElectronAppInner's useEffect.
const resolveOnboardingState = async (
  auth: { authLoading: boolean; isFullySignedIn: boolean; isAnonymous: boolean },
  setOnboardingComplete: (v: boolean) => void,
  setCheckingOnboarding: (v: boolean) => void
): Promise<void> => {
  console.log('[ElectronApp] checkOnboarding called', auth);
  if (auth.authLoading) return;
  if (!auth.isFullySignedIn) {
    console.log('[ElectronApp] Not fully signed in, showing onboarding');
    setOnboardingComplete(false);
    setCheckingOnboarding(false);
    return;
  }
  try {
    const complete = await fetchOnboardingComplete();
    setOnboardingComplete(complete === true);
    if (complete === true) await syncElectronOnboardingComplete();
  } catch (err) {
    console.error('[ElectronApp] Failed to check onboarding status:', err);
    setOnboardingComplete(false);
  } finally {
    setCheckingOnboarding(false);
  }
};

// Inner component that has access to auth context
const ElectronAppInner = () => {
  const {
    isFullySignedIn,
    isAnonymous,
    loading: authLoading,
    refreshAuthState,
  }: AuthState = useAuth();
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const [checkingOnboarding, setCheckingOnboarding] = useState(true);

  // Check onboarding status from backend when auth changes
  useEffect(() => {
    void resolveOnboardingState(
      { authLoading, isFullySignedIn, isAnonymous },
      setOnboardingComplete,
      setCheckingOnboarding
    );
    // Mirror original deps: isAnonymous is logged only, not a re-run trigger.
  }, [authLoading, isFullySignedIn]);

  const handleOnboardingComplete = async (): Promise<void> => {
    console.log('[ElectronApp] handleOnboardingComplete called');
    try {
      await markOnboardingCompleteOnBackend();
    } catch (err) {
      console.error('[ElectronApp] Failed to complete onboarding on backend:', err);
    }

    // Sync local electron store and enable global shortcuts now that onboarding is done
    console.log('[ElectronApp] Syncing local electron store...');
    await syncElectronOnboardingComplete();
    // Refresh auth state so isFullySignedIn picks up the session from onboarding
    await refreshAuthState('onboarding-complete');

    setOnboardingComplete(true);
    console.log('[ElectronApp] Onboarding complete, rendering Terminal');
  };

  // Show loading while checking auth/onboarding state
  if (authLoading || checkingOnboarding) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Determine if we should show onboarding
  // Logic:
  // - If FORCE_SHOW_ONBOARDING is true (dev mode), always show onboarding
  // - If user is not fully signed in (anonymous or logged out), show onboarding (starts at auth)
  // - If user is signed in but onboarding not complete, show onboarding (skips to data step)
  // - If user is signed in and onboarding complete, skip onboarding
  const shouldShowOnboarding =
    FORCE_SHOW_ONBOARDING || !isFullySignedIn || onboardingComplete !== true;

  if (shouldShowOnboarding) {
    return (
      <Onboarding
        onComplete={() => {
          void handleOnboardingComplete();
        }}
        isSignedIn={isFullySignedIn}
        skipAuth={FORCE_SKIP_AUTH || (isFullySignedIn && onboardingComplete !== true)}
      />
    );
  }

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Terminal />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </HashRouter>
  );
};

// Electron-specific App using HashRouter (file:// URLs don't work with BrowserRouter)
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
