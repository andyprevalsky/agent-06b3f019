import { useCallback, useState } from 'react';

import type { AuthStep } from '../types';

/** Internal form state shared by the phone and OTP auth steps. */
export function useAuthFormState() {
  const [step, setStep] = useState<AuthStep>('phone');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [smsAuthorized, setSmsAuthorized] = useState(false);
  const resetForm = useCallback(() => {
    setStep('phone');
    setPhone('');
    setEmail('');
    setFirstName('');
    setLastName('');
    setOtp('');
    setSmsAuthorized(false);
  }, []);

  return {
    step,
    setStep,
    phone,
    setPhone,
    email,
    setEmail,
    firstName,
    setFirstName,
    lastName,
    setLastName,
    otp,
    setOtp,
    loading,
    setLoading,
    smsAuthorized,
    setSmsAuthorized,
    resetForm,
  };
}
