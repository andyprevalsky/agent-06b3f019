/**
 * STATE MACHINE: OnboardingCustomization
 *
 *   [LOADING] ────────────────────────────────────────────────────────────────┐
 *       │                                                                      │
 *       v (fetch settings)                                                     │
 *   [READY] ──────────────────────────────────────────────────────────────────┤
 *       │                                                                      │
 *       ├── (edit fields) → update local state                                │
 *       │                                                                      │
 *       └── (click Continue) → [SAVING] → (success) → onComplete() ───────────┘
 *                                 │
 *                                 └── (error) → show error → [READY]
 */

import { useState, useEffect } from 'react';
import { Loader2, ArrowRight, Sparkles } from 'lucide-react';
import { SystemCustomization, type CustomizationData } from '@/features/customization';
import { getErrorMessageOrFallback } from '../../../../shared/utils/error';
import { useOnboardingCustomizationApi } from '../hooks';

interface OnboardingCustomizationProps {
  onComplete: () => void;
}

const OnboardingCustomization = ({ onComplete }: OnboardingCustomizationProps): JSX.Element => {
  const customizationApi = useOnboardingCustomizationApi();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customization, setCustomization] = useState<CustomizationData>({
    systemName: 'Rose',
    profilePicture: null,
    customSystemPrompt: '',
  });

  useEffect(() => {
    void customizationApi.fetchCustomization().then((loaded) => {
      if (loaded !== null) setCustomization(loaded);
      setLoading(false);
    });
  }, [customizationApi]);

  const handleContinue = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await customizationApi.saveCustomization(customization);
      onComplete();
    } catch (err) {
      console.error('Failed to save customization:', err);
      setError(getErrorMessageOrFallback(err, 'Failed to save'));
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col px-8 pt-6 pb-20 overflow-y-auto">
      <div className="text-center mb-6">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Sparkles className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">Customize Your Assistant</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Give your AI assistant a unique personality and appearance
        </p>
      </div>

      <div className="flex-1 max-w-md mx-auto w-full">
        <SystemCustomization
          data={customization}
          onChange={setCustomization}
          isLoading={saving}
          compact
        />
      </div>

      {error !== null && error.length > 0 ? (
        <div className="max-w-md mx-auto w-full mt-4 p-3 bg-destructive/10 border border-destructive rounded-lg text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="max-w-md mx-auto w-full mt-6">
        <button
          onClick={() => {
            void handleContinue();
          }}
          disabled={saving}
          className="w-full h-12 rounded-xl bg-foreground text-background hover:bg-foreground/90 transition-all duration-200 flex items-center justify-center gap-2 text-sm font-medium"
        >
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>
              Continue
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export default OnboardingCustomization;
