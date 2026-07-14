/**
 * STATE MACHINE: PhoneAuthModal
 *
 * MODAL VISIBILITY:
 * [CLOSED] <-- open: false
 *     |
 *     v (parent sets open=true)
 * [OPEN]
 *
 * AUTH FLOW (step state):
 * [PHONE_STEP] <-- step: 'phone'
 *     |
 *     | (submit phone)
 *     v
 * [LOADING] <-- loading: true
 *     |
 *     v (OTP sent)
 * [OTP_STEP] <-- step: 'otp'
 *     |
 *     | (submit OTP)
 *     v
 * [LOADING] <-- loading: true
 *     |
 *     +--> (success) --> onAuthComplete() --> [CLOSED]
 *     +--> (error) --> toast error --> [OTP_STEP]
 *
 * States:
 * - step: 'phone' | 'otp'
 * - phone: string (E.164, e.g. +5215512345678 — set by PhoneInput's country selector)
 * - otp: string (6-digit code)
 * - loading: boolean
 */

import { Dialog, DialogContent } from '@/components/ui/dialog';

import type { PhoneAuthModalProps } from '../types';
import { usePhoneAuth } from '../hooks';

import PhoneStep from './PhoneStep';
import OtpStep from './OtpStep';

const MODAL_STYLE = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  backgroundColor: 'rgba(238, 239, 242, 0.95)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(12px)',
} as const;

const PhoneAuthModal = ({
  open,
  onOpenChange,
  onAuthComplete,
  anonymousUserId,
  title,
}: PhoneAuthModalProps) => {
  const auth = usePhoneAuth(onOpenChange, onAuthComplete, anonymousUserId);

  return (
    <Dialog open={open} onOpenChange={auth.handleClose} modal={false}>
      <DialogContent
        className="p-0 border border-gray-300 shadow-lg [&>button]:hidden overflow-visible z-[100] w-[380px] max-w-[90vw] relative rounded-xl"
        style={MODAL_STYLE}
      >
        {auth.step === 'phone' && (
          <PhoneStep
            phone={auth.phone}
            onPhoneChange={auth.setPhone}
            loading={auth.loading}
            onSubmit={auth.handleSendOTP}
            onClose={auth.handleClose}
            title={title}
          />
        )}
        {auth.step === 'otp' && (
          <OtpStep
            phone={auth.phone}
            otp={auth.otp}
            onOtpChange={auth.setOtp}
            loading={auth.loading}
            smsAuthorized={auth.smsAuthorized}
            onSmsAuthorizedChange={auth.setSmsAuthorized}
            onSubmit={auth.handleVerifyOTP}
            onBack={auth.handleBack}
            onClose={auth.handleClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};

export default PhoneAuthModal;
