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
import { useToast } from '@/hooks/use-toast';
import { useState, useEffect, type RefObject } from 'react';
import { sendOTP, verifyOTP } from '@/lib/supabase';
import { X } from 'lucide-react';
import * as amplitude from '@amplitude/analytics-browser';

interface PhoneAuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLDivElement>;
  onAuthComplete?: () => void; // Called when user is fully signed in
  anonymousUserId?: string; // Pass this to merge anonymous user's agents on login
}

const PhoneAuthModal = ({
  open,
  onOpenChange,
  triggerRef,
  onAuthComplete,
  anonymousUserId,
}: PhoneAuthModalProps) => {
  const { toast } = useToast();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [modalPosition, setModalPosition] = useState({ top: 0, left: 0 });
  const [smsAuthorized, setSmsAuthorized] = useState(false);

  // Calculate modal position based on QueryInput
  useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setModalPosition({
        top: rect.top + 24, // Position above the QueryInput with 8px gap (for arrow)
        left: rect.left + rect.width / 2, // Center horizontally
      });
    }
  }, [open, triggerRef]);

  // Format phone number as user types: +1 (XXX)-XXX-XXXX
  const formatPhoneNumber = (value: string) => {
    // Strip to just digits
    const digits = value.replace(/\D/g, '');

    // Build formatted string
    let formatted = '';

    if (digits.length === 0) {
      return '';
    }

    // Handle country code (assume US +1 if starts with 1 or has 10+ digits)
    if (digits.length >= 1) {
      if (digits[0] === '1') {
        formatted = '+1';
        const remaining = digits.slice(1);
        if (remaining.length > 0) {
          formatted += ' (' + remaining.slice(0, 3);
          if (remaining.length >= 3) {
            formatted += ')';
            if (remaining.length > 3) {
              formatted += '-' + remaining.slice(3, 6);
              if (remaining.length > 6) {
                formatted += '-' + remaining.slice(6, 10);
              }
            }
          }
        }
      } else if (digits.length <= 10) {
        // Assume US number without country code
        formatted = '+1 (' + digits.slice(0, 3);
        if (digits.length >= 3) {
          formatted += ')';
          if (digits.length > 3) {
            formatted += '-' + digits.slice(3, 6);
            if (digits.length > 6) {
              formatted += '-' + digits.slice(6, 10);
            }
          }
        }
      } else {
        // International number - just format with +
        formatted = '+' + digits;
      }
    }

    return formatted;
  };

  // Strip phone to E.164 format for API: +19729777432
  const stripPhoneNumber = (formatted: string) => {
    return '+' + formatted.replace(/\D/g, '');
  };

  const handleSendOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const strippedPhone = stripPhoneNumber(phone);

      // Always use standard OTP flow - this handles both:
      // - New users (creates account)
      // - Existing users (signs into existing account)
      // Anonymous users will get a new session for their phone number
      await sendOTP(strippedPhone);

      // Track phone entered event
      amplitude.track('phone_entered');

      setStep('otp');
      toast({
        title: 'Code sent!',
        description: 'Check your phone for the 6-digit code.',
      });
    } catch (error: any) {
      console.error('Send OTP error:', error);
      toast({
        title: 'Error',
        description: error.message || 'Failed to send code. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const strippedPhone = stripPhoneNumber(phone);

      // Verify OTP - creates new session for the phone number
      // Pass anonymousUserId to merge any agents created while anonymous
      await verifyOTP(strippedPhone, otp, anonymousUserId);

      // Track in Amplitude
      amplitude.track('otp_code_submitted');
      amplitude.setUserId(strippedPhone);

      // Small delay to let Supabase finish internal state updates
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Complete the flow (no invite code needed anymore)
      completeAuth();
    } catch (error: any) {
      console.error('Verify OTP error:', error);
      toast({
        title: 'Invalid code',
        description: error.message || 'Please check the code and try again.',
        variant: 'destructive',
      });
      setLoading(false);
    }
  };

  // Called when auth flow is fully complete
  const completeAuth = () => {
    toast({
      title: 'Success!',
      description: "You're now logged in.",
    });
    setLoading(false);
    onOpenChange(false);

    // Reset state
    setStep('phone');
    setPhone('');
    setOtp('');

    // Notify parent that auth is complete
    onAuthComplete?.();
  };

  const handleBack = () => {
    setStep('phone');
    setOtp('');
    setSmsAuthorized(false);
  };

  const handleClose = () => {
    onOpenChange(false);
    // Reset state after animation
    setTimeout(() => {
      setStep('phone');
      setPhone('');
      setOtp('');
      setSmsAuthorized(false);
    }, 200);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose} modal={false}>
      <DialogContent
        className="p-0 border border-gray-300 shadow-lg [&>button]:hidden overflow-visible z-[100] w-[380px] max-w-[90vw] relative rounded-xl"
        style={{
          position: 'fixed',
          top: `${modalPosition.top}px`,
          left: `${modalPosition.left}px`,
          transform: 'translate(-50%, -100%)',
          backgroundColor: 'rgba(238, 239, 242, 0.95)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      >
        {/* Downward-pointing arrow/nub */}
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
        {step === 'phone' && (
          <form onSubmit={handleSendOTP} className="p-6">
            {/* Header: Logo left, X right */}
            <div className="flex items-start justify-between mb-6">
              <svg className="w-8 h-8" viewBox="21 62 220 222" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <linearGradient id="phoneauth-logo-gradient" x1="100%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#FE7503" />
                    <stop offset="25%" stopColor="#FC585C" />
                    <stop offset="50%" stopColor="#E062CC" />
                    <stop offset="75%" stopColor="#A76CED" />
                    <stop offset="100%" stopColor="#7A6BEC" />
                  </linearGradient>
                </defs>
                <g
                  transform="translate(0,303) scale(0.1,-0.1)"
                  fill="url(#phoneauth-logo-gradient)"
                >
                  <path d="M1276 2378 c-145 -192 -231 -442 -211 -616 8 -68 41 -202 61 -251 8 -19 13 -35 11 -37 -2 -2 -30 7 -62 21 -249 100 -537 54 -784 -124 -36 -25 -69 -49 -75 -53 -17 -11 22 -46 119 -105 163 -101 300 -144 460 -144 92 -1 226 24 301 56 20 8 38 15 39 15 2 0 -10 -39 -25 -87 -69 -213 -58 -395 36 -600 31 -69 136 -237 154 -248 10 -6 114 144 152 220 37 73 75 199 88 293 14 101 1 206 -40 330 -15 48 -27 88 -26 89 1 2 26 -7 55 -18 195 -74 423 -66 611 22 98 46 217 118 245 149 18 20 18 21 -1 35 -177 139 -396 225 -570 225 -79 0 -195 -23 -282 -56 -44 -16 -63 -20 -59 -11 27 72 60 196 68 260 17 132 -17 300 -89 442 -36 72 -124 209 -141 219 -5 4 -21 -8 -35 -26z m40 -935 c7 -46 50 -92 109 -119 27 -13 41 -23 31 -23 -11 -1 -38 -12 -62 -26 -49 -29 -83 -90 -85 -151 -1 -37 -2 -36 -9 13 -4 29 -17 67 -28 85 -22 35 -86 77 -118 79 -11 0 1 9 26 20 79 35 118 90 121 168 1 25 3 28 6 11 2 -14 6 -39 9 -57z" />
                </g>
              </svg>
              <button
                type="button"
                onClick={handleClose}
                className="text-gray-400 hover:text-gray-600 transition-colors p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Titles */}
            <div className="mb-6">
              <h2 className="text-2xl font-semibold text-navi-black">Start Building.</h2>
              <p className="text-xl text-gray-400 mt-1">Create free account</p>
            </div>

            {/* Phone Input */}
            <div className="space-y-4">
              <div>
                <label htmlFor="phone" className="block text-sm text-gray-500 mb-1">
                  Phone Number
                </label>
                <input
                  id="phone"
                  type="tel"
                  placeholder="+1 (972)-977-7432"
                  value={phone}
                  onChange={(e) => setPhone(formatPhoneNumber(e.target.value))}
                  required
                  className="w-full px-3 py-2 bg-[#EEEFF2] border border-gray-300 rounded-lg text-navi-black text-sm placeholder-navi-black/30 focus:outline-none focus:border-gray-400"
                  disabled={loading}
                />
                <p className="text-xs text-gray-500 mt-2">
                  By submitting, you authorize Rose Labs to send an automated text message
                  containing a one-time password (OTP) to the number you provided. Message/data
                  rates may apply. See{' '}
                  <a
                    href="https://roselabs.ai/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-navi-black"
                  >
                    terms
                  </a>{' '}
                  and{' '}
                  <a
                    href="https://roselabs.ai/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-navi-black"
                  >
                    privacy policy
                  </a>
                  .
                </p>
              </div>

              <button
                type="submit"
                disabled={loading || !phone}
                className="w-full px-3 py-2 bg-navi-black text-white text-sm rounded-lg hover:bg-navi-black/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Sending...' : 'Continue'}
              </button>
            </div>
          </form>
        )}
        {step === 'otp' && (
          <form onSubmit={handleVerifyOTP} className="p-6">
            {/* Header: Logo left, X right */}
            <div className="flex items-start justify-between mb-6">
              <svg className="w-8 h-8" viewBox="21 62 220 222" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <linearGradient id="phoneauth-logo-gradient" x1="100%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#FE7503" />
                    <stop offset="25%" stopColor="#FC585C" />
                    <stop offset="50%" stopColor="#E062CC" />
                    <stop offset="75%" stopColor="#A76CED" />
                    <stop offset="100%" stopColor="#7A6BEC" />
                  </linearGradient>
                </defs>
                <g
                  transform="translate(0,303) scale(0.1,-0.1)"
                  fill="url(#phoneauth-logo-gradient)"
                >
                  <path d="M1276 2378 c-145 -192 -231 -442 -211 -616 8 -68 41 -202 61 -251 8 -19 13 -35 11 -37 -2 -2 -30 7 -62 21 -249 100 -537 54 -784 -124 -36 -25 -69 -49 -75 -53 -17 -11 22 -46 119 -105 163 -101 300 -144 460 -144 92 -1 226 24 301 56 20 8 38 15 39 15 2 0 -10 -39 -25 -87 -69 -213 -58 -395 36 -600 31 -69 136 -237 154 -248 10 -6 114 144 152 220 37 73 75 199 88 293 14 101 1 206 -40 330 -15 48 -27 88 -26 89 1 2 26 -7 55 -18 195 -74 423 -66 611 22 98 46 217 118 245 149 18 20 18 21 -1 35 -177 139 -396 225 -570 225 -79 0 -195 -23 -282 -56 -44 -16 -63 -20 -59 -11 27 72 60 196 68 260 17 132 -17 300 -89 442 -36 72 -124 209 -141 219 -5 4 -21 -8 -35 -26z m40 -935 c7 -46 50 -92 109 -119 27 -13 41 -23 31 -23 -11 -1 -38 -12 -62 -26 -49 -29 -83 -90 -85 -151 -1 -37 -2 -36 -9 13 -4 29 -17 67 -28 85 -22 35 -86 77 -118 79 -11 0 1 9 26 20 79 35 118 90 121 168 1 25 3 28 6 11 2 -14 6 -39 9 -57z" />
                </g>
              </svg>
              <button
                type="button"
                onClick={handleClose}
                className="text-gray-400 hover:text-gray-600 transition-colors p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Titles */}
            <div className="mb-6">
              <h2 className="text-2xl font-semibold text-navi-black">Verify Code</h2>
              <p className="text-xl text-gray-400 mt-1">Code sent to {phone}</p>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="otp" className="block text-sm text-gray-500 mb-1">
                  Verification Code
                </label>
                <input
                  id="otp"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  placeholder="000000"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                  required
                  className="w-full px-3 py-2 bg-[#EEEFF2] border border-gray-300 rounded-lg text-navi-black text-center text-sm font-mono tracking-widest placeholder-navi-black/30 focus:outline-none focus:border-gray-400"
                  disabled={loading}
                  autoFocus
                />
              </div>

              {/* SMS Authorization checkbox */}
              <label className="flex items-start gap-3 p-3 bg-white/50 border border-gray-300 rounded-lg cursor-pointer">
                <input
                  type="checkbox"
                  checked={smsAuthorized}
                  onChange={(e) => setSmsAuthorized(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-gray-300 text-navi-black focus:ring-0 focus:ring-offset-0"
                />
                <div className="flex-1">
                  <span className="text-sm font-medium text-navi-black">
                    I authorize SMS communication
                  </span>
                  <p className="text-xs text-gray-500 mt-1">
                    I authorize Rose Labs to send automated SMS messages to the phone number
                    provided, including task updates, reminders, and status notifications. Message
                    frequency varies. Message and data rates may apply. Text HELP for help or STOP
                    to opt out. Consent is not a condition of purchase. See our{' '}
                    <a
                      href="https://roselabs.ai/privacy"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-navi-black"
                    >
                      Privacy Policy
                    </a>{' '}
                    and{' '}
                    <a
                      href="https://roselabs.ai/terms"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-navi-black"
                    >
                      Terms of Service
                    </a>
                    .
                  </p>
                </div>
              </label>

              <button
                type="submit"
                disabled={loading || otp.length !== 6 || !smsAuthorized}
                className="w-full px-3 py-2 bg-navi-black text-white text-sm rounded-lg hover:bg-navi-black/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Verifying...' : 'Verify'}
              </button>

              <button
                type="button"
                onClick={handleBack}
                className="w-full text-xs text-gray-500 hover:text-navi-black transition-colors"
                disabled={loading}
              >
                ← Change phone number
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default PhoneAuthModal;
