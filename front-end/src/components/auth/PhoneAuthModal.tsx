import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect, RefObject } from "react";
import { sendOTP, verifyOTP } from "@/lib/supabase";
import { useNavigate } from "react-router-dom";
import { Phone } from "lucide-react";

interface PhoneAuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement>;
}

const PhoneAuthModal = ({ open, onOpenChange, triggerRef }: PhoneAuthModalProps) => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [modalPosition, setModalPosition] = useState({ top: 0, left: 0 });

  // Calculate modal position based on button
  useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setModalPosition({
        top: rect.bottom + 8, // 8px below button
        left: rect.right, // Align right edge with button's right edge
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
      toast({
        title: "Success!",
        description: "You're now logged in.",
      });
      onOpenChange(false);
      // Reset state
      setStep('phone');
      setPhone('');
      setOtp('');
      // Navigate to terminal
      navigate('/terminal');
    } catch (error: any) {
      console.error('Verify OTP error:', error);
      toast({
        title: "Invalid code",
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
    }, 200);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose} modal={false}>
      <DialogContent 
        className="p-0 border border-gray-300 shadow-lg [&>button]:hidden overflow-hidden"
        style={{ 
          position: 'fixed',
          top: `${modalPosition.top}px`,
          left: `${modalPosition.left}px`,
          transform: 'translateX(-100%)',
          width: '320px',
          maxWidth: '90vw',
          backgroundColor: 'transparent',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      >
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
              className="w-full px-4 py-3 bg-[#EEEFF2] text-navi-black rounded-lg hover:bg-[#e8e9ec] transition-colors disabled:cursor-not-allowed"
            >
              {loading ? 'Sending...' : 'Send Code'}
            </button>
          </form>
        ) : (
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
              className="w-full px-4 py-3 bg-[#EEEFF2] text-navi-black rounded-lg hover:bg-[#e8e9ec] transition-colors disabled:cursor-not-allowed"
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
        )}
      </DialogContent>
    </Dialog>
  );
};

export default PhoneAuthModal;
