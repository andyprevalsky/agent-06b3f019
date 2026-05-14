/**
 * STATE MACHINE: OnboardingCustomization
 *
 *   [LOADING] ─(fetch settings + local voice)→ [READY]
 *       │                                      │
 *       │                                      ├─(edit name / pick voice)→ [READY]
 *       │                                      └─(Continue)→ [SAVING]
 *       │                                                       │
 *       └──────────────────────────────(success)←──────────────┘
 *                                                               │
 *                                  (save error) → [READY + error]
 */

import { useEffect, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { getErrorMessageOrFallback } from '../../../../shared/utils/error';
import { useOnboardingCustomizationApi } from '../hooks';
import VoiceSelector, { DEFAULT_VOICE_PREFERENCE, type VoicePreference } from './VoiceSelector';
import BackgroundTiles from './BackgroundTiles';

interface OnboardingCustomizationProps {
  onComplete: () => void;
}

const VOICE_STORAGE_KEY = 'rose.onboarding.voicePreference';
const MAX_NAME_LENGTH = 50;

const loadVoicePreference = (): VoicePreference => {
  const raw = localStorage.getItem(VOICE_STORAGE_KEY);
  if (raw === null || raw === '') return DEFAULT_VOICE_PREFERENCE;
  try {
    const parsed = JSON.parse(raw) as Partial<VoicePreference>;
    if (parsed.mode === 'custom' && typeof parsed.voiceId === 'string') {
      return { mode: 'custom', voiceId: parsed.voiceId, label: 'Custom' };
    }
    if (parsed.mode === 'preset' && typeof parsed.voiceId === 'string') {
      return {
        mode: 'preset',
        voiceId: parsed.voiceId,
        label: typeof parsed.label === 'string' ? parsed.label : 'Selected voice',
      };
    }
  } catch {
    localStorage.removeItem(VOICE_STORAGE_KEY);
  }
  return DEFAULT_VOICE_PREFERENCE;
};

const saveVoicePreference = (voice: VoicePreference): void => {
  localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(voice));
};

interface NameFieldProps {
  name: string;
  saving: boolean;
  setName: (value: string) => void;
}

const NameField = ({ name, saving, setName }: NameFieldProps): JSX.Element => (
  <div className="space-y-2">
    <label htmlFor="agentName" className="text-sm font-medium text-foreground">
      Name
    </label>
    <input
      id="agentName"
      type="text"
      value={name}
      onChange={(e) => setName(e.target.value)}
      maxLength={MAX_NAME_LENGTH}
      disabled={saving}
      placeholder="Rose"
      className="w-full h-10 rounded-lg border border-muted-foreground/30 bg-background px-3 text-sm outline-none focus:border-foreground"
    />
  </div>
);

interface ContinueButtonProps {
  saving: boolean;
  onClick: () => void;
}

const ContinueButton = ({ saving, onClick }: ContinueButtonProps): JSX.Element => (
  <button
    onClick={onClick}
    disabled={saving}
    className="w-full h-12 rounded-lg bg-foreground text-background hover:bg-foreground/90 transition-all duration-200 flex items-center justify-center gap-2 text-sm font-medium"
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
);

const OnboardingCustomization = ({ onComplete }: OnboardingCustomizationProps): JSX.Element => {
  const customizationApi = useOnboardingCustomizationApi();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('Rose');
  const [voice, setVoice] = useState<VoicePreference>(DEFAULT_VOICE_PREFERENCE);
  const [customVoiceId, setCustomVoiceId] = useState('');

  useEffect(() => {
    const loaded = loadVoicePreference();
    setVoice(loaded);
    if (loaded.mode === 'custom') setCustomVoiceId(loaded.voiceId);
    void customizationApi.fetchCustomization().then((loadedCustomization) => {
      if (loadedCustomization !== null && loadedCustomization.systemName.length > 0) {
        setName(loadedCustomization.systemName);
      }
      setLoading(false);
    });
  }, [customizationApi]);

  const handleContinue = async (): Promise<void> => {
    if (voice.mode === 'custom' && voice.voiceId === '') {
      setError('Enter an ElevenLabs voice ID');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      saveVoicePreference(voice);
      await customizationApi.saveCustomization(
        { systemName: name, profilePicture: null, customSystemPrompt: '' },
        { voicePreferenceId: voice.voiceId === '' ? null : voice.voiceId }
      );
      onComplete();
    } catch (err) {
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
    <div className="flex-1 flex flex-col px-8 pt-6 pb-20 overflow-y-auto relative">
      <BackgroundTiles />
      <div className="text-center mb-6 relative z-10">
        <h1 className="text-2xl font-semibold text-foreground">Create your Agent</h1>
      </div>
      <div className="flex-1 max-w-md mx-auto w-full space-y-8 relative z-10">
        <VoiceSelector
          value={voice}
          customVoiceId={customVoiceId}
          disabled={saving}
          onChange={setVoice}
          onCustomVoiceIdChange={setCustomVoiceId}
        />
        <NameField name={name} saving={saving} setName={setName} />
      </div>
      {error !== null && error.length > 0 ? (
        <div className="max-w-md mx-auto w-full mt-4 p-3 bg-destructive/10 border border-destructive rounded-lg text-sm text-destructive relative z-10">
          {error}
        </div>
      ) : null}
      <div className="max-w-md mx-auto w-full mt-6 relative z-10">
        <ContinueButton
          saving={saving}
          onClick={() => {
            void handleContinue();
          }}
        />
      </div>
    </div>
  );
};

export default OnboardingCustomization;
