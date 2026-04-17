/**
 * STATE MACHINE: PhoneStep
 *
 * [IDLE] <-- loading: false
 *     |
 *     v (submit form)
 * [SUBMITTING] <-- loading: true
 *     |
 *     +--> (success) --> parent transitions to OTP step
 *     +--> (error) --> [IDLE]
 */

import { X } from 'lucide-react';

import type { PhoneStepProps } from '../types';

import AuthLogo from './AuthLogo';

function appendUSFormatted(prefix: string, digits: string): string {
  let out = prefix + '(' + digits.slice(0, 3);
  if (digits.length >= 3) {
    out += ')';
    if (digits.length > 3) {
      out += '-' + digits.slice(3, 6);
      if (digits.length > 6) out += '-' + digits.slice(6, 10);
    }
  }
  return out;
}

/** Formats a raw digit string into a display phone number: +1 (XXX)-XXX-XXXX. */
function formatPhoneNumber(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return '';
  if (digits[0] === '1') {
    const rest = digits.slice(1);
    return rest.length === 0 ? '+1' : appendUSFormatted('+1 ', rest);
  }
  if (digits.length <= 10) return appendUSFormatted('+1 ', digits);
  return '+' + digits;
}

function PhoneStep({ phone, onPhoneChange, loading, onSubmit, onClose }: PhoneStepProps) {
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
        <h2 className="text-2xl font-semibold text-navi-black">Start Building.</h2>
        <p className="text-xl text-gray-400 mt-1">Create free account</p>
      </div>

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
            onChange={(e) => onPhoneChange(formatPhoneNumber(e.target.value))}
            required
            className="w-full px-3 py-2 bg-[#EEEFF2] border border-gray-300 rounded-lg text-navi-black text-sm placeholder-navi-black/30 focus:outline-none focus:border-gray-400"
            disabled={loading}
          />
          <p className="text-xs text-gray-500 mt-2">
            By submitting, you authorize Rose Labs to send an automated text message containing a
            one-time password (OTP) to the number you provided. Message/data rates may apply. See{' '}
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
  );
}

export default PhoneStep;
