import { useState, useEffect } from 'react';
import { ChevronLeft } from 'lucide-react';
import { signOut } from '@/lib/supabase';
import OnboardingAuth from './OnboardingAuth';
import OnboardingData from './OnboardingData';
import OnboardingShortcut from './OnboardingShortcut';
import OnboardingWelcome from './OnboardingWelcome';
import OnboardingPayment from './OnboardingPayment';

export type OnboardingStep = 'auth' | 'data' | 'shortcut' | 'welcome' | 'payment';

interface OnboardingProps {
  onComplete: () => void;
  isSignedIn?: boolean;
  skipAuth?: boolean;
}

// Rose gradient for dots
const roseGradient = 'linear-gradient(to bottom left, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)';

// Dot indicator component
const StepDots = ({
  steps,
  currentStep
}: {
  steps: OnboardingStep[];
  currentStep: OnboardingStep;
}) => {
  const currentIndex = steps.indexOf(currentStep);

  return (
    <div className="flex items-center justify-center gap-2 pt-8 pb-4">
      {steps.map((step, index) => (
        <div
          key={step}
          className={`w-2 h-2 rounded-full transition-all duration-300 ${
            index > currentIndex ? 'bg-foreground/20' : ''
          }`}
          style={index <= currentIndex ? { background: roseGradient } : undefined}
        />
      ))}
    </div>
  );
};

const Onboarding = ({ onComplete, isSignedIn = false, skipAuth = false }: OnboardingProps) => {
  // Always use full steps array for navigation - we handle skipAuth separately
  const fullSteps: OnboardingStep[] = ['auth', 'data', 'shortcut', 'welcome', 'payment'];

  // Steps for display (dots) - exclude auth if skipping
  const displaySteps: OnboardingStep[] = skipAuth
    ? ['data', 'shortcut', 'welcome', 'payment']
    : fullSteps;

  const [currentStep, setCurrentStep] = useState<OnboardingStep>(skipAuth ? 'data' : 'auth');

  // Update step if skipAuth changes
  useEffect(() => {
    if (skipAuth && currentStep === 'auth') {
      setCurrentStep('data');
    }
  }, [skipAuth, currentStep]);

  const goToNext = () => {
    const currentIndex = fullSteps.indexOf(currentStep);
    if (currentIndex < fullSteps.length - 1) {
      setCurrentStep(fullSteps[currentIndex + 1]);
    }
  };

  const goBack = async () => {
    const currentIndex = fullSteps.indexOf(currentStep);
    if (currentIndex > 0) {
      const prevStep = fullSteps[currentIndex - 1];
      // If going back to auth from data, sign out first
      if (currentStep === 'data' && prevStep === 'auth') {
        await signOut();
      }
      setCurrentStep(prevStep);
    }
  };

  // Show back button when not on auth step (data can go back to auth via sign out)
  // Also hide back button on payment step (can't go back from payment)
  const canGoBack = currentStep !== 'auth' && currentStep !== 'payment';

  const handleGetStarted = () => {
    goToNext(); // Go to payment step
  };

  // Don't show dots on auth page
  const showDots = currentStep !== 'auth';
  // For dots, show all steps except auth
  const dotSteps = displaySteps.filter(s => s !== 'auth');

  // Show footer on all steps except welcome and payment
  const showFooter = currentStep !== 'welcome' && currentStep !== 'payment';

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Back button - below drag region */}
      {canGoBack && (
        <button
          onClick={goBack}
          className="absolute top-14 left-4 p-1.5 text-muted-foreground/50 hover:text-foreground transition-colors z-10"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      )}

      {showDots && <StepDots steps={dotSteps} currentStep={currentStep} />}

      <div className="flex-1 flex flex-col">
        {currentStep === 'auth' && (
          <OnboardingAuth onComplete={goToNext} />
        )}
        {currentStep === 'data' && (
          <OnboardingData onComplete={goToNext} />
        )}
        {currentStep === 'shortcut' && (
          <OnboardingShortcut onComplete={goToNext} />
        )}
        {currentStep === 'welcome' && (
          <OnboardingWelcome onGetStarted={handleGetStarted} />
        )}
        {currentStep === 'payment' && (
          <OnboardingPayment onComplete={onComplete} />
        )}
      </div>

      {/* Footer links - fixed 20px from bottom */}
      {showFooter && (
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
      )}
    </div>
  );
};

export default Onboarding;
