/**
 * STATE MACHINE: AppViewPublish (right side of the app view header)
 *
 *   [IDLE] --Publish--> [PUBLISHING] --POST /claude-code-session/:taskId/publish-->
 *     ok → toast "Opened PR #n" with a link to the PR (an existing PR the push
 *          updated: "Updated PR #n") → [IDLE]
 *     409 / 502 / 404 → destructive toast with one plain line for its code → [IDLE]
 *     403 ROSE_DEV_ONLY → nothing → [IDLE]
 *
 * Publish only pushes the session's branch and opens a PR; it never merges or
 * deploys (everyone gets Rose changes only through /deploy).
 */
import { useState } from 'react';

import { useToast } from '@/hooks/use-toast';
import { CodePreviewApiError, publishCodeSession, ROSE_DEV_ONLY } from '@/lib/api/codePreview';

import { publishErrorText } from './publishErrors';

export function AppViewPublish({ taskId }: { taskId: string }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const publish = () => {
    if (busy) return;
    setBusy(true);
    publishCodeSession(taskId)
      .then(
        (result) => {
          toast({
            title: `${result.created ? 'Opened' : 'Updated'} PR #${result.pr.number}`,
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
          if (error instanceof CodePreviewApiError && error.code === ROSE_DEV_ONLY) return;
          toast({ title: publishErrorText(error), variant: 'destructive' });
        },
      )
      .finally(() => setBusy(false));
  };
  return (
    <button
      type="button"
      onClick={publish}
      disabled={busy}
      className="text-[13px] font-semibold text-[hsl(240_15%_8%)] disabled:opacity-40 dark:text-[#ecece8]"
    >
      {busy ? 'Publishing…' : 'Publish'}
    </button>
  );
}
