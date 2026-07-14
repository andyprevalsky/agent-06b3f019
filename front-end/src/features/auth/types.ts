export type AuthStep = 'phone' | 'otp';

export interface PhoneAuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAuthComplete?: () => void;
  anonymousUserId?: string;
  title?: string;
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
  title?: string;
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
