/**
 * STATE MACHINE: CodeAgentPreviewCard (live preview inside a code-agent chip,
 * UI ledger rows 10/39: "trajectory shows the app")
 *
 * Shown when the chip's code_agent carries preview_url (dev cloud sessions) and
 * an Apps provider is mounted (Rose Desktop terminal).
 *   [OFF SCREEN] → empty card, no frame and no reads
 *   [ON SCREEN]  → POST …/preview/handoff (fresh single-use code) → scaled live
 *                  frame of the 1280×800 preview (pointer-events off, lazy)
 *   [ON SCREEN] --scrolled away--> [OFF SCREEN] (frame unmounted)
 *   click → open the full-screen app view for this task (Rose when the task is
 *           Rose's newest session)
 *
 * 10k agents: frames exist only for cards on screen; one observer per card.
 */
import { useRef } from 'react';

import {
  isCrossOriginHttpUrl,
  PREVIEW_CARD_SCALE,
  PREVIEW_CARD_VIEWPORT,
  PREVIEW_CARD_WIDTH,
  PREVIEW_FRAME_SANDBOX,
} from './appFrame';
import { useUserApps } from './userAppsState';
import { useOnScreen, usePreviewFrameSrc } from './useAppPreview';

export function CodeAgentPreviewCard({
  taskId,
  previewUrl,
  title,
}: {
  taskId: string;
  previewUrl: string;
  title: string | null;
}) {
  const userApps = useUserApps();
  const cardRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(cardRef);
  const valid = isCrossOriginHttpUrl(previewUrl);
  const src = usePreviewFrameSrc({
    taskId,
    previewUrl: valid ? previewUrl : null,
    enabled: onScreen && userApps !== null,
    reloadKey: 0,
  });
  if (userApps === null || !valid) return null;
  const height = Math.round(PREVIEW_CARD_VIEWPORT.height * PREVIEW_CARD_SCALE);
  return (
    <div className="px-3.5 pb-3">
      <div
        ref={cardRef}
        data-testid="code-agent-preview-card"
        className="relative overflow-hidden rounded-lg border border-border bg-white dark:border-white/[.09]"
        style={{ width: PREVIEW_CARD_WIDTH, height }}
      >
        {onScreen && src !== null && (
          <iframe
            data-testid="code-agent-preview-frame"
            src={src}
            title={`${title ?? 'App'} live preview`}
            sandbox={PREVIEW_FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            loading="lazy"
            tabIndex={-1}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
            style={{
              width: PREVIEW_CARD_VIEWPORT.width,
              height: PREVIEW_CARD_VIEWPORT.height,
              transform: `scale(${PREVIEW_CARD_SCALE})`,
            }}
          />
        )}
        <button
          type="button"
          aria-label={`Open ${title ?? 'app'} preview`}
          onClick={() => userApps.openApp({ kind: 'task', taskId, previewUrl, title })}
          className="absolute inset-0 h-full w-full cursor-pointer"
        />
      </div>
    </div>
  );
}
