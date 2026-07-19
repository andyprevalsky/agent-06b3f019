/**
 * STATE MACHINE: OnboardingData ("Connect your Data" step)
 *
 *   [LOADING] --integrations fetched--> [RING(activeIndex)]
 *   [RING] --Next / ring icon click--> [RING(next index)] (ring rotates)
 *   [RING] --sub-row + click--> connector flow (hook/modal) --> category lit
 *   [RING, all 6 categories connected] --> [CELEBRATE] (4-turn spin, rose ring,
 *       veil, navi-blue "Get Started")
 *   [RING] --Skip for now--> onComplete()
 *   [CELEBRATE] --Get Started--> onComplete()
 *
 * System context:
 *   Onboarding (step shell: dots + back chevron)
 *     -> OnboardingData (this orchestrator)
 *          -> RingCarousel (3D category ring)
 *          -> SubConnectionCard (active category's connector rows)
 *          -> integration modals (Atlas keychain, Apple Passkeys, WhatsApp QR,
 *             Telegram auth)
 *   Connection logic is the SAME hook suite the integrations page uses
 *   (useIntegrationData/useBrowserSync/usePasswordSync/useComputeSync/
 *   useMessagesSync/useGmailConnect/usePlaidIntegration), so onboarding and
 *   the integrations page cannot drift. WhatsApp/Telegram are mac-app-only
 *   flows and live in the local useOnboardingChat hook.
 */

import { ArrowRight, Loader2 } from 'lucide-react';
import { useCallback, useMemo, useState, type JSX } from 'react';

import PasskeysModal from '@/components/PasskeysModal';
import { useIntegrationHandlers } from '@/features/integration-handlers-context';
import {
  useBrowserSync,
  useComputeSync,
  useGmailConnect,
  useIntegrationData,
  useMessagesSync,
  usePasswordSync,
} from '@/features/integrations/hooks';
import { usePlaidIntegration } from '@/features/integrations/hooks/usePlaidIntegration';

import AtlasPasswordModal from '../../atlas-password-modal';
import TelegramAuthModal from '../../telegram-auth-modal';
import WhatsAppQRModal from '../../whats-app-qr-modal';
import { buildCategories, type CategoryModel } from './data/categoryModels';
import RingCarousel from './data/RingCarousel';
import SubConnectionCard from './data/SubConnectionCard';
import { useCategoryInputs } from './data/useCategoryInputs';
import type { OnboardingChatState } from './data/useOnboardingChat';

interface OnboardingDataProps {
  onComplete: () => void;
}

function nextUnconnected(categories: CategoryModel[], from: number): number | null {
  for (let k = 1; k <= categories.length; k++) {
    const i = (from + k) % categories.length;
    if (!categories[i].connected) return i;
  }
  return null;
}

function ButtonsRow({
  allConnected,
  onSkip,
  onNext,
}: {
  allConnected: boolean;
  onSkip: () => void;
  onNext: () => void;
}): JSX.Element {
  return (
    <div className="mt-4 flex w-full max-w-sm gap-3">
      <button
        type="button"
        onClick={onSkip}
        className="flex-1 rounded-xl py-3 px-4 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        Skip for now
      </button>
      <button
        type="button"
        onClick={onNext}
        className={`flex-1 rounded-xl py-3 px-4 text-sm font-medium transition-all duration-300 flex items-center justify-center gap-2 ${
          allConnected ? 'onb-proceed' : 'bg-foreground text-background hover:bg-foreground/90'
        }`}
      >
        {allConnected ? 'Get Started' : 'Next'}
        <ArrowRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

interface OnboardingDataState {
  loading: boolean;
  categories: CategoryModel[];
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  allConnected: boolean;
  handleNext: () => void;
  browser: ReturnType<typeof useBrowserSync>;
  passwords: ReturnType<typeof usePasswordSync>;
  chat: OnboardingChatState;
}

function useOnboardingDataState(onComplete: () => void): OnboardingDataState {
  const handlers = useIntegrationHandlers();
  const data = useIntegrationData();
  const browser = useBrowserSync(handlers, data.fetchIntegrations);
  const passwords = usePasswordSync(handlers, data.fetchIntegrations);
  const compute = useComputeSync(handlers, data.fetchIntegrations);
  const messages = useMessagesSync(handlers, data.fetchIntegrations);
  const gmail = useGmailConnect(data.fetchIntegrations);
  const plaid = usePlaidIntegration();
  const [activeIndex, setActiveIndex] = useState(0);

  const { inputs, chat } = useCategoryInputs({
    data,
    browser,
    passwords,
    compute,
    messages,
    gmail,
    plaid,
  });
  const categories = useMemo(() => buildCategories(inputs), [inputs]);
  const allConnected = categories.every((c) => c.connected);

  const handleNext = useCallback((): void => {
    if (allConnected) {
      onComplete();
      return;
    }
    if (activeIndex === categories.length - 1) {
      const target = nextUnconnected(categories, activeIndex);
      if (target !== null) setActiveIndex(target);
      return;
    }
    setActiveIndex(activeIndex + 1);
  }, [allConnected, activeIndex, categories, onComplete]);

  return {
    loading: data.loadingIntegrations,
    categories,
    activeIndex,
    setActiveIndex,
    allConnected,
    handleNext,
    browser,
    passwords,
    chat,
  };
}

function OnboardingDataModals({
  browser,
  passwords,
  chat,
}: Pick<OnboardingDataState, 'browser' | 'passwords' | 'chat'>): JSX.Element {
  return (
    <>
      <AtlasPasswordModal
        isOpen={browser.atlasModalOpen}
        onClose={browser.closeAtlasModal}
        onSync={browser.handleAtlasSync}
        syncType="browser data"
      />
      <PasskeysModal
        isOpen={passwords.passkeysModalOpen}
        onClose={() => passwords.setPasskeysModalOpen(false)}
        onSync={passwords.handlePasskeysConnect}
      />
      <AtlasPasswordModal
        isOpen={passwords.atlasPasswordsModalOpen}
        onClose={() => passwords.setAtlasPasswordsModalOpen(false)}
        onSync={passwords.handleAtlasPasswordsSync}
        syncType="passwords"
      />
      <WhatsAppQRModal
        isOpen={chat.whatsAppQRModalOpen}
        onClose={chat.closeWhatsAppQRModal}
        qrCode={chat.whatsAppQRCode}
        isConnecting={chat.chatSyncLoading === 'whatsapp'}
      />
      <TelegramAuthModal
        isOpen={chat.telegramAuthModalOpen}
        onClose={chat.closeTelegramAuthModal}
        onSuccess={chat.onTelegramAuthSuccess}
      />
    </>
  );
}

export default function OnboardingData({ onComplete }: OnboardingDataProps): JSX.Element {
  const state = useOnboardingDataState(onComplete);
  const { categories, activeIndex, setActiveIndex, allConnected, handleNext } = state;
  const active = categories[activeIndex];

  if (state.loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div
      className={`flex flex-1 min-h-0 flex-col items-center px-8${allConnected ? ' onb-complete' : ''}`}
    >
      <div className="onb-veil" aria-hidden="true" />

      <div className="flex flex-col items-center pt-4 text-center">
        <h1 className="text-2xl font-semibold text-foreground">Connect your Data</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The more data sources you connect the more powerful Rose becomes.
        </p>
      </div>

      {/* [ring + active category label]: centered between title and submenu.
          Free space splits 2:1 with the spacer below the buttons. */}
      <div className="flex flex-col items-center justify-center" style={{ flex: '2 0 0' }}>
        <RingCarousel
          categories={categories}
          activeIndex={activeIndex}
          onSelect={setActiveIndex}
          celebrate={allConnected}
        />
        <div className="h-6 text-base font-semibold leading-6 text-foreground">{active.name}</div>
        <div className="mt-0.5 h-4 text-xs leading-4 text-muted-foreground">{active.desc}</div>
      </div>

      {/* Submenu: FIXED height (fits 4 rows; longer lists scroll) so the
          buttons row never shifts when switching categories. */}
      <div className="flex w-full max-w-sm flex-col items-center" style={{ height: 206 }}>
        <SubConnectionCard
          rows={active.rows}
          emptyText={active.emptyText}
          footerError={active.footerError}
        />
      </div>

      <ButtonsRow allConnected={allConnected} onSkip={onComplete} onNext={handleNext} />

      {/* bottom spacer: 1 share vs ring region's 2 -> submenu sits at ~2/3 vh */}
      <div style={{ flex: '1 0 0', minHeight: 24 }} aria-hidden="true" />

      <OnboardingDataModals browser={state.browser} passwords={state.passwords} chat={state.chat} />
    </div>
  );
}
