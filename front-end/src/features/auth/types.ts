export type AuthStep = 'phone' | 'otp';

export interface PhoneAuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAuthComplete?: () => void;
  anonymousUserId?: string;
  title?: string;
  collectName?: boolean;
}

export interface ProtectedRouteProps {
  children: React.ReactNode;
}

export interface PhoneStepProps {
  phone: string;
  onPhoneChange: (value: string) => void;
  email: string;
  onEmailChange: (value: string) => void;
  firstName: string;
  onFirstNameChange: (value: string) => void;
  lastName: string;
  onLastNameChange: (value: string) => void;
  collectName: boolean;
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
