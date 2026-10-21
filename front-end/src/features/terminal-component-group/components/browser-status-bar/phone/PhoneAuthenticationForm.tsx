/**
 * [EXACT PENDING USER TARGET] -> ephemeral masked field -> dispatch once and clear.
 * [BUSY|UNKNOWN|COMPLETING] -> no input or completion; [HIDE|REBIND] -> discard field.
 * Concise purpose/receipt share one row; meaningful errors and uncertainty can wrap.
 * Completion resumes agent verification and never asserts setup readiness.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PhoneAttentionModel } from './usePhoneAttention';
import type { PhoneOverlayModel } from './usePhoneOverlay';
export function PhoneAuthenticationForm({
  phone,
  attention,
  enabled,
}: {
  phone: PhoneOverlayModel;
  attention: PhoneAttentionModel;
  enabled: boolean;
}) {
  const [secret, setSecret] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useLayoutEffect(
    () => () => {
      if (field.current) field.current.value = '';
    },
    [],
  );
  const dispatched = useRef(false);
  const request = attention.request;
  const manual = request.criticalReason === 'manual_verification';
  const code = request.criticalReason !== 'password';
  const label =
    request.criticalReason === 'password'
      ? 'Private phone password'
      : request.criticalReason === 'device_passcode'
        ? 'Private phone passcode'
        : 'Private phone verification code';
  const available = enabled && !attention.completing;
  useEffect(() => {
    setSecret('');
    dispatched.current = false;
  }, [request.id, phone.taskId]);
  useEffect(() => {
    if (!phone.busy && !phone.uncertain) dispatched.current = false;
  }, [phone.busy, phone.uncertain]);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!available || !secret || dispatched.current) return;
    dispatched.current = true;
    const value = secret;
    setSecret('');
    void phone.input('input.text', { s: value });
  };
  return (
    <div className="space-y-0" data-testid="phone-private-authentication">
      <p role="status" aria-live="polite" className="break-words text-xs text-white/80">
        {attention.completing
          ? 'Checking completion; input is paused.'
          : phone.uncertain
            ? 'Checking request; input will not replay.'
            : phone.error ||
              attention.notice ||
              phone.notice ||
              (manual
                ? 'Complete verification on the phone.'
                : `${request.criticalReason === 'device_passcode' ? 'Passcode' : code ? 'Code' : 'Password'}: tap phone field, then type.`)}
      </p>
      <form onSubmit={submit} className="flex gap-2">
        {!manual && (
          <>
            <input
              ref={field}
              type="password"
              aria-label={label}
              placeholder={
                request.criticalReason === 'device_passcode'
                  ? 'Phone passcode'
                  : code
                    ? 'Verification code'
                    : 'Password'
              }
              inputMode={code ? 'numeric' : 'text'}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              disabled={!available}
              className="min-h-11 min-w-0 flex-1 rounded border border-white/20 bg-white/10 px-2 text-sm"
            />
            <button
              type="submit"
              aria-label="Type privately"
              disabled={!available || !secret}
              className="min-h-11 min-w-11 rounded bg-blue-500 px-2 text-sm disabled:opacity-50"
            >
              <span className="sm:hidden" aria-hidden="true">
                ↵
              </span>
              <span className="hidden sm:inline">Type privately</span>
            </button>
          </>
        )}
        <button
          type="button"
          aria-label="Authentication complete"
          disabled={!available}
          onClick={() => {
            setSecret('');
            void attention.complete();
          }}
          className="min-h-11 min-w-11 rounded border border-white/30 px-2 text-sm disabled:opacity-50"
        >
          <span className="sm:hidden" aria-hidden="true">
            Done
          </span>
          <span className="hidden sm:inline">Authentication complete</span>
        </button>
      </form>
    </div>
  );
}
