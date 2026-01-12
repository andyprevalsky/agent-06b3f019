import { useState, useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Routes, Route } from "react-router-dom";
import { AppDataProvider } from "@/hooks/useAppData";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/lib/supabase";
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
      // Only check if user is signed in
      if (!isFullySignedIn) {
        setOnboardingComplete(false);
        setCheckingOnboarding(false);
        return;
      }

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) {
          setOnboardingComplete(false);
          setCheckingOnboarding(false);
          return;
        }

        const response = await fetch(`${backendUrl}/api/user-settings`, {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          // onboardingCompletedAt is null if not completed, a date string if completed
          const complete = !!data.onboardingCompletedAt;
          setOnboardingComplete(complete);

          // If already completed, enable shortcuts
          if (complete && window.api?.shortcut?.enable) {
            await window.api.shortcut.enable();
          }
        } else {
          setOnboardingComplete(false);
        }
      } catch (err) {
        console.error('Failed to check onboarding status:', err);
        setOnboardingComplete(false);
      } finally {
        setCheckingOnboarding(false);
      }
    };
    checkOnboarding();
  }, [isFullySignedIn]);

  const handleOnboardingComplete = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        // Call backend to mark onboarding complete and send welcome SMS
        await fetch(`${backendUrl}/api/auth/complete-onboarding`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
        });
      }
    } catch (err) {
      console.error('Failed to complete onboarding on backend:', err);
    }

    // Enable global shortcuts now that onboarding is done
    if (window.api?.shortcut?.enable) {
      await window.api.shortcut.enable();
    }
    setOnboardingComplete(true);
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
