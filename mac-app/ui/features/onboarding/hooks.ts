import { useState, useEffect, useRef } from 'react';
import { sendOTP, verifyOTP } from '@/features/auth/api';
import { isSubmittablePhone } from '@/lib/phone';
import { getErrorMessageOrFallback } from '../../../shared/utils/error';
import {
  createPlaidLinkToken,
  checkWaitlistStatus,
  createSubscriptionCheckoutUrl,
  exchangePlaidPublicToken,
  fetchCustomPreviewUrl,
  fetchCustomization,
  fetchIntegrations,
  fetchPlaidItems,
  resolvePresetSamplePath,
  redeemInviteCode,
  saveCustomization,
  sendPasswordIntegrationRequest,
  spawnLinkedInSyncAgent,
  startGmailOAuth,
  uploadApplePasswords,
} from './api';
import { RESEND_COOLDOWN_SECONDS } from './config';
import type { AuthStep, UseOnboardingAuthResult } from './types';

const ONBOARDING_CUSTOMIZATION_API: {
  fetchCustomization: typeof fetchCustomization;
  saveCustomization: typeof saveCustomization;
} = { fetchCustomization, saveCustomization };

const ONBOARDING_DATA_API: {
  fetchIntegrations: typeof fetchIntegrations;
  startGmailOAuth: typeof startGmailOAuth;
  uploadApplePasswords: typeof uploadApplePasswords;
  sendPasswordIntegrationRequest: typeof sendPasswordIntegrationRequest;
  spawnLinkedInSyncAgent: typeof spawnLinkedInSyncAgent;
  createPlaidLinkToken: typeof createPlaidLinkToken;
  exchangePlaidPublicToken: typeof exchangePlaidPublicToken;
  fetchPlaidItems: typeof fetchPlaidItems;
} = {
  fetchIntegrations,
  startGmailOAuth,
  uploadApplePasswords,
  sendPasswordIntegrationRequest,
  spawnLinkedInSyncAgent,
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  fetchPlaidItems,
};

const ONBOARDING_WAITLIST_API: {
  checkWaitlistStatus: typeof checkWaitlistStatus;
  redeemInviteCode: typeof redeemInviteCode;
  createSubscriptionCheckoutUrl: typeof createSubscriptionCheckoutUrl;
} = { checkWaitlistStatus, redeemInviteCode, createSubscriptionCheckoutUrl };

export const useOnboardingCustomizationApi = (): typeof ONBOARDING_CUSTOMIZATION_API =>
  ONBOARDING_CUSTOMIZATION_API;

export const useOnboardingDataApi = (): typeof ONBOARDING_DATA_API => ONBOARDING_DATA_API;

export const useOnboardingWaitlistApi = (): typeof ONBOARDING_WAITLIST_API =>
  ONBOARDING_WAITLIST_API;

const resolveVoicePreviewUrl = async (
  voiceId: string,
  isCustom: boolean
): Promise<string | null> => {
  if (!isCustom) return resolvePresetSamplePath(voiceId);
  return fetchCustomPreviewUrl(voiceId);
};

export const useVoicePreviewAudio = (
  isCustom: boolean,
  customVoiceId: string,
  presetVoiceId: string | null
): void => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastPlayedRef = useRef<string | null>(null);

  useEffect(() => {
    const id = isCustom ? customVoiceId.trim() : (presetVoiceId ?? '');
    if (id === '' || id === lastPlayedRef.current) return;
    lastPlayedRef.current = id;
    let cancelled = false;
    void (async () => {
      const url = await resolveVoicePreviewUrl(id, isCustom);
      if (cancelled || url === null) return;
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      audio.pause();
      audio.src = url;
      audio.currentTime = 0;
      try {
        await audio.play();
      } catch {
        /* autoplay blocked / file missing - silent */
      }
    })();
    return () => {
      cancelled = true;
      if (audioRef.current !== null) audioRef.current.pause();
    };
  }, [isCustom, customVoiceId, presetVoiceId]);
};

export const useOnboardingAuth = (onComplete: () => void): UseOnboardingAuthResult => {
  const [step, setStep] = useState<AuthStep>('signup');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [smsAuthorized, setSmsAuthorized] = useState(false);
  const [resendCountdown, setResendCountdown] = useState(0);

  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setTimeout(() => setResendCountdown(resendCountdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCountdown]);

  // Phone state is canonical E.164 (set by PhoneInput's country selector).
  const isFormValid =
    firstName.trim().length > 0 && lastName.trim().length > 0 && isSubmittablePhone(phone);

  const submitPhone = async (phoneValue: string): Promise<boolean> => {
    try {
      await sendOTP(phoneValue);
      setResendCountdown(RESEND_COOLDOWN_SECONDS);
      return true;
    } catch (err) {
      setError(getErrorMessageOrFallback(err, 'Failed to send verification code'));
      return false;
    }
  };

  const handleSignupSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!isFormValid) return;
    setLoading(true);
    setError(null);
    void submitPhone(phone).then((ok) => {
      if (ok) setStep('otp');
      setLoading(false);
    });
  };

  const handleResendOTP = (): void => {
    if (resendCountdown > 0) return;
    setLoading(true);
    setError(null);
    void submitPhone(phone).then(() => setLoading(false));
  };

  const handleOtpSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!smsAuthorized) return;
    setLoading(true);
    setError(null);
    void verifyOTP(phone, otp, undefined, { firstName, lastName })
      .then(() => onComplete())
      .catch((err: unknown) => {
        setError(getErrorMessageOrFallback(err, 'Invalid verification code'));
      })
      .finally(() => setLoading(false));
  };

  const handleBackToSignup = (): void => {
    setStep('signup');
    setOtp('');
    setError(null);
    setResendCountdown(0);
  };

  // prettier-ignore
  return { step, loading, error, firstName, lastName, phone, otp, smsAuthorized, resendCountdown, isFormValid, setFirstName, setLastName, setPhone, setOtp, setSmsAuthorized, handleSignupSubmit, handleOtpSubmit, handleResendOTP, handleBackToSignup };
};
