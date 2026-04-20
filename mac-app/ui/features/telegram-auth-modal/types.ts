/**
 * Types for the telegram-auth-modal feature.
 *
 * Props cross the feature boundary (parent passes callbacks + open flag).
 * Hook-result types are feature-internal — exported for component typing.
 */

export interface TelegramAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * The authentication flow walks through three steps in order:
 *   phone → (main process sends needCode) → code → (optional needPassword) → password
 * Each step owns a dedicated input and submit handler.
 */
export type AuthStep = 'phone' | 'code' | 'password';

/**
 * Result of the `useTelegramAuthModal` hook — all state + handlers a renderer
 * needs to draw the modal in its current state. The component is a pure
 * renderer over this shape.
 */
export interface UseTelegramAuthModalResult {
  step: AuthStep;
  phoneNumber: string;
  code: string;
  password: string;
  loading: boolean;
  error: string | null;
  setPhoneNumber: (value: string) => void;
  setCode: (value: string) => void;
  setPassword: (value: string) => void;
  handleSubmit: () => void;
  handleClose: () => void;
  handleBackToPhone: () => void;
  getSubmitLabel: () => string;
}
