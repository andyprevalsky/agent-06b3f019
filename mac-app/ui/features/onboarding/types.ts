import type { BrowserInfo, BrowserType } from '../../../shared/types/ipc';

export type { BrowserInfo, BrowserType };

export type OnboardingStep = 'auth' | 'customization' | 'data' | 'shortcut' | 'welcome' | 'payment';

export type AuthStep = 'signup' | 'otp';

export interface Integration {
  id: string;
  name: string;
  status: string;
  isActive?: boolean;
  config?: {
    connectedEmail?: string;
    connectedEmails?: string[];
    cookieCount?: number;
    fingerprint?: unknown;
  };
}

export interface UserSettingsResponse {
  systemName?: string | null;
  profilePicture?: string | null;
  customSystemPrompt?: string | null;
  voicePreferenceId?: string | null;
  onboardingCompletedAt?: string | null;
}

export interface ShortcutConfig {
  modifiers: string[];
  key: string;
}

export interface UseOnboardingAuthResult {
  step: AuthStep;
  loading: boolean;
  error: string | null;
  firstName: string;
  lastName: string;
  phone: string;
  otp: string;
  smsAuthorized: boolean;
  resendCountdown: number;
  isFormValid: boolean;
  setFirstName: (v: string) => void;
  setLastName: (v: string) => void;
  setPhone: (v: string) => void;
  setOtp: (v: string) => void;
  setSmsAuthorized: (v: boolean) => void;
  handleSignupSubmit: (e: React.FormEvent) => void;
  handleOtpSubmit: (e: React.FormEvent) => void;
  handleResendOTP: () => void;
  handleBackToSignup: () => void;
}
