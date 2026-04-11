import { useState, useEffect, useCallback, type RefObject } from 'react';
import { useToast } from '@/hooks/use-toast';
import * as amplitude from '@amplitude/analytics-browser';

import { sendOTP, verifyOTP } from './api';
import type { AuthStep } from './types';

/** Extract a human-readable message from an unknown error value. */
function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return fallback;
}

/** Appends area-code / exchange / subscriber formatting to a prefix. */
function appendUSFormatted(prefix: string, digits: string): string {
  let out = prefix + '(' + digits.slice(0, 3);
  if (digits.length >= 3) {
    out += ')';
    if (digits.length > 3) {
      out += '-' + digits.slice(3, 6);
      if (digits.length > 6) out += '-' + digits.slice(6, 10);
    }
  }
  return out;
}

/** Formats a raw digit string into a display phone number: +1 (XXX)-XXX-XXXX. */
export function formatPhoneNumber(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return '';
  if (digits[0] === '1') {
    const rest = digits.slice(1);
    return rest.length === 0 ? '+1' : appendUSFormatted('+1 ', rest);
  }
  if (digits.length <= 10) return appendUSFormatted('+1 ', digits);
  return '+' + digits;
}

/** Strips a formatted phone number to E.164: +19729777432. */
export function stripPhoneNumber(formatted: string): string {
  return '+' + formatted.replace(/\D/g, '');
}

/** Calculates modal position centered above the trigger element. */
export function useModalPosition(open: boolean, triggerRef: RefObject<HTMLDivElement>) {
  const [modalPosition, setModalPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setModalPosition({
        top: rect.top + 24,
        left: rect.left + rect.width / 2,
      });
    }
  }, [open, triggerRef]);

  return modalPosition;
}

/** Show an error toast from an unknown thrown value. */
function toastError(
  toast: ReturnType<typeof useToast>['toast'],
  title: string,
  error: unknown,
  fallback: string,
) {
  console.error(title, error);
  toast({ title, description: getErrorMessage(error, fallback), variant: 'destructive' });
}

/** Internal form state for the phone auth flow. */
function useAuthFormState() {
  const [step, setStep] = useState<AuthStep>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [smsAuthorized, setSmsAuthorized] = useState(false);
  const resetForm = useCallback(() => {
    setStep('phone');
    setPhone('');
    setOtp('');
    setSmsAuthorized(false);
  }, []);
  return {
    step,
    setStep,
    phone,
    setPhone,
    otp,
    setOtp,
    loading,
    setLoading,
    smsAuthorized,
    setSmsAuthorized,
    resetForm,
  };
}

/** Manages the full phone auth flow (phone -> OTP -> verified). */
export function usePhoneAuth(
  onOpenChange: (open: boolean) => void,
  onAuthComplete?: () => void,
  anonymousUserId?: string,
) {
  const { toast } = useToast();
  const form = useAuthFormState();

  const completeAuth = useCallback(() => {
    toast({ title: 'Success!', description: "You're now logged in." });
    form.setLoading(false);
    onOpenChange(false);
    form.resetForm();
    onAuthComplete?.();
  }, [onOpenChange, onAuthComplete, toast, form]);

  const handleSendOTP = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      form.setLoading(true);
      try {
        await sendOTP(stripPhoneNumber(form.phone));
        amplitude.track('phone_entered');
        form.setStep('otp');
        toast({ title: 'Code sent!', description: 'Check your phone for the 6-digit code.' });
      } catch (error: unknown) {
        toastError(toast, 'Error', error, 'Failed to send code. Please try again.');
      } finally {
        form.setLoading(false);
      }
    },
    [form, toast],
  );

  const handleVerifyOTP = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      form.setLoading(true);
      try {
        const strippedPhone = stripPhoneNumber(form.phone);
        await verifyOTP(strippedPhone, form.otp, anonymousUserId);
        amplitude.track('otp_code_submitted');
        amplitude.setUserId(strippedPhone);
        await new Promise((resolve) => setTimeout(resolve, 100));
        completeAuth();
      } catch (error: unknown) {
        toastError(toast, 'Invalid code', error, 'Please check the code and try again.');
        form.setLoading(false);
      }
    },
    [form, anonymousUserId, completeAuth, toast],
  );

  return {
    step: form.step,
    phone: form.phone,
    setPhone: form.setPhone,
    otp: form.otp,
    setOtp: form.setOtp,
    loading: form.loading,
    smsAuthorized: form.smsAuthorized,
    setSmsAuthorized: form.setSmsAuthorized,
    handleSendOTP,
    handleVerifyOTP,
    handleBack: useCallback(() => {
      form.setStep('phone');
      form.setOtp('');
      form.setSmsAuthorized(false);
    }, [form]),
    handleClose: useCallback(() => {
      onOpenChange(false);
      setTimeout(form.resetForm, 200);
    }, [onOpenChange, form]),
  } as const;
}
