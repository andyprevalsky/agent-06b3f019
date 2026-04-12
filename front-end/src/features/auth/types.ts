import type { RefObject } from 'react';

export type AuthStep = 'phone' | 'otp';

export interface PhoneAuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLDivElement>;
  onAuthComplete?: () => void;
  anonymousUserId?: string;
}

export interface ProtectedRouteProps {
  children: React.ReactNode;
}

export interface PhoneStepProps {
  phone: string;
  onPhoneChange: (value: string) => void;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => Promise<void>;
  onClose: () => void;
}

export interface OtpStepProps {
  phone: string;
  otp: string;
  onOtpChange: (value: string) => void;
  loading: boolean;
  smsAuthorized: boolean;
  onSmsAuthorizedChange: (value: boolean) => void;
  onSubmit: (e: React.FormEvent) => Promise<void>;
  onBack: () => void;
  onClose: () => void;
}
