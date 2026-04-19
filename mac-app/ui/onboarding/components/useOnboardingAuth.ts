import { useState, useEffect } from 'react';
import { sendOTP, verifyOTP } from '@/features/auth/api';
import { stripPhoneNumber } from './OnboardingAuthShared';

export type AuthStep = 'signup' | 'otp';

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
      setResendCountdown(30);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send verification code');
      return false;
    }
  };

  const handleSignupSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) return;
    setLoading(true);
    setError(null);
    void submitPhone(phone).then((ok) => {
      if (ok) setStep('otp');
      setLoading(false);
    });
  };

  const handleResendOTP = () => {
    if (resendCountdown > 0) return;
    setLoading(true);
    setError(null);
    void submitPhone(phone).then(() => setLoading(false));
  };

  const handleOtpSubmit = (e: React.FormEvent) => {
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

  const handleBackToSignup = () => {
    setStep('signup');
    setOtp('');
    setError(null);
    setResendCountdown(0);
  };

  // prettier-ignore
  return { step, loading, error, firstName, lastName, phone, otp, smsAuthorized, resendCountdown, isFormValid, setFirstName, setLastName, setPhone, setOtp, setSmsAuthorized, handleSignupSubmit, handleOtpSubmit, handleResendOTP, handleBackToSignup };
};
