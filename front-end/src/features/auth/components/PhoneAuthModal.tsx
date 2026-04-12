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
 * - phone: string (formatted phone number)
 * - otp: string (6-digit code)
 * - loading: boolean
 * - modalPosition: { top, left } (positioned relative to trigger)
 */

import { Dialog, DialogContent } from '@/components/ui/dialog';

import type { PhoneAuthModalProps } from '../types';
import { useModalPosition, usePhoneAuth } from '../hooks';

import PhoneStep from './PhoneStep';
import OtpStep from './OtpStep';

const MODAL_STYLE_BASE = {
  transform: 'translate(-50%, -100%)',
  backgroundColor: 'rgba(238, 239, 242, 0.95)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(12px)',
} as const;

const PhoneAuthModal = ({
  open,
  onOpenChange,
  triggerRef,
  onAuthComplete,
  anonymousUserId,
}: PhoneAuthModalProps) => {
  const modalPosition = useModalPosition(open, triggerRef);
  const auth = usePhoneAuth(onOpenChange, onAuthComplete, anonymousUserId);

  return (
    <Dialog open={open} onOpenChange={auth.handleClose} modal={false}>
      <DialogContent
        className="p-0 border border-gray-300 shadow-lg [&>button]:hidden overflow-visible z-[100] w-[380px] max-w-[90vw] relative rounded-xl"
        style={{
          position: 'fixed',
          top: `${modalPosition.top}px`,
          left: `${modalPosition.left}px`,
          ...MODAL_STYLE_BASE,
        }}
      >
        <ModalArrow />
        {auth.step === 'phone' && (
          <PhoneStep
            phone={auth.phone}
            onPhoneChange={auth.setPhone}
            loading={auth.loading}
            onSubmit={auth.handleSendOTP}
            onClose={auth.handleClose}
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

/** Downward-pointing arrow/nub below the modal. */
function ModalArrow() {
  return (
    <>
      <div
        className="absolute left-1/2 -translate-x-1/2 w-0 h-0"
        style={{
          bottom: '-12px',
          borderLeft: '12px solid transparent',
          borderRight: '12px solid transparent',
          borderTop: '12px solid rgba(238, 239, 242, 0.95)',
        }}
      />
      <div
        className="absolute left-1/2 -translate-x-1/2 w-0 h-0"
        style={{
          bottom: '-13px',
          borderLeft: '13px solid transparent',
          borderRight: '13px solid transparent',
          borderTop: '13px solid rgb(209, 213, 219)',
          zIndex: -1,
        }}
      />
    </>
  );
}

export default PhoneAuthModal;
