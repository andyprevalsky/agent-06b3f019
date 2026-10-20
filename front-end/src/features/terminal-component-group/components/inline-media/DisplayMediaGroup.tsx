/**
 * DisplayMediaGroup — one `display` call's items in the trajectory (Rose Desktop).
 *
 * STATE MACHINE (stateless split; per-item URL states live in the children):
 *   requester is a code agent → "<agent> · via display" attribution line
 *   caption (first item only)  → text above the media
 *   images / videos            → ONE InlineMediaGallery (single or strip)
 *   text/html                  → DisplayHtmlFrame each:
 *       [SIGNING] --signed URL--> [FRAME] sandbox="allow-scripts", cross-origin
 *                 --failed-----> [UNAVAILABLE] filename notice
 *       [FRAME] --rose:resize--> height clamped 200..900px
 *
 * SYSTEM CONTEXT:
 *   MessageListItems (groupDisplayMedia) → DisplayMediaGroup
 *     → InlineMediaGallery → DocumentPreviewDrawer
 *     → UserUiFrame (features/user-ui: never same-origin, no allow-same-origin)
 *
 * HTML loads from the attachment's signed storage URL, a separate origin from
 * the app; UserUiFrame refuses any same-origin URL, and the opaque sandbox keeps
 * the page away from app cookies, storage and the session.
 */

import { useState } from 'react';

import { UserUiFrame } from '@/features/user-ui';
import { isHtmlDisplayMedia, type DisplayMediaItem } from '../../hooks/codeAgentContract';
import { CodeAgentAttribution } from '../CodeAgentAttribution';
import { InlineMediaGallery } from './InlineMediaGallery';
import { inlineMediaKind } from './inlineMedia.utils';
import { useInlineMediaUrls } from './useInlineMediaUrls';

const HTML_FRAME_DEFAULT_HEIGHT = 480;
const HTML_FRAME_MIN_HEIGHT = 200;
const HTML_FRAME_MAX_HEIGHT = 900;

function clampHeight(height: number): number {
  return Math.min(HTML_FRAME_MAX_HEIGHT, Math.max(HTML_FRAME_MIN_HEIGHT, Math.round(height)));
}

function DisplayHtmlFrame({ item, agentId }: { item: DisplayMediaItem; agentId?: string }) {
  const urls = useInlineMediaUrls([item.file], agentId);
  const url = urls[item.file.id];
  const [height, setHeight] = useState(HTML_FRAME_DEFAULT_HEIGHT);
  if (url === null) {
    return (
      <p data-testid="display-html-unavailable" className="text-xs text-muted-foreground">
        {item.file.original_filename} — preview unavailable
      </p>
    );
  }
  if (url === undefined) {
    return (
      <div
        data-testid="display-html-pending"
        aria-label={`Loading ${item.file.original_filename}`}
        className="w-full animate-pulse rounded-lg bg-muted/50"
        style={{ height }}
      />
    );
  }
  return (
    <UserUiFrame
      src={url}
      title={item.file.original_filename}
      testId="display-html-frame"
      onResize={(next) => setHeight(clampHeight(next))}
      className="w-full rounded-lg bg-white"
      style={{ height }}
    />
  );
}

export function DisplayMediaGroup({
  items,
  agentId,
}: {
  items: DisplayMediaItem[];
  agentId?: string;
}) {
  const [lead] = items;
  if (!lead) return null;
  const html = items.filter(isHtmlDisplayMedia);
  const media = items.filter((item) => !isHtmlDisplayMedia(item) && inlineMediaKind(item.file));
  const requester = lead.requester;
  return (
    <div data-testid="display-media" className="flex w-full flex-col gap-2">
      {requester?.kind === 'code_agent' && (
        <CodeAgentAttribution requester={requester} via="display" />
      )}
      {lead.caption && <p className="whitespace-pre-wrap text-sm">{lead.caption}</p>}
      {media.length > 0 && (
        <InlineMediaGallery files={media.map((item) => item.file)} agentId={agentId} />
      )}
      {html.map((item) => (
        <DisplayHtmlFrame key={item.file.id} item={item} agentId={agentId} />
      ))}
    </div>
  );
}
