/**
 * STATE MACHINE: AppViewFrame (body of the full-screen app view)
 *
 *   [LOADING] status          → empty (no broken frame)
 *   [HIDDEN] 403 ROSE_DEV_ONLY → nothing at all
 *   [ERROR]                   → quiet "Preview unavailable"
 *   [READY] status paused     → quiet "Paused"
 *   [READY] not_running | unknown | no preview_url → quiet "Preview is starting…"
 *   [READY] running           → handoff code → <iframe> (its own origin; never the
 *                               app origin) at preview_url#rose_preview_handoff=<code>
 * The status is read once per opened view (only the open one); nothing polls.
 */
import type { ReactNode } from 'react';

import { isCrossOriginHttpUrl, PREVIEW_FRAME_SANDBOX } from './appFrame';
import { appViewTitle, type AppViewTarget } from './appViewState';
import { useCodePreviewStatus, usePreviewFrameSrc } from './useAppPreview';

function QuietText({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="app-view-quiet"
      className="grid h-full w-full place-items-center text-[14px] text-[hsl(240_6%_58%)] dark:text-[#a3a39d]"
    >
      {children}
    </div>
  );
}

export function AppViewFrame({ target }: { target: AppViewTarget }) {
  const status = useCodePreviewStatus(target.taskId);
  const ready = status.kind === 'ready' ? status.view : null;
  const previewUrl = ready ? (ready.preview_url ?? target.previewUrl) : null;
  const running = ready?.status === 'running' && isCrossOriginHttpUrl(previewUrl);
  const src = usePreviewFrameSrc({
    taskId: target.taskId,
    previewUrl: running ? previewUrl : null,
    enabled: running,
  });
  if (status.kind === 'loading' || status.kind === 'hidden') return null;
  if (status.kind === 'error') return <QuietText>Preview unavailable</QuietText>;
  if (ready?.status === 'paused') return <QuietText>Paused</QuietText>;
  if (!running) return <QuietText>Preview is starting…</QuietText>;
  if (src === null) return null;
  return (
    <iframe
      key={src}
      data-testid="app-view-frame"
      src={src}
      title={`${appViewTitle(target)} preview`}
      sandbox={PREVIEW_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  );
}
