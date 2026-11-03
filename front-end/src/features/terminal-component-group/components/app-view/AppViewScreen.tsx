/**
 * STATE MACHINE: AppViewScreen (full-screen app view; replaces the chat column)
 *
 *   ┌ left bar ┐┌ Title                                              Publish ┐
 *   │          ││                                                          │
 *   │          ││            live preview of the code session              │
 *   │          ││                 (AppViewFrame)                           │
 *   │          ││                 latest exchange                          │
 *   │          ││          [ the normal query box, Popular Goals hidden ]  │
 *   └──────────┘└──────────────────────────────────────────────────────────┘
 *
 * OPENED BY: a code-agent chip's Open app button (code_agent.preview_url).
 * QUERY BOX (useAppComposer): every message steers that code session
 *      ("Message Claude Code directly…" / "Message Codex directly…").
 * PUBLISH (AppViewPublish): push the branch + open a PR; never merge or deploy.
 * EXIT: Escape (AppViewProvider), an agent row, a project's or Home's + / New Super Agent, or —
 *      below md, where there is no left bar or keyboard — the bare close icon.
 * The host keys this screen by task, so another session starts fresh.
 *
 * Fixed over the content (left of it the 64px bar stays usable; the top-right
 * app icons float over the header's reserved inset). Light surfaces unchanged;
 * dark via the rose-theme `dark:` tokens.
 */
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { FilePointer } from '@/lib/api/types';

import { codeAgentLabel } from '../../hooks/codeAgentContract';
import { AppViewFrame } from './AppViewFrame';
import { AppViewPublish } from './AppViewPublish';
import { appViewTitle, type AppViewTarget } from './appViewState';
import { useAppComposer, type AppComposer } from './useAppComposer';

/** What the host needs to render the normal query box over the app. */
export interface AppQueryBoxBinding {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (attachments?: FilePointer[]) => Promise<boolean>;
  draftKey: string;
  disabled: boolean;
  placeholder: string;
}

interface AppViewScreenProps {
  target: AppViewTarget;
  onClose: () => void;
  renderQueryBox: (binding: AppQueryBoxBinding) => ReactNode;
}

function ExchangeLine({ composer }: { composer: AppComposer }) {
  const exchange = composer.exchange;
  if (exchange === null) return null;
  return (
    <div
      data-testid="app-view-exchange"
      className="mx-auto mb-2 max-w-4xl rounded-xl bg-white/95 px-4 py-2.5 text-[13.5px] shadow-[0_6px_24px_rgba(20,20,40,0.10)] dark:bg-[#2f2f2c]/95 dark:text-[#ecece8]"
    >
      <div>
        <span className="text-[hsl(240_6%_55%)] dark:text-[#a3a39d]">You:</span> {exchange.you}
      </div>
      {exchange.reply !== null && <div className="mt-1">{exchange.reply}</div>}
    </div>
  );
}

export function AppViewScreen({ target, onClose, renderQueryBox }: AppViewScreenProps) {
  const title = appViewTitle(target);
  const agentLabel = codeAgentLabel(target.provider);
  const composer = useAppComposer(target.taskId, agentLabel);
  return (
    <div
      data-testid="app-view-screen"
      className="fixed inset-y-0 left-0 right-0 z-[60] flex flex-col bg-white text-[hsl(240_15%_8%)] dark:bg-[#262624] dark:text-[#ecece8] md:left-16"
    >
      <header
        className="flex h-14 flex-none items-center gap-6 border-b border-gray-200/80 pl-6 dark:border-white/[0.09]"
        style={{ paddingRight: 'calc(var(--rose-app-icons-inset, 0px) + 24px)' }}
      >
        <h1 className="min-w-0 truncate text-[15px] font-semibold">{title}</h1>
        <div className="ml-auto">
          <AppViewPublish taskId={target.taskId} />
        </div>
        <button
          type="button"
          aria-label={`Close ${title}`}
          onClick={onClose}
          className="text-[hsl(240_6%_55%)] hover:text-[hsl(240_15%_8%)] dark:text-[#a3a39d] dark:hover:text-[#ecece8] md:hidden"
        >
          <X className="h-5 w-5" strokeWidth={1.7} />
        </button>
      </header>
      <div className="relative min-h-0 flex-1">
        <AppViewFrame target={target} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-6 md:px-8">
          <div className="pointer-events-auto mx-auto max-w-4xl">
            <ExchangeLine composer={composer} />
            {composer.error !== null && (
              <p role="alert" className="mb-1 text-xs text-red-600 dark:text-red-400">
                {composer.error}
              </p>
            )}
            {renderQueryBox({
              draftKey: target.taskId,
              value: composer.value,
              onChange: composer.setValue,
              onSubmit: composer.submit,
              disabled: composer.sending,
              placeholder: `Message ${agentLabel} directly…`,
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
