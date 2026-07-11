/**
 * STATE MACHINE: OtpStep
 *
 * [IDLE] <-- loading: false
 *     |
 *     v (submit form)
 * [VERIFYING] <-- loading: true
 *     |
 *     +--> (success) --> parent completes auth
 *     +--> (error) --> [IDLE]
 */

import { X } from 'lucide-react';

import { formatE164Display } from '@/lib/phone';

import type { OtpStepProps } from '../types';

import AuthLogo from './AuthLogo';

function OtpStep({
  phone,
  otp,
  onOtpChange,
  loading,
  smsAuthorized,
  onSmsAuthorizedChange,
  onSubmit,
  onBack,
  onClose,
}: OtpStepProps) {
  const handleSubmit = (e: React.FormEvent) => {
    void onSubmit(e);
  };

  return (
    <form onSubmit={handleSubmit} className="p-6">
      <div className="flex items-start justify-between mb-6">
        <AuthLogo />
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 transition-colors p-1"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-navi-black">Verify Code</h2>
        <p className="text-xl text-gray-400 mt-1">Code sent to {formatE164Display(phone)}</p>
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
            onChange={(e) => onOtpChange(e.target.value.replace(/\D/g, ''))}
            required
            className="w-full px-3 py-2 bg-[#EEEFF2] border border-gray-300 rounded-lg text-navi-black text-center text-sm font-mono tracking-widest placeholder-navi-black/30 focus:outline-none focus:border-gray-400"
            disabled={loading}
            autoFocus
          />
        </div>

        <SmsAuthCheckbox authorized={smsAuthorized} onChange={onSmsAuthorizedChange} />

        <button
          type="submit"
          disabled={loading || otp.length !== 6 || !smsAuthorized}
          className="w-full px-3 py-2 bg-navi-black text-white text-sm rounded-lg hover:bg-navi-black/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Verifying...' : 'Verify'}
        </button>

        <button
          type="button"
          onClick={onBack}
          className="w-full text-xs text-gray-500 hover:text-navi-black transition-colors"
          disabled={loading}
        >
          &larr; Change phone number
        </button>
      </div>
    </form>
  );
}

function SmsAuthCheckbox({
  authorized,
  onChange,
}: {
  authorized: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 p-3 bg-white/50 border border-gray-300 rounded-lg cursor-pointer">
      <input
        type="checkbox"
        checked={authorized}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 rounded border-gray-300 text-navi-black focus:ring-0 focus:ring-offset-0"
      />
      <div className="flex-1">
        <span className="text-sm font-medium text-navi-black">I authorize SMS communication</span>
        <p className="text-xs text-gray-500 mt-1">
          I authorize Rose Labs to send automated SMS messages to the phone number provided,
          including task updates, reminders, and status notifications. Message frequency varies.
          Message and data rates may apply. Text HELP for help or STOP to opt out. Consent is not a
          condition of purchase. See our{' '}
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
  );
}

export default OtpStep;
