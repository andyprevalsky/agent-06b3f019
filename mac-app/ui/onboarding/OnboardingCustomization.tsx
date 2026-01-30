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
import { getSession } from '@/lib/supabase';
import SystemCustomization, { type CustomizationData } from '@/components/customization/SystemCustomization';

const backendUrl = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001';

interface OnboardingCustomizationProps {
  onComplete: () => void;
}

export default function OnboardingCustomization({ onComplete }: OnboardingCustomizationProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customization, setCustomization] = useState<CustomizationData>({
    systemName: 'Rose',
    profilePicture: null,
    customSystemPrompt: '',
  });

  // Load existing customization on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const session = getSession();
        if (!session) {
          setLoading(false);
          return;
        }

        const response = await fetch(`${backendUrl}/api/user-settings`, {
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          setCustomization({
            systemName: data.systemName || 'Rose',
            profilePicture: data.profilePicture || null,
            customSystemPrompt: data.customSystemPrompt || '',
          });
        }
      } catch (err) {
        console.error('Failed to load customization:', err);
      } finally {
        setLoading(false);
      }
    };

    loadSettings();
  }, []);

  const handleContinue = async () => {
    setSaving(true);
    setError(null);

    try {
      const session = getSession();
      if (!session) {
        throw new Error('Not authenticated');
      }

      const response = await fetch(`${backendUrl}/api/user-settings`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemName: customization.systemName || null,
          profilePicture: customization.profilePicture || null,
          customSystemPrompt: customization.customSystemPrompt || null,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save customization');
      }

      onComplete();
    } catch (err) {
      console.error('Failed to save customization:', err);
      setError(err instanceof Error ? err.message : 'Failed to save');
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
      {/* Header */}
      <div className="text-center mb-6">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Sparkles className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">
            Customize Your Assistant
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Give your AI assistant a unique personality and appearance
        </p>
      </div>

      {/* Customization Form */}
      <div className="flex-1 max-w-md mx-auto w-full">
        <SystemCustomization
          data={customization}
          onChange={setCustomization}
          isLoading={saving}
          compact
        />
      </div>

      {/* Error Message */}
      {error && (
        <div className="max-w-md mx-auto w-full mt-4 p-3 bg-destructive/10 border border-destructive rounded-lg text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Action Button */}
      <div className="max-w-md mx-auto w-full mt-6">
        <button
          onClick={handleContinue}
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
}
