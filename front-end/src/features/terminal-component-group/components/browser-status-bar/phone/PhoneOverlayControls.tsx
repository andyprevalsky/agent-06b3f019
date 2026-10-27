/**
 * [AGENT] Take control -> broker confirmation; [USER] navigation/Type -> stable owned command.
 * [BUSY|UNKNOWN|STALE|READ_ONLY] -> writes disabled; Type panel owns ephemeral text/focus.
 * [NATIVE ATTENTION] -> exact masked form, no generic Type/handback.
 * Handback -> agent; hide/lease change -> discard text. Controls remain outside phone pixels.
 */
import { useEffect, useRef, useState } from 'react';
import { PhoneAttentionNotice } from './PhoneAttentionNotice';
import { PhoneAuthenticationForm } from './PhoneAuthenticationForm';
import { matchesPhoneAttention } from './phoneAttentionState';
import type { PhoneAttentionModel } from './usePhoneAttention';
import type { PhoneOverlayModel } from './usePhoneOverlay';

export function PhoneOverlayControls({
  phone,
  readOnly,
  enabled,
  attention,
}: {
  phone: PhoneOverlayModel;
  readOnly: boolean;
  enabled: boolean;
  attention?: PhoneAttentionModel;
}) {
  const lease = phone.snapshot?.lease;
  const active = lease?.status === 'ACTIVE';
  const pending = !!lease?.attentionRequestId;
  const privateForm = !readOnly && !!attention && matchesPhoneAttention(attention.request, lease);
  const user = lease?.controlOwner === 'user';
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setText('');
    setTyping(false);
  }, [lease?.id, lease?.attentionRequestId]);
  useEffect(() => {
    if (typing) input.current?.focus();
  }, [typing]);
  const scroll = (direction: number) => {
    const b = phone.bounds;
    if (b && enabled)
      void phone.input('input.scroll', {
        x: b.x + b.w / 2,
        y: b.y + b.h / 2,
        dy: (direction * b.h) / 3,
        dx: 0,
        steps: 6,
      });
  };
  return (
    <div
      data-testid="phone-controls"
      className={
        pending
          ? 'flex-none space-y-0 border-t border-white/10 px-3 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]'
          : 'flex-none space-y-2 border-t border-white/10 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]'
      }
    >
      {!privateForm && <PhoneAttentionNotice attention={attention} lease={lease} />}
      {phone.notice && !privateForm && (
        <p role="status" className="text-xs text-amber-200">
          {phone.notice}
        </p>
      )}
      {phone.error && !privateForm && (
        <p role="status" className="text-xs text-amber-200">
          {phone.error}
        </p>
      )}
      {phone.error && !phone.uncertain && (
        <button
          type="button"
          onClick={phone.refreshView}
          className="min-h-11 rounded border border-white/20 px-3 text-sm"
        >
          Refresh phone view
        </button>
      )}
      {phone.uncertain && !privateForm && (
        <p role="status" className="text-xs text-amber-200">
          Checking the previous operation. New input is disabled; it will not be replayed.
        </p>
      )}
      {active && !readOnly && (
        <>
          {!pending && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-white/70">
                {phone.busy
                  ? 'Updating phone…'
                  : user && !phone.bounds
                    ? 'Waiting for fresh screen bounds'
                    : user
                      ? 'You have control'
                      : 'Agent in progress'}
              </span>
              {!pending && (
                <button
                  type="button"
                  aria-label={user ? 'Hand back phone control' : 'Take phone control'}
                  disabled={phone.busy || phone.uncertain}
                  onClick={() => void phone.control(user ? 'agent' : 'user')}
                  className="rounded-full bg-blue-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-400 disabled:opacity-50"
                >
                  {user ? 'Hand back' : 'Take control'}
                </button>
              )}
            </div>
          )}
          {user && (
            <>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!enabled}
                  onClick={() => void phone.input('nav.home', {})}
                  className="min-h-11 rounded border border-white/20 px-3 py-1 text-sm disabled:opacity-50"
                >
                  Home
                </button>
                <button
                  type="button"
                  disabled={!enabled}
                  aria-label="Scroll up"
                  onClick={() => scroll(-1)}
                  className="min-h-11 rounded border border-white/20 px-3 py-1 text-sm disabled:opacity-50"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={!enabled}
                  aria-label="Scroll down"
                  onClick={() => scroll(1)}
                  className="min-h-11 rounded border border-white/20 px-3 py-1 text-sm disabled:opacity-50"
                >
                  ↓
                </button>
                {!pending && (
                  <button
                    type="button"
                    disabled={!enabled}
                    aria-expanded={typing}
                    onClick={() => setTyping((current) => !current)}
                    className="min-h-11 rounded border border-white/20 px-3 text-sm disabled:opacity-50"
                  >
                    Type
                  </button>
                )}
              </div>
              {typing && !pending && (
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (enabled && text) {
                      const value = text;
                      setText('');
                      void phone.input('input.text', { s: value });
                    }
                  }}
                >
                  <input
                    ref={input}
                    aria-label="Text to type on phone"
                    placeholder="Text to type"
                    autoComplete="off"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    disabled={!enabled}
                    className="min-w-0 flex-1 rounded border border-white/20 bg-white/10 px-2 py-1 text-sm disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={!enabled || !text}
                    className="rounded bg-blue-500 px-3 py-1 text-sm disabled:opacity-50"
                  >
                    Send text
                  </button>
                </form>
              )}
            </>
          )}
        </>
      )}
      {privateForm && (
        <PhoneAuthenticationForm
          key={`${attention.request.id}:${phone.taskId}`}
          phone={phone}
          attention={attention}
          enabled={enabled}
        />
      )}
      {readOnly && <p className="text-xs text-white/70">Read-only phone view</p>}
    </div>
  );
}
