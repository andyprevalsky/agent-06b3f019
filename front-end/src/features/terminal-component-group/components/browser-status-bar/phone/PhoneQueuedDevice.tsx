/**
 * STATE MACHINE: PhoneQueuedDevice (PhoneOverlay while this agent's lease is WAITING)
 *
 *   [WAITING] header: "Queued behind agent <id> (position N)" when another agent holds
 *             the phone, else "Queue position N · Waiting for the phone"; five-minute
 *             timeout copy + deadline
 *             body: the device's live screen (PhoneDeviceLive via GET /iphone/device/frame),
 *             read-only. Viewing never goes through the lease/queue semaphore.
 *   lease turns ACTIVE --> PhoneOverlay's control path takes over (this unmounts).
 */
import type { PhoneLease } from '@/lib/api/iphone';
import { PhoneDeviceLive } from './PhoneDeviceLive';
import { shortAgentId, usePhoneDevice } from './usePhoneDevice';

export function PhoneQueuedDevice({ lease }: { lease: PhoneLease }) {
  const model = usePhoneDevice();
  const holder = lease.holder ?? model.device?.holder ?? null;
  const position =
    lease.queuePosition ??
    model.device?.waiting.find((waiter) => waiter.leaseId === lease.id)?.position ??
    null;
  const behind = holder !== null && holder.agentId !== lease.agentId ? holder : null;
  return (
    <>
      <div className="flex-none border-b border-white/10 px-4 py-2" aria-live="polite">
        <div className="text-sm font-medium">Cloud iPhone</div>
        <p className="text-sm" data-testid="phone-queue-status">
          {behind !== null ? (
            <>
              Queued behind{' '}
              <a
                className="underline-offset-2 hover:underline"
                href={`/?agent-id=${encodeURIComponent(behind.agentId)}`}
              >
                agent {shortAgentId(behind.agentId)}
              </a>{' '}
              (position {position ?? 'pending'})
            </>
          ) : (
            `Queue position ${position ?? 'pending'} · Waiting for the phone`
          )}
        </p>
        <p className="text-xs text-white/70">
          The queue times out after five minutes. The agent decides what to do next.
        </p>
        {lease.queueDeadlineAt && (
          <time
            data-testid="phone-queue-deadline"
            dateTime={lease.queueDeadlineAt}
            className="text-xs text-white/70"
          >
            Deadline: {new Date(lease.queueDeadlineAt).toLocaleTimeString()}
          </time>
        )}
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
        <PhoneDeviceLive model={model} />
      </div>
    </>
  );
}
