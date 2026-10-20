/**
 * STATE MACHINE: UserAppScreen (full-screen app view; replaces the chat column)
 *
 *   ┌ left bar ┐┌ Title   Preview · History                         Publish ┐
 *   │          ││                                                          │
 *   │          ││   app frame (UserAppFrame) | version list (History)      │
 *   │          ││                 latest exchange                          │
 *   │          ││          [ the normal query box, Popular Goals hidden ]  │
 *   └──────────┘└──────────────────────────────────────────────────────────┘
 *
 * TAB: [PREVIEW] (default) ⇄ [HISTORY]; History is hidden for a bare
 *      code-session view (no published versions belong to it). The host keys
 *      this screen by view.key, so another app starts fresh (tab, box, exchange).
 * RESTORE (History): activate ok → in-tab USER_UI_ACTIVE_CHANGED (Apps list +
 *      active UI refetch once) → [PREVIEW] with reloadKey+1 (status re-read,
 *      fresh sign-in handoff, new frame).
 * QUERY BOX (useAppComposer): steers the view's code session, or starts a
 *      normal new agent when the app has none; the latest exchange sits above it.
 * EXIT: Escape (UserAppsProvider), an agent row, Home / New Super Agent,
 *      "Open" on a started agent (shows that agent's chat), or — below md,
 *      where there is no left bar or keyboard — the header's bare close icon.
 *
 * Fixed over the content (left of it the 64px bar stays usable; the top-right
 * app icons float over the header's reserved inset). Light surfaces unchanged;
 * dark via the rose-theme `dark:` tokens.
 */
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { FilePointer } from '@/lib/api/types';
import { notifyLocalUserUiActivated } from '@/lib/openAgentActivity';
import { cn } from '@/lib/utils';

import { ROSE_ACTIVE_COLOR } from '../rose-sidebar/roseSidebarLayout';
import { useAppComposer, type AppComposer } from './useAppComposer';
import { UserAppFrame } from './UserAppFrame';
import { UserAppHistory } from './UserAppHistory';
import { UserAppPublish } from './UserAppPublish';
import type { OpenAppView } from './userAppsState';

type AppTab = 'preview' | 'history';

/** What AgentChatArea needs to render the normal query box over the app. */
export interface AppQueryBoxBinding {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (attachments?: FilePointer[]) => void;
  disabled: boolean;
  placeholder: string;
  /** true → the text goes to the app's code session (no model choice). */
  steers: boolean;
}

interface UserAppScreenProps {
  view: OpenAppView;
  onClose: () => void;
  /** NEW AGENT route: create a normal agent with this goal (POST /api/agents). */
  onStartAgent: (goal: string, attachments?: FilePointer[]) => Promise<void>;
  renderQueryBox: (binding: AppQueryBoxBinding) => ReactNode;
}

function Tabs({
  tab,
  onChange,
  withHistory,
}: {
  tab: AppTab;
  onChange: (tab: AppTab) => void;
  withHistory: boolean;
}) {
  const item = (id: AppTab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => onChange(id)}
      className={cn(
        'text-[13px]',
        tab === id
          ? 'font-semibold'
          : 'text-[hsl(240_6%_55%)] hover:text-[hsl(240_15%_8%)] dark:text-[#a3a39d] dark:hover:text-[#ecece8]',
      )}
      style={tab === id ? { color: ROSE_ACTIVE_COLOR } : undefined}
    >
      {label}
    </button>
  );
  return (
    <div role="tablist" aria-label="App views" className="flex items-center gap-2">
      {item('preview', 'Preview')}
      {withHistory && (
        <>
          <span aria-hidden="true" className="text-[hsl(240_6%_70%)] dark:text-[#6f6f69]">
            ·
          </span>
          {item('history', 'History')}
        </>
      )}
    </div>
  );
}

function ExchangeLine({ composer, onClose }: { composer: AppComposer; onClose: () => void }) {
  const exchange = composer.exchange;
  if (exchange === null) return null;
  return (
    <div
      data-testid="user-app-exchange"
      className="mx-auto mb-2 max-w-4xl rounded-xl bg-white/95 px-4 py-2.5 text-[13.5px] shadow-[0_6px_24px_rgba(20,20,40,0.10)] dark:bg-[#2f2f2c]/95 dark:text-[#ecece8]"
    >
      <div>
        <span className="text-[hsl(240_6%_55%)] dark:text-[#a3a39d]">You:</span> {exchange.you}
      </div>
      {exchange.reply !== null && <div className="mt-1">{exchange.reply}</div>}
      {exchange.startedAgent && (
        <div className="mt-1 text-[hsl(240_6%_55%)] dark:text-[#a3a39d]">
          Started a new agent ·{' '}
          <button
            type="button"
            onClick={onClose}
            className="font-semibold hover:underline"
            style={{ color: ROSE_ACTIVE_COLOR }}
          >
            Open
          </button>
        </div>
      )}
    </div>
  );
}

export function UserAppScreen({ view, onClose, onStartAgent, renderQueryBox }: UserAppScreenProps) {
  const [tab, setTab] = useState<AppTab>('preview');
  const [reloadKey, setReloadKey] = useState(0);
  const composer = useAppComposer(view, onStartAgent);
  const onRestored = (versionId: string) => {
    notifyLocalUserUiActivated(versionId);
    setReloadKey((k) => k + 1);
    setTab('preview');
  };
  return (
    <div
      data-testid="user-app-screen"
      data-app-kind={view.kind}
      className="fixed inset-y-0 left-0 right-0 z-[60] flex flex-col bg-white text-[hsl(240_15%_8%)] dark:bg-[#262624] dark:text-[#ecece8] md:left-16"
    >
      <header
        className="flex h-14 flex-none items-center gap-6 border-b border-gray-200/80 pl-6 dark:border-white/[0.09]"
        style={{ paddingRight: 'calc(var(--rose-app-icons-inset, 0px) + 24px)' }}
      >
        <h1 className="truncate text-[15px] font-semibold">{view.title}</h1>
        <Tabs tab={tab} onChange={setTab} withHistory={view.history !== null} />
        <div className="ml-auto">
          <UserAppPublish view={view} />
        </div>
        <button
          type="button"
          aria-label={`Close ${view.title}`}
          onClick={onClose}
          className="text-[hsl(240_6%_55%)] hover:text-[hsl(240_15%_8%)] dark:text-[#a3a39d] dark:hover:text-[#ecece8] md:hidden"
        >
          <X className="h-5 w-5" strokeWidth={1.7} />
        </button>
      </header>
      <div className="relative min-h-0 flex-1">
        {tab === 'history' && view.history !== null ? (
          <UserAppHistory scope={view.history} onRestored={onRestored} />
        ) : (
          <UserAppFrame view={view} reloadKey={reloadKey} />
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-6 md:px-8">
          <div className="pointer-events-auto mx-auto max-w-4xl">
            <ExchangeLine composer={composer} onClose={onClose} />
            {composer.error !== null && (
              <p role="alert" className="mb-1 text-xs text-red-600 dark:text-red-400">
                {composer.error}
              </p>
            )}
            {renderQueryBox({
              value: composer.value,
              onChange: composer.setValue,
              onSubmit: composer.submit,
              disabled: composer.sending,
              placeholder: composer.steers ? `Message ${view.title} directly…` : 'Enter any goal',
              steers: composer.steers,
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
