/**
 * [WAITING] FIFO position/deadline + "Queued behind agent <id>"; the device's live screen
 *   comes from the read-only device view (PhoneQueuedDevice, /iphone/device/frame), never
 *   from this lease; no input -> [ACTIVE_AGENT] private view
 * [ACTIVE_AGENT] --confirmed takeover/bounds--> [ACTIVE_USER] tap/drag/text/navigation
 * [ACTIVE_USER] --handback--> [ACTIVE_AGENT]; pending/unknown disables all new input.
 * [HIDDEN|RELEASED] -> revoke frame and restore the still-mounted browser beneath.
 * All visible states share a replay-blocked subtree (including image pixels);
 * separate autocapture text masking does not replace replay exclusion.
 * Optional setup phases use the same safe label as the fullscreen header.
 * Portrait screen fits the remaining pane; controls/progress stay outside its pixels.
 */
import { useEffect, useRef, type PointerEvent } from 'react';
import { matchesPhoneAttention } from './phoneAttentionState';
import type { PhoneAttentionModel } from './usePhoneAttention';
import { PhoneOverlayControls } from './PhoneOverlayControls';
import type { PhoneOverlayModel } from './usePhoneOverlay';
import { phoneStatus, phoneVerificationPending } from './phoneStatus';
import { phonePoint } from './phoneOverlayState';
import { PhoneQueuedDevice } from './PhoneQueuedDevice';

export function PhoneOverlay({
  phone,
  readOnly,
  attention,
}: {
  phone: PhoneOverlayModel;
  readOnly: boolean;
  attention?: PhoneAttentionModel;
}) {
  const image = useRef<HTMLImageElement>(null);
  const region = useRef<HTMLElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const aspect = useRef<number | null>(null);
  const lease = phone.snapshot?.lease;
  useEffect(() => {
    if (!phone.visible) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    region.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [phone.visible]);
  useEffect(() => {
    pointer.current = null;
    aspect.current = null;
  }, [lease?.id]);
  if (phone.queueTimedOut)
    return (
      <div
        role="status"
        aria-label="Phone queue timed out"
        className="absolute inset-x-4 top-4 z-20 rounded-lg bg-navi-black p-3 text-sm text-white"
      >
        Phone queue timed out after five minutes. The agent decides what to do next.
      </div>
    );
  if (!phone.visible || !lease)
    return phone.error ? (
      <div
        role="status"
        aria-label="Phone connection unavailable"
        className="absolute inset-x-4 top-4 z-20 rounded-lg bg-navi-black p-3 text-sm text-white"
      >
        Phone connection unavailable.{' '}
        <button
          type="button"
          onClick={phone.refreshView}
          className="min-h-11 rounded border border-white/20 px-3"
        >
          Refresh phone view
        </button>
      </div>
    ) : null;
  const user = lease.controlOwner === 'user';
  const active = lease.status === 'ACTIVE';
  const enabled =
    !readOnly &&
    !attention?.completing &&
    (!lease.attentionRequestId || matchesPhoneAttention(attention?.request, lease)) &&
    active &&
    user &&
    !!phone.bounds &&
    !phone.busy &&
    !phone.uncertain &&
    !!phone.frame;
  const point = (x: number, y: number) =>
    image.current && phone.bounds ? phonePoint(image.current, phone.bounds, x, y) : null;
  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!enabled || !pointer.current) return;
    const start = pointer.current;
    pointer.current = null;
    const end = point(event.clientX, event.clientY);
    if (end && Math.hypot(start.x - end.x, start.y - end.y) > 8) {
      dragged.current = true;
      void phone.input('input.drag', {
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        duration: 0.35,
        steps: 14,
      });
    }
  };

  return (
    <section
      ref={region}
      data-amp-block=""
      data-amp-mask=""
      role="region"
      aria-label="Cloud iPhone"
      tabIndex={-1}
      className="absolute inset-0 z-20 flex min-h-0 flex-col bg-navi-black text-white outline-none"
    >
      {!active ? (
        <PhoneQueuedDevice lease={lease} />
      ) : (
        <>
          <div
            className="hidden flex-none border-b border-white/10 px-4 py-2 md:block"
            aria-live="polite"
          >
            <div className="text-sm font-medium">Cloud iPhone</div>
            <p className="text-xs text-white/70">
              {phoneStatus(phone, readOnly)?.label ?? 'Agent in progress'}
            </p>
          </div>
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
            {phone.frame ? (
              <button
                type="button"
                aria-label="Tap cloud iPhone screen"
                aria-describedby="phone-screen-help"
                disabled={!enabled}
                className="flex h-full min-h-0 max-w-full touch-none items-center justify-center disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"
                onPointerDown={(event) => {
                  if (enabled) {
                    pointer.current = point(event.clientX, event.clientY);
                    dragged.current = false;
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                  }
                }}
                onPointerUp={endDrag}
                onPointerCancel={() => {
                  pointer.current = null;
                }}
                onClick={(event) => {
                  if (dragged.current) {
                    dragged.current = false;
                    return;
                  }
                  const p =
                    event.detail === 0 && event.clientX === 0 && event.clientY === 0 && phone.bounds
                      ? {
                          x: phone.bounds.x + phone.bounds.w / 2,
                          y: phone.bounds.y + phone.bounds.h / 2,
                        }
                      : point(event.clientX, event.clientY);
                  if (enabled && p) void phone.input('input.tap', p);
                }}
              >
                <img
                  ref={image}
                  alt="Cloud iPhone screen"
                  src={phone.frame}
                  draggable={false}
                  className="block h-full min-h-0 max-w-full object-contain"
                  onLoad={(event) => {
                    const img = event.currentTarget;
                    if (!img.naturalHeight) return;
                    const next = img.naturalWidth / img.naturalHeight;
                    if (aspect.current !== null && Math.abs(aspect.current - next) > 0.01)
                      phone.invalidateBounds();
                    aspect.current = next;
                  }}
                />
              </button>
            ) : (
              <p role="status" className="px-6 text-center text-sm text-white/70">
                {phoneVerificationPending(phone.snapshot?.pendingOperation)
                  ? 'Verifying phone setup'
                  : 'Connecting to the phone…'}
              </p>
            )}
          </div>
        </>
      )}
      <span id="phone-screen-help" className="sr-only">
        Tap or drag the screen with a pointer. Press Enter to tap its center. Home, scroll and text
        controls are below.
      </span>
      <PhoneOverlayControls
        phone={phone}
        readOnly={readOnly}
        enabled={enabled}
        attention={attention}
      />
    </section>
  );
}
