/**
 * STATE MACHINE: Onboarding (step controller)
 *
 *   [auth] ─(onComplete)─> [customization] ─(onComplete)─> [data] ─(onComplete)─> [shortcut]
 *                                                                                         │
 *                                                                                         v
 *                                             [waitlist] <─(onGetStarted)─── [welcome]
 *                                                │
 *                                                └─(invite code redeemed / already
 *                                                   invited)─> parent onComplete()
 *
 *   Back button: goes one step back in navSteps. If target is [auth], signOut() first.
 */

import { useState, useEffect } from 'react';
import { ChevronLeft } from 'lucide-react';
import { signOut } from '@/lib/supabase';
import OnboardingAuth from './OnboardingAuth';
import OnboardingCustomization from './OnboardingCustomization';
import OnboardingData from './OnboardingData';
import OnboardingShortcut from './OnboardingShortcut';
import OnboardingWelcome from './OnboardingWelcome';
import OnboardingWaitlist from './OnboardingWaitlist';
import { ROSE_GRADIENT } from '../config';
import type { OnboardingStep } from '../types';

interface OnboardingProps {
  onComplete: () => void;
  isSignedIn?: boolean;
  skipAuth?: boolean;
}

const StepDots = ({
  steps,
  currentStep,
}: {
  steps: OnboardingStep[];
  currentStep: OnboardingStep;
}): JSX.Element => {
  const currentIndex = steps.indexOf(currentStep);

  return (
    <div className="flex items-center justify-center gap-2 pt-8 pb-4">
      {steps.map((step, index) => (
        <div
          key={step}
          className={`w-2 h-2 rounded-full transition-all duration-300 ${
            index > currentIndex ? 'bg-foreground/20' : ''
          }`}
          style={index <= currentIndex ? { background: ROSE_GRADIENT } : undefined}
        />
      ))}
    </div>
  );
};

const Onboarding = ({
  onComplete,
  isSignedIn: _isSignedIn = false,
  skipAuth = false,
}: OnboardingProps): JSX.Element => {
  const navSteps: OnboardingStep[] = skipAuth
    ? ['customization', 'data', 'shortcut', 'welcome', 'waitlist']
    : ['auth', 'customization', 'data', 'shortcut', 'welcome', 'waitlist'];

  const dotSteps: OnboardingStep[] = ['customization', 'data', 'shortcut', 'welcome', 'waitlist'];

  const [currentStep, setCurrentStep] = useState<OnboardingStep>(navSteps[0]);

  useEffect(() => {
    if (skipAuth && currentStep === 'auth') {
      setCurrentStep('customization');
    }
  }, [skipAuth, currentStep]);

  const goToNext = (): void => {
    const currentIndex = navSteps.indexOf(currentStep);
    if (currentIndex < navSteps.length - 1) {
      setCurrentStep(navSteps[currentIndex + 1]);
    }
  };

  const goBack = async (): Promise<void> => {
    const currentIndex = navSteps.indexOf(currentStep);
    if (currentIndex > 0) {
      const prevStep = navSteps[currentIndex - 1];
      if (prevStep === 'auth') {
        await signOut();
      }
      setCurrentStep(prevStep);
    }
  };

  const currentIndex = navSteps.indexOf(currentStep);
  const canGoBack = currentIndex > 0 && currentStep !== 'waitlist';

  const handleGetStarted = (): void => {
    goToNext();
  };

  const showDots = currentStep !== 'auth';
  const showFooter = currentStep !== 'welcome' && currentStep !== 'waitlist';

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {canGoBack ? (
        <button
          onClick={() => {
            void goBack();
          }}
          className="absolute top-14 left-4 p-1.5 text-muted-foreground/50 hover:text-foreground transition-colors z-10"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      ) : null}

      {showDots ? <StepDots steps={dotSteps} currentStep={currentStep} /> : null}

      <div className="flex-1 flex flex-col">
        {currentStep === 'auth' ? <OnboardingAuth onComplete={goToNext} /> : null}
        {currentStep === 'customization' ? <OnboardingCustomization onComplete={goToNext} /> : null}
        {currentStep === 'data' ? <OnboardingData onComplete={goToNext} /> : null}
        {currentStep === 'shortcut' ? <OnboardingShortcut onComplete={goToNext} /> : null}
        {currentStep === 'welcome' ? <OnboardingWelcome onGetStarted={handleGetStarted} /> : null}
        {currentStep === 'waitlist' ? <OnboardingWaitlist onComplete={onComplete} /> : null}
      </div>

      {showFooter ? (
        <div className="fixed bottom-0 left-0 right-0 flex items-center justify-center gap-8 pb-5 text-xs text-muted-foreground bg-background">
          <a href="#/terms" className="hover:text-foreground transition-colors">
            Terms
          </a>
          <a href="#/privacy" className="hover:text-foreground transition-colors">
            Privacy
          </a>
          <a href="mailto:support@roselabs.ai" className="hover:text-foreground transition-colors">
            Support
          </a>
        </div>
      ) : null}
    </div>
  );
};

export default Onboarding;
