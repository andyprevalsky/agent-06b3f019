/**
 * STATE MACHINE: UserAppFrame (Preview tab body of the full-screen app view)
 *
 * PUBLISHED USER APP (view.url on the usercontent origin):
 *   → <iframe sandbox="allow-scripts"> at view.url (remounts on reloadKey)
 *
 * CODE-SESSION PREVIEW (Rose / a trajectory task):
 *   no task id                → quiet "No code session yet"
 *   [LOADING] status          → empty (no broken frame)
 *   [HIDDEN] 403 ROSE_DEV_ONLY → nothing at all
 *   [ERROR]                   → quiet "Preview unavailable"
 *   [READY] status paused     → quiet "Paused"
 *   [READY] not_running | unknown | no preview_url → quiet "Preview is starting…"
 *   [READY] running           → handoff code → <iframe> (its own origin; never the
 *                               app origin) at preview_url#rose_preview_handoff=<code>
 *   reloadKey (History restore) → status re-read + fresh handoff + new frame
 */
import type { ReactNode } from 'react';

import { isCrossOriginHttpUrl, PREVIEW_FRAME_SANDBOX, USER_APP_FRAME_SANDBOX } from './appFrame';
import type { OpenAppView } from './userAppsState';
import { useCodePreviewStatus, usePreviewFrameSrc } from './useAppPreview';

function QuietText({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="user-app-quiet"
      className="grid h-full w-full place-items-center text-[14px] text-[hsl(240_6%_58%)] dark:text-[#a3a39d]"
    >
      {children}
    </div>
  );
}

function Frame({ src, title, sandbox }: { src: string; title: string; sandbox: string }) {
  return (
    <iframe
      data-testid="user-app-frame"
      src={src}
      title={title}
      sandbox={sandbox}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  );
}

function PreviewFrame({ view, reloadKey }: { view: OpenAppView; reloadKey: number }) {
  const status = useCodePreviewStatus(view.taskId, reloadKey);
  const ready = status.kind === 'ready' ? status.view : null;
  const previewUrl = ready ? (ready.preview_url ?? view.previewUrl) : null;
  const running = ready?.status === 'running' && isCrossOriginHttpUrl(previewUrl);
  const src = usePreviewFrameSrc({
    taskId: view.taskId,
    previewUrl: running ? previewUrl : null,
    enabled: running,
    reloadKey,
  });
  if (status.kind === 'loading' || status.kind === 'hidden') return null;
  if (status.kind === 'error') return <QuietText>Preview unavailable</QuietText>;
  if (ready?.status === 'paused') return <QuietText>Paused</QuietText>;
  if (!running) return <QuietText>Preview is starting…</QuietText>;
  return src === null ? null : (
    <Frame key={src} src={src} title={`${view.title} preview`} sandbox={PREVIEW_FRAME_SANDBOX} />
  );
}

export function UserAppFrame({ view, reloadKey }: { view: OpenAppView; reloadKey: number }) {
  if (view.url !== null) {
    if (!isCrossOriginHttpUrl(view.url)) return <QuietText>Preview unavailable</QuietText>;
    return (
      <Frame
        key={`${view.url}#${reloadKey}`}
        src={view.url}
        title={view.title}
        sandbox={USER_APP_FRAME_SANDBOX}
      />
    );
  }
  if (view.taskId === null) return <QuietText>No code session yet</QuietText>;
  return <PreviewFrame view={view} reloadKey={reloadKey} />;
}
