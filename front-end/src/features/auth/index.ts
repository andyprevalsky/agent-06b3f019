/**
 * Auth feature — public API barrel.
 *
 * External consumers import from `features/auth`, never from internal layers.
 */

// Types
export type { AuthStep, PhoneAuthModalProps, ProtectedRouteProps } from './types';

// Hooks
export { formatPhoneNumber, stripPhoneNumber, useModalPosition, usePhoneAuth } from './hooks';

// Components
export { default as LoginButton } from './components/LoginButton';
export { default as PhoneAuthModal } from './components/PhoneAuthModal';
export { ProtectedRoute } from './components/ProtectedRoute';
