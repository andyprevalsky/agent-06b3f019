import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect, RefObject } from "react";
import { sendOTP, verifyOTP } from "@/lib/supabase";
import { useNavigate } from "react-router-dom";
import { Phone } from "lucide-react";
import { checkNeedsInviteCode, useInviteCode } from "@/lib/api";

interface PhoneAuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLDivElement>;
}

const PhoneAuthModal = ({ open, onOpenChange, triggerRef }: PhoneAuthModalProps) => {
  const { toast } = useToast();
  const navigate = useNavigate();
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

  const formatPhoneNumber = (value: string) => {
    // Remove all non-numeric characters except +
    return value.replace(/[^\d+]/g, '');
  };

  const handlePhoneBlur = () => {
    if (!phone) return;
    
    // If phone doesn't start with +, add it
    if (!phone.startsWith('+')) {
      // If it's all digits and looks like a US number (10 digits), add +1
      const digitsOnly = phone.replace(/\D/g, '');
      if (digitsOnly.length === 10) {
        setPhone(`+1${digitsOnly}`);
      } else if (digitsOnly.length > 0) {
        // Otherwise just add +
        setPhone(`+${digitsOnly}`);
      }
    }
  };

  const handleSendOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      await sendOTP(phone);
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
      await verifyOTP(phone, otp);
      
      // Check if user needs to enter an invite code
      const needsInvite = await checkNeedsInviteCode();
      
      if (needsInvite) {
        // Show invite code entry screen
        setStep('invite');
        setLoading(false);
      } else {
        // User already has invite code, proceed to terminal
        toast({
          title: "Success!",
          description: "You're now logged in.",
        });
        onOpenChange(false);
        // Reset state
        setStep('phone');
        setPhone('');
        setOtp('');
        setInviteCode('');
        // Navigate to terminal - but we're already on it in this spec
        // The modal will just close and they can continue
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

  const handleSubmitInviteCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const inviteCodeNum = parseInt(inviteCode, 10);
      if (isNaN(inviteCodeNum)) {
        throw new Error('Invalid invite code format');
      }

      await useInviteCode(inviteCodeNum);
      
      toast({
        title: "Success!",
        description: "Invite code accepted. You're all set!",
      });
      
      onOpenChange(false);
      // Reset state
      setStep('phone');
      setPhone('');
      setOtp('');
      setInviteCode('');
      
      // Reload the page to ensure user data is fresh
      window.location.reload();
    } catch (error: any) {
      console.error('Invite code error:', error);
      toast({
        title: "Invalid invite code",
        description: error.message || "Please check the code and try again.",
        variant: "destructive",
      });
    } finally {
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
        className="p-0 border border-gray-300 shadow-lg [&>button]:hidden overflow-visible z-[100] w-[320px] max-w-[90vw] relative rounded-lg"
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
          <form onSubmit={handleSendOTP} className="p-5 space-y-4">
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                id="phone"
                type="tel"
                placeholder="+1234567890"
                value={phone}
                onChange={(e) => setPhone(formatPhoneNumber(e.target.value))}
                onBlur={handlePhoneBlur}
                required
                className="w-full pl-11 pr-4 py-3 bg-[#EEEFF2] border border-gray-300 rounded-lg text-navi-black placeholder-navi-black/50 focus:outline-none focus:border-gray-400"
                disabled={loading}
              />
            </div>

            <button
              type="submit"
              disabled={loading || !phone}
              className="w-full px-4 py-3 bg-[#EEEFF2] text-navi-black rounded-lg hover:bg-[#e8e9ec] transition-colors disabled:cursor-not-allowed border border-[#93c5a8]"
            >
              {loading ? 'Sending...' : 'Send Code'}
            </button>
          </form>
        ) : step === 'otp' ? (
          <form onSubmit={handleVerifyOTP} className="p-5 space-y-4">
            <div className="text-center mb-2">
              <p className="text-sm text-navi-black/70">
                Code sent to {phone}
              </p>
            </div>

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
              className="w-full px-4 py-3 bg-[#EEEFF2] border border-gray-300 rounded-lg text-navi-black text-center text-2xl font-mono tracking-widest placeholder-navi-black/50 focus:outline-none focus:border-gray-400"
              disabled={loading}
              autoFocus
            />

            <button
              type="submit"
              disabled={loading || otp.length !== 6}
              className="w-full px-4 py-3 bg-[#EEEFF2] text-navi-black rounded-lg hover:bg-[#e8e9ec] transition-colors disabled:cursor-not-allowed border border-[#93c5a8]"
            >
              {loading ? 'Verifying...' : 'Verify'}
            </button>

            <button
              type="button"
              onClick={handleBack}
              className="w-full text-xs text-navi-black/70 hover:text-navi-black transition-colors mt-4"
              disabled={loading}
            >
              ← Change phone number
            </button>
          </form>
        ) : (
          <form onSubmit={handleSubmitInviteCode} className="p-5 space-y-4">
            <div className="text-center mb-2">
              <p className="text-sm font-medium text-navi-black">
                Enter Invite Code
              </p>
              <p className="text-xs text-navi-black/70 mt-1">
                Rose is invite-only. Please enter your 6-digit code.
              </p>
            </div>

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
              className="w-full px-4 py-3 bg-[#EEEFF2] border border-gray-300 rounded-lg text-navi-black text-center text-2xl font-mono tracking-widest placeholder-navi-black/50 focus:outline-none focus:border-gray-400"
              disabled={loading}
              autoFocus
            />

            <button
              type="submit"
              disabled={loading || inviteCode.length !== 6}
              className="w-full px-4 py-3 bg-[#EEEFF2] text-navi-black rounded-lg hover:bg-[#e8e9ec] transition-colors disabled:cursor-not-allowed border border-[#93c5a8]"
            >
              {loading ? 'Verifying...' : 'Submit'}
            </button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default PhoneAuthModal;
