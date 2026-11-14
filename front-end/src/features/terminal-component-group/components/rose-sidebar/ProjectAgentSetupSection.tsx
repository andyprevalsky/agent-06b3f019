/**
 * STATE MACHINE: ProjectAgentSetupSection ("Set up with your coding agent")
 *
 *   Project settings shows a prompt the user pastes into their coding agent
 *   (boxes.dev's wording; lib/agentInitPrompt.ts). The prompt carries a
 *   one-time login code bound to this project (POST /api/projects/cli-login-codes);
 *   `rose agent-init --login-code <code>` exchanges it once.
 *
 *   [MINTING] --201--> [READY code] --Copy--> [COPIED] (prompt in clipboard)
 *       │                 │                       └─ a fresh code is minted at once:
 *       │                 │                          each copied prompt is single-use
 *       │                 └─ 60 s before expiresAt --> [MINTING] (refresh)
 *       └─ error --> [FAILED] --Try again--> [MINTING]
 *
 *   While a refresh mints, the previous prompt stays visible and copyable
 *   (still valid for another minute) unless the project changed: a code is
 *   never shown for a project other than the one it was minted for. [COPIED] shows "Copied" for 2 s, then
 *   [READY]. A clipboard failure shows an inline hint to select and copy the
 *   prompt by hand. Project change → [MINTING] for the new project.
 */

import { useCallback, useEffect, useState } from 'react';

import { agentInitPrompt } from '@/lib/agentInitPrompt';
import { createCliLoginCode, type CliLoginCode } from '@/lib/api/projects';
import { copyToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

import { ROSE_ACTIVE_COLOR } from './roseSidebarLayout';

/** Mint the next code this long before the current one expires. */
export const AGENT_SETUP_REFRESH_MARGIN_MS = 60_000;
const MIN_REFRESH_DELAY_MS = 5_000;
const COPIED_MS = 2_000;

const MUTED = 'text-[hsl(240_8%_45%)] dark:text-[#a3a39d]';
const H3 = 'mb-2 mt-[22px] text-[13px] font-semibold';
const PROMPT_BOX =
  'mt-1.5 w-full whitespace-pre-wrap break-words rounded-[10px] border border-[#eef0f3] dark:border-white/[0.09] bg-[#fafafb] dark:bg-[#2f2f2c] px-3.5 py-3 font-mono text-[11.5px] leading-[1.55] text-slate-700 dark:text-[#ecece8] select-all';

/** `projectId` is the project the login was minted for; never shown for another one. */
type MintState =
  | { status: 'minting'; projectId: string; login: CliLoginCode | null }
  | { status: 'ready'; projectId: string; login: CliLoginCode }
  | { status: 'failed'; projectId: string; login: null };

function useProjectLoginCode(projectId: string) {
  const [state, setState] = useState<MintState>({ status: 'minting', projectId, login: null });
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    let cancelled = false;
    // Keep the previous prompt visible while a refresh mints, but only for the same project.
    setState((prev) => ({
      status: 'minting',
      projectId,
      login: prev.projectId === projectId ? prev.login : null,
    }));
    createCliLoginCode(projectId).then(
      (login) => {
        if (!cancelled) setState({ status: 'ready', projectId, login });
      },
      () => {
        if (!cancelled) setState({ status: 'failed', projectId, login: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, generation]);

  const expiresAt = state.login?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return undefined;
    const delay = Math.max(
      MIN_REFRESH_DELAY_MS,
      Date.parse(expiresAt) - Date.now() - AGENT_SETUP_REFRESH_MARGIN_MS,
    );
    const timer = setTimeout(refresh, delay);
    return () => clearTimeout(timer);
  }, [expiresAt, refresh]);

  return { state, refresh };
}

export function ProjectAgentSetupSection({ projectId }: { projectId: string }) {
  const { state, refresh } = useProjectLoginCode(projectId);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const login = state.projectId === projectId ? state.login : null;
  const prompt = login !== null ? agentInitPrompt(login.code) : null;

  useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
  }, [projectId]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    if (prompt === null) return;
    try {
      await copyToClipboard(prompt);
      setCopied(true);
      setCopyFailed(false);
      refresh();
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };

  return (
    <section aria-label="Set up with your coding agent">
      <div className="flex items-center justify-between gap-4">
        <h3 className={H3}>Set up with your coding agent</h3>
        <button
          type="button"
          disabled={prompt === null}
          onClick={() => void copy()}
          className="mt-[22px] mb-2 font-semibold disabled:opacity-40"
          style={{ color: ROSE_ACTIVE_COLOR }}
        >
          {copied ? 'Copied' : 'Copy prompt'}
        </button>
      </div>
      <p className={MUTED}>
        Paste this into Claude Code, Codex or another coding agent in this folder&apos;s directory.
      </p>
      {prompt !== null ? (
        <p data-testid="agent-setup-prompt" className={PROMPT_BOX}>
          {prompt}
        </p>
      ) : state.status === 'failed' && state.projectId === projectId ? (
        <p role="alert" className="mt-1.5 text-[#e5484d]">
          Could not create a setup code.{' '}
          <button type="button" onClick={refresh} className="font-semibold underline">
            Try again
          </button>
        </p>
      ) : (
        <p role="status" className={cn(MUTED, 'mt-1.5')}>
          Creating a setup code…
        </p>
      )}
      {copyFailed && (
        <p role="alert" className="mt-1 text-[#e5484d]">
          Copy failed. Select the prompt and copy it instead.
        </p>
      )}
      <p className={cn(MUTED, 'mt-1.5 text-[12px]')}>
        Each code works once and expires in 30 minutes; a fresh one appears automatically.
      </p>
    </section>
  );
}
