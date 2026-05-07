import { useState, useEffect } from 'react';
import { sendOTP, verifyOTP } from '@/features/auth/api';
import {
  fetchCustomization,
  fetchIntegrations,
  fetchUserSettings,
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
  fetchUserSettings: typeof fetchUserSettings;
  startGmailOAuth: typeof startGmailOAuth;
  uploadApplePasswords: typeof uploadApplePasswords;
  sendPasswordIntegrationRequest: typeof sendPasswordIntegrationRequest;
  spawnLinkedInSyncAgent: typeof spawnLinkedInSyncAgent;
} = {
  fetchIntegrations,
  fetchUserSettings,
  startGmailOAuth,
  uploadApplePasswords,
  sendPasswordIntegrationRequest,
  spawnLinkedInSyncAgent,
};

export const useOnboardingCustomizationApi = (): typeof ONBOARDING_CUSTOMIZATION_API =>
  ONBOARDING_CUSTOMIZATION_API;

export const useOnboardingDataApi = (): typeof ONBOARDING_DATA_API => ONBOARDING_DATA_API;

// Format phone number as user types: +1 (XXX)-XXX-XXXX
export const formatPhoneNumber = (value: string): string => {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return '';

  if (digits[0] === '1') {
    let formatted = '+1';
    const remaining = digits.slice(1);
    if (remaining.length > 0) {
      formatted += ' (' + remaining.slice(0, 3);
      if (remaining.length >= 3) {
        formatted += ')';
        if (remaining.length > 3) {
          formatted += '-' + remaining.slice(3, 6);
          if (remaining.length > 6) {
            formatted += '-' + remaining.slice(6, 10);
          }
        }
      }
    }
    return formatted;
  }

  if (digits.length <= 10) {
    let formatted = '+1 (' + digits.slice(0, 3);
    if (digits.length >= 3) {
      formatted += ')';
      if (digits.length > 3) {
        formatted += '-' + digits.slice(3, 6);
        if (digits.length > 6) {
          formatted += '-' + digits.slice(6, 10);
        }
      }
    }
    return formatted;
  }

  return '+' + digits;
};

const stripPhoneNumber = (formatted: string): string => {
  return '+' + formatted.replace(/\D/g, '');
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

  const isPhoneValid = (): boolean => phone.replace(/\D/g, '').length >= 11;
  const isFormValid = firstName.trim().length > 0 && lastName.trim().length > 0 && isPhoneValid();

  const submitPhone = async (phoneValue: string): Promise<boolean> => {
    try {
      await sendOTP(stripPhoneNumber(phoneValue));
      setResendCountdown(RESEND_COOLDOWN_SECONDS);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send verification code');
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
    void verifyOTP(stripPhoneNumber(phone), otp, undefined, { firstName, lastName })
      .then(() => onComplete())
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Invalid verification code');
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
