import { useState } from "react";
import { sendOTP, verifyOTP } from "../lib/supabase";
import { Phone } from "lucide-react";

interface AuthModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

export function AuthModal({ onClose, onSuccess }: AuthModalProps) {
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);

    try {
      await sendOTP(phone);
      setStep('otp');
    } catch (error: any) {
      console.error('Send OTP error:', error);
      setError(error.message || "Failed to send code. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await verifyOTP(phone, otp);
      onSuccess();
      // Reset state
      setStep('phone');
      setPhone('');
      setOtp('');
    } catch (error: any) {
      console.error('Verify OTP error:', error);
      setError(error.message || "Please check the code and try again.");
      setLoading(false);
    }
  };

  const handleBack = () => {
    setStep('phone');
    setOtp('');
    setError(null);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-navi-black rounded-lg shadow-xl w-[400px] max-w-[90vw] p-6 space-y-4">
        <h2 className="text-2xl font-bold text-center">Sign In</h2>
        
        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive rounded-lg text-destructive text-sm">
            {error}
          </div>
        )}

        {step === 'phone' ? (
          <form onSubmit={handleSendOTP} className="space-y-4">
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
              <input
                id="phone"
                type="tel"
                placeholder="+1234567890"
                value={phone}
                onChange={(e) => setPhone(formatPhoneNumber(e.target.value))}
                onBlur={handlePhoneBlur}
                required
                className="w-full pl-11 pr-4 py-3 bg-muted border border-border rounded-lg focus:outline-none focus:border-primary"
                disabled={loading}
                autoFocus
              />
            </div>

            <button
              type="submit"
              disabled={loading || !phone}
              className="w-full px-4 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Sending...' : 'Send Code'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOTP} className="space-y-4">
            <div className="text-center mb-2">
              <p className="text-sm text-muted-foreground">
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
              className="w-full px-4 py-3 bg-muted border border-border rounded-lg text-center text-2xl font-mono tracking-widest focus:outline-none focus:border-primary"
              disabled={loading}
              autoFocus
            />

            <button
              type="submit"
              disabled={loading || otp.length !== 6}
              className="w-full px-4 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Verifying...' : 'Verify'}
            </button>

            <button
              type="button"
              onClick={handleBack}
              className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
              disabled={loading}
            >
              ← Change phone number
            </button>
          </form>
        )}
      </div>
    </div>
  );
}


