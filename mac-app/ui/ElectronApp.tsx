import { useState, useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Routes, Route } from "react-router-dom";
import { AppDataProvider } from "@/hooks/useAppData";
import { useAuth } from "@/hooks/useAuth";
import { getSession } from "@/lib/supabase";
import ErrorBoundary from "@/components/ErrorBoundary";
import Terminal from "@/pages/Terminal";
import Privacy from "@/pages/Privacy";
import Terms from "@/pages/Terms";
import NotFound from "@/pages/NotFound";
import Onboarding from "./onboarding/Onboarding";

const backendUrl = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001';

const queryClient = new QueryClient();

// FOR DEVELOPMENT: Force show onboarding (set to false for production logic)
const FORCE_SHOW_ONBOARDING = false;
// FOR DEVELOPMENT: Skip auth step and go directly to data/integrations step
const FORCE_SKIP_AUTH = false;

// Inner component that has access to auth context
const ElectronAppInner = () => {
  const { isFullySignedIn, isAnonymous, loading: authLoading } = useAuth();
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const [checkingOnboarding, setCheckingOnboarding] = useState(true);

  // Check onboarding status from backend when auth changes
  useEffect(() => {
    const checkOnboarding = async () => {
      console.log('[ElectronApp] checkOnboarding called', { authLoading, isFullySignedIn, isAnonymous });

      // Wait for auth to finish loading before deciding
      if (authLoading) return;

      // Only check if user is signed in
      if (!isFullySignedIn) {
        console.log('[ElectronApp] Not fully signed in, showing onboarding');
        setOnboardingComplete(false);
        setCheckingOnboarding(false);
        return;
      }

      try {
        const session = getSession();
        if (!session?.access_token) {
          console.log('[ElectronApp] No session token, showing onboarding');
          setOnboardingComplete(false);
          setCheckingOnboarding(false);
          return;
        }

        console.log('[ElectronApp] Fetching onboarding status from backend...');
        const response = await fetch(`${backendUrl}/api/user-settings`, {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          // onboardingCompletedAt is null if not completed, a date string if completed
          const complete = !!data.onboardingCompletedAt;
          console.log('[ElectronApp] Onboarding status from backend:', { onboardingCompletedAt: data.onboardingCompletedAt, complete });
          setOnboardingComplete(complete);

          // If already completed, sync local electron store and enable shortcuts
          if (complete) {
            if (window.api?.onboarding?.setComplete) {
              await window.api.onboarding.setComplete(true);
            }
            if (window.api?.shortcut?.enable) {
              await window.api.shortcut.enable();
            }
          }
        } else {
          console.error('[ElectronApp] Failed to fetch user-settings:', response.status);
          setOnboardingComplete(false);
        }
      } catch (err) {
        console.error('[ElectronApp] Failed to check onboarding status:', err);
        setOnboardingComplete(false);
      } finally {
        setCheckingOnboarding(false);
      }
    };
    checkOnboarding();
  }, [authLoading, isFullySignedIn]);

  const handleOnboardingComplete = async () => {
    console.log('[ElectronApp] handleOnboardingComplete called');
    try {
      const session = getSession();
      console.log('[ElectronApp] Session for onboarding complete:', { hasSession: !!session, hasToken: !!session?.access_token });
      if (session?.access_token) {
        // Call backend to mark onboarding complete and send welcome SMS
        const response = await fetch(`${backendUrl}/api/auth/complete-onboarding`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
        });
        const data = await response.json();
        console.log('[ElectronApp] Backend complete-onboarding response:', { status: response.status, data });
      }
    } catch (err) {
      console.error('[ElectronApp] Failed to complete onboarding on backend:', err);
    }

    // Sync local electron store and enable global shortcuts now that onboarding is done
    console.log('[ElectronApp] Syncing local electron store...');
    if (window.api?.onboarding?.setComplete) {
      await window.api.onboarding.setComplete(true);
      console.log('[ElectronApp] Electron store onboarding set to complete');
    }
    if (window.api?.shortcut?.enable) {
      await window.api.shortcut.enable();
      console.log('[ElectronApp] Shortcuts enabled');
    }
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
  const shouldShowOnboarding = FORCE_SHOW_ONBOARDING || !isFullySignedIn || !onboardingComplete;

  if (shouldShowOnboarding) {
    return (
      <Onboarding
        onComplete={handleOnboardingComplete}
        isSignedIn={isFullySignedIn}
        skipAuth={FORCE_SKIP_AUTH || (isFullySignedIn && !onboardingComplete)}
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
