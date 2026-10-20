/**
 * STATE MACHINE: PhoneApp (UI ledger rows 58/66; live link = usePhoneSession)
 *
 *   Rose Desktop flag off, or openApp !== 'phone' --> not rendered, no requests
 *   openApp === 'phone' --> [SHOWN] just the iPhone + its button, floating 24px
 *                           from the window's right edge, vertically centered;
 *                           no header, background or card
 *
 *   [SHOWN] screen, by session state:
 *     loading                    --> idle gradient
 *     no phone | phone offline   --> "Connect your iPhone via iPhone Mirroring on your Mac"
 *                                    (button disabled)
 *     online                     --> live frame (blob URL) sized to frame width/height
 *   [SHOWN] holder:
 *     null   --> Take control (POST take-control) --> [USER]
 *     agent  --> blurred overlay "Another agent is using this" + agent title
 *                + "View agent →" (selects holder.agentId); Take control --> [USER]
 *     [USER] --> "You're in control" + "Release back to <resumeAgent title>"
 *                (POST release --> holder returns to that agent); lease
 *                re-posted every 20s while held
 *   any action 409 (PHONE_IN_USE_BY_USER / _BY_AGENT / PHONE_LEASE_LOST /
 *   PHONE_OFFLINE) --> clear inline text under the button
 *   [SHOWN] --close / unmount--> polling, timers stopped; blob URL revoked
 */

import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import {
  isAgentHolder,
  isUserHolder,
  type PhoneAgentHolder,
  type PhoneState,
} from '@/lib/api/phones';

import { PHONE_EDGE_GAP } from './roseAppsLayout';
import { useRoseApps } from './roseAppsState';
import {
  PHONE_CONNECT_MESSAGE,
  usePhoneSession,
  type PhoneScreenFrame,
  type PhoneSession,
} from './usePhoneSession';

const IDLE_SCREEN =
  'radial-gradient(120% 80% at 20% 10%, #ffd6e2 0%, #f7a8bf 35%, #8e7ad8 75%, #3d3b8e 100%)';

const BUTTON = 'w-[300px] rounded-xl py-[15px] text-base font-semibold disabled:opacity-50';
const TAKE_BUTTON = `${BUTTON} bg-[#0a84ff] text-white enabled:hover:bg-[#0077ed]`;
const RELEASE_BUTTON = `${BUTTON} bg-[#e5e5ea] text-[#1c1c1e] enabled:hover:bg-[#d8d8de] dark:bg-[#3a3a3c] dark:text-white dark:enabled:hover:bg-[#48484a]`;

function connectMessage(session: PhoneSession): string | null {
  if (session.status === 'none') return PHONE_CONNECT_MESSAGE;
  if (session.status === 'error') return "Couldn't load your iPhone. Try reopening Phone.";
  if (session.status === 'ready' && session.phone?.online === false) return PHONE_CONNECT_MESSAGE;
  return null;
}

function frameSize(frame: PhoneScreenFrame, phone: PhoneState | null) {
  return {
    width: frame.width > 0 ? frame.width : (phone?.frame?.width ?? 0),
    height: frame.height > 0 ? frame.height : (phone?.frame?.height ?? 0),
  };
}

function ScreenFrame({ frame, phone }: { frame: PhoneScreenFrame; phone: PhoneState | null }) {
  const { width, height } = frameSize(frame, phone);
  const sized = width > 0 && height > 0;
  return (
    <img
      data-testid="phone-frame"
      src={frame.url}
      alt={phone === null ? 'iPhone screen' : `${phone.name} screen`}
      width={sized ? width : undefined}
      height={sized ? height : undefined}
      className="h-auto max-h-full w-auto max-w-full select-none object-contain"
      style={sized ? { aspectRatio: `${width} / ${height}` } : undefined}
      draggable={false}
    />
  );
}

function AgentOverlay({
  holder,
  onViewAgent,
}: {
  holder: PhoneAgentHolder;
  onViewAgent: (agentId: string) => void;
}) {
  return (
    <div
      data-testid="phone-agent-overlay"
      className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/35 px-6 text-center text-white backdrop-blur-md"
    >
      <p className="text-[15px] font-semibold">Another agent is using this</p>
      <p className="text-[13px] text-white/80">{holder.agentTitle ?? 'An agent'}</p>
      <button
        type="button"
        onClick={() => onViewAgent(holder.agentId)}
        className="mt-1 text-[13px] font-semibold text-white underline-offset-2 hover:underline"
      >
        View agent →
      </button>
    </div>
  );
}

function PhoneScreen({
  session,
  onViewAgent,
}: {
  session: PhoneSession;
  onViewAgent: (agentId: string) => void;
}) {
  const { phone, frame } = session;
  const message = connectMessage(session);
  const live = message === null && frame !== null;
  return (
    <div
      data-testid="phone-screen"
      className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[36px]"
      style={{ background: live ? '#000' : IDLE_SCREEN }}
    >
      {live && <ScreenFrame frame={frame} phone={phone} />}
      {message !== null && (
        <p className="px-8 text-center text-[15px] font-semibold leading-snug text-white">
          {message}
        </p>
      )}
      {message === null && phone !== null && isAgentHolder(phone.holder) && (
        <AgentOverlay holder={phone.holder} onViewAgent={onViewAgent} />
      )}
      <div className="absolute left-1/2 top-2.5 h-7 w-24 -translate-x-1/2 rounded-2xl bg-black" />
    </div>
  );
}

function releaseLabel(phone: PhoneState): string {
  if (phone.resumeAgent === null) return 'Release control';
  return `Release back to ${phone.resumeAgent.agentTitle ?? 'the agent'}`;
}

function PhoneControls({ session }: { session: PhoneSession }) {
  const { phone, busy } = session;
  const ready = session.status === 'ready' && phone !== null && phone.online;
  const userHolds = ready && isUserHolder(phone.holder);
  return (
    <>
      {userHolds && (
        <p className="mt-3 w-[300px] text-center text-[13px] font-semibold text-[#1c1c1e] dark:text-white">
          You&apos;re in control
        </p>
      )}
      {userHolds ? (
        <button
          type="button"
          onClick={session.release}
          disabled={busy}
          className={`mt-2 ${RELEASE_BUTTON}`}
        >
          {releaseLabel(phone)}
        </button>
      ) : (
        <button
          type="button"
          onClick={session.takeControl}
          disabled={!ready || busy}
          className={`mt-3.5 ${TAKE_BUTTON}`}
        >
          Take control
        </button>
      )}
      {session.actionError !== null && (
        <p
          role="alert"
          className="mt-2 w-[300px] text-center text-[13px] text-[#d70015] dark:text-[#ff6961]"
        >
          {session.actionError}
        </p>
      )}
    </>
  );
}

export function PhoneApp() {
  const apps = useRoseApps();
  const roseDesktop = useRoseDesktop();
  const open = roseDesktop && apps?.openApp === 'phone';
  const session = usePhoneSession(open);
  if (apps === null || !open) return null;
  return (
    <div
      data-testid="rose-phone"
      aria-label="Phone"
      role="dialog"
      className="fixed z-[66] hidden flex-col items-center md:flex"
      style={{ right: PHONE_EDGE_GAP, top: '50%', transform: 'translateY(-50%)' }}
    >
      <div
        data-testid="rose-phone-device"
        className="relative h-[630px] w-[300px] rounded-[46px] bg-[#1c1c1e] p-[11px]"
        style={{ boxShadow: '0 0 0 2px #2b2b2b, 0 30px 70px rgba(0,0,0,.35)' }}
      >
        <PhoneScreen session={session} onViewAgent={apps.openAgent} />
      </div>
      <PhoneControls session={session} />
    </div>
  );
}
