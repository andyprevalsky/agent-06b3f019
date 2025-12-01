import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect, RefObject } from "react";
import { sendOTP, verifyOTP } from "@/lib/supabase";
import { X } from "lucide-react";
import { checkNeedsInviteCode, useInviteCode } from "@/lib/api";
import * as amplitude from '@amplitude/analytics-browser';

interface PhoneAuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLDivElement>;
  onAuthComplete?: () => void; // Called when user is fully signed in
}

const PhoneAuthModal = ({ open, onOpenChange, triggerRef, onAuthComplete }: PhoneAuthModalProps) => {
  const { toast } = useToast();
  const [step, setStep] = useState<'phone' | 'otp' | 'invite'>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [modalPosition, setModalPosition] = useState({ top: 0, left: 0 });

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
      await sendOTP(strippedPhone);
      
      // Track phone entered event
      amplitude.track('phone_entered');
      
      setStep('otp');
      toast({
        title: "Code sent!",
        description: "Check your phone for the 6-digit code.",
      });
    } catch (error: any) {
      console.error('Send OTP error:', error);
      toast({
        title: "Error",
        description: error.message || "Failed to send code. Please try again.",
        variant: "destructive",
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
      
      // Verify OTP with Supabase
      await verifyOTP(strippedPhone, otp);
      
      // Track in Amplitude
      amplitude.track('otp_code_submitted');
      amplitude.setUserId(strippedPhone);
      
      // Small delay to let Supabase finish internal state updates
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Check if user needs to enter an invite code
      const needsInvite = await checkNeedsInviteCode();
      
      if (needsInvite) {
        // Show invite code entry screen
        setStep('invite');
        setLoading(false);
      } else {
        // User already has invite code - complete the flow
        completeAuth();
      }
    } catch (error: any) {
      console.error('Verify OTP error:', error);
      toast({
        title: "Invalid code",
        description: error.message || "Please check the code and try again.",
        variant: "destructive",
      });
      setLoading(false);
    }
  };

  // Called when auth flow is fully complete (user has session + invite code)
  const completeAuth = () => {
    toast({
      title: "Success!",
      description: "You're now logged in.",
    });
    setLoading(false);
    onOpenChange(false);
    
    // Reset state
    setStep('phone');
    setPhone('');
    setOtp('');
    setInviteCode('');
    
    // Notify parent that auth is complete
    onAuthComplete?.();
  };

  const handleSubmitInviteCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const inviteCodeNum = parseInt(inviteCode, 10);
      if (isNaN(inviteCodeNum)) {
        throw new Error('Invalid invite code format');
      }

      await useInviteCode(inviteCodeNum);
      
      // Track invite code submitted event
      amplitude.track('invite_code_submitted');
      
      // Complete the auth flow
      completeAuth();
    } catch (error: any) {
      console.error('Invite code error:', error);
      toast({
        title: "Invalid invite code",
        description: error.message || "Please check the code and try again.",
        variant: "destructive",
      });
      setLoading(false);
    }
  };

  const handleBack = () => {
    setStep('phone');
    setOtp('');
  };

  const handleClose = () => {
    onOpenChange(false);
    // Reset state after animation
    setTimeout(() => {
      setStep('phone');
      setPhone('');
      setOtp('');
      setInviteCode('');
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
        {step === 'phone' ? (
          <form onSubmit={handleSendOTP} className="p-6">
            {/* Header: Logo left, X right */}
            <div className="flex items-start justify-between mb-6">
              <div 
                className="w-10 h-10 rounded-lg" 
                style={{ 
                  background: 'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)' 
                }}
              />
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
              <h2 className="text-2xl font-semibold text-navi-black">
                Start Building.
              </h2>
              <p className="text-xl text-gray-400 mt-1">
                Create free account
              </p>
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
        ) : step === 'otp' ? (
          <form onSubmit={handleVerifyOTP} className="p-6">
            {/* Header: Logo left, X right */}
            <div className="flex items-start justify-between mb-6">
              <div 
                className="w-10 h-10 rounded-lg" 
                style={{ 
                  background: 'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)' 
                }}
              />
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
              <h2 className="text-2xl font-semibold text-navi-black">
                Verify Code
              </h2>
              <p className="text-xl text-gray-400 mt-1">
                Code sent to {phone}
              </p>
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

              <button
                type="submit"
                disabled={loading || otp.length !== 6}
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
        ) : (
          <form onSubmit={handleSubmitInviteCode} className="p-6">
            {/* Header: Logo left, X right */}
            <div className="flex items-start justify-between mb-6">
              <div 
                className="w-10 h-10 rounded-lg" 
                style={{ 
                  background: 'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)' 
                }}
              />
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
              <h2 className="text-2xl font-semibold text-navi-black">
                Enter Invite Code
              </h2>
              <p className="text-xl text-gray-400 mt-1">
                Rose is invite-only
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="inviteCode" className="block text-sm text-gray-500 mb-1">
                  6-digit Invite Code
                </label>
                <input
                  id="inviteCode"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  placeholder="000000"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value.replace(/\D/g, ''))}
                  required
                  className="w-full px-3 py-2 bg-[#EEEFF2] border border-gray-300 rounded-lg text-navi-black text-center text-sm font-mono tracking-widest placeholder-navi-black/30 focus:outline-none focus:border-gray-400"
                  disabled={loading}
                  autoFocus
                />
              </div>

              <button
                type="submit"
                disabled={loading || inviteCode.length !== 6}
                className="w-full px-3 py-2 bg-navi-black text-white text-sm rounded-lg hover:bg-navi-black/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Verifying...' : 'Submit'}
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default PhoneAuthModal;
