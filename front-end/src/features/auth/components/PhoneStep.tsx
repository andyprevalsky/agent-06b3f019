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

import { DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { isSubmittablePhone } from '@/lib/phone';

import type { PhoneStepProps } from '../types';

import AuthLogo from './AuthLogo';
import PhoneInput from './PhoneInput';

function PhoneStep({
  phone,
  onPhoneChange,
  loading,
  onSubmit,
  onClose,
  title = 'Start Building.',
}: PhoneStepProps) {
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
        <DialogTitle className="text-2xl font-semibold text-navi-black">{title}</DialogTitle>
        <DialogDescription className="text-xl text-gray-400 mt-1">
          Create free account
        </DialogDescription>
      </div>

      <div className="space-y-4">
        <div>
          <label htmlFor="phone" className="block text-sm text-gray-500 mb-1">
            Phone Number
          </label>
          <PhoneInput id="phone" value={phone} onChange={onPhoneChange} disabled={loading} />
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
          disabled={loading || !isSubmittablePhone(phone)}
          className="w-full px-3 py-2 bg-navi-black text-white text-sm rounded-lg hover:bg-navi-black/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Sending...' : 'Continue'}
        </button>
      </div>
    </form>
  );
}

export default PhoneStep;
