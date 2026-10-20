/**
 * STATE MACHINE: UserAppPublish (right side of the app view header)
 *
 * PULL REQUEST (Rose / a code-session task; publish:'pull_request'):
 *   no task id → Publish disabled
 *   [IDLE] --Publish--> [PUBLISHING] --POST /claude-code-session/:taskId/publish-->
 *     ok → toast "Opened PR #n" with a link to the PR (an existing PR the push
 *          updated: "Updated PR #n") → [IDLE]
 *     409 / 502 / 404 → destructive toast with one plain line for its code → [IDLE]
 *     403 ROSE_DEV_ONLY → nothing → [IDLE]
 *   Publish only pushes the branch and opens a PR; it never merges or deploys
 *   (everyone gets Rose changes only through /deploy).
 *
 * USERCONTENT (published user app; publish:'usercontent'):
 *   [CLOSED] --Publish--> [URL SHOWN] (the app's per-user URL + Copy)
 *   [URL SHOWN] --Copy--> clipboard + "Copied" --Publish again--> [CLOSED]
 */
import { useState } from 'react';

import { useToast } from '@/hooks/use-toast';
import { copyToClipboard } from '@/lib/clipboard';
import { publishCodeSession, ROSE_DEV_ONLY, UserAppsApiError } from '@/lib/api/userApps';

import { publishErrorText } from './publishErrors';
import type { OpenAppView } from './userAppsState';

const LINK = 'text-[13px] font-semibold text-[hsl(240_15%_8%)] dark:text-[#ecece8]';

function PullRequestPublish({ taskId }: { taskId: string | null }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const publish = () => {
    if (taskId === null || busy) return;
    setBusy(true);
    publishCodeSession(taskId)
      .then(
        (result) => {
          const label = `${result.created ? 'Opened' : 'Updated'} PR #${result.pr.number}`;
          toast({
            title: label,
            description: (
              <a
                href={result.pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                View pull request
              </a>
            ),
          });
        },
        (error: unknown) => {
          if (error instanceof UserAppsApiError && error.code === ROSE_DEV_ONLY) return;
          toast({ title: publishErrorText(error), variant: 'destructive' });
        },
      )
      .finally(() => setBusy(false));
  };
  return (
    <button
      type="button"
      onClick={publish}
      disabled={taskId === null || busy}
      className={`${LINK} disabled:opacity-40`}
    >
      {busy ? 'Publishing…' : 'Publish'}
    </button>
  );
}

function UrlPublish({ url }: { url: string }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-3">
      {shown && (
        <>
          <a
            data-testid="user-app-url"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="max-w-[360px] truncate text-[12.5px] text-[hsl(240_6%_50%)] hover:underline dark:text-[#a3a39d]"
          >
            {url}
          </a>
          <button
            type="button"
            className={LINK}
            onClick={() => {
              void copyToClipboard(url).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </>
      )}
      <button
        type="button"
        aria-expanded={shown}
        className={LINK}
        onClick={() => {
          setShown((v) => !v);
          setCopied(false);
        }}
      >
        Publish
      </button>
    </div>
  );
}

export function UserAppPublish({ view }: { view: OpenAppView }) {
  if (view.publish === 'usercontent') {
    return view.url === null ? null : <UrlPublish url={view.url} />;
  }
  return <PullRequestPublish taskId={view.taskId} />;
}
