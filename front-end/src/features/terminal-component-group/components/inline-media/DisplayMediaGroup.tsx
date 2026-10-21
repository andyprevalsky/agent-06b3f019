/**
 * DisplayMediaGroup — one `display` call's items in the trajectory (Rose Desktop).
 *
 * STATE MACHINE (stateless split; per-item URL states live in the children):
 *   requester is a code agent → "<agent> · via display" attribution line
 *   caption (first item only)  → text above the media
 *   images / videos            → ONE InlineMediaGallery (single or strip)
 *   page/bundle/model/pdf or text/html with file_pointer.usercontent_url (cross-origin http(s)):
 *       [FRAME] sandbox="allow-scripts allow-pointer-lock allow-popups" on the usercontent origin
 *       [FRAME] --rose:resize--> height clamped 200..900px
 *   text/html without one (older rows) or a same-origin/invalid one → DisplayHtmlLink:
 *       [SIGNING] --signed URL--> [LINK] plain open/download link (never framed)
 *                 --failed-----> [UNAVAILABLE] filename notice
 *
 * SYSTEM CONTEXT:
 *   MessageListItems (groupDisplayMedia) → DisplayMediaGroup
 *     → InlineMediaGallery → DocumentPreviewDrawer
 *     → display-specific iframe + shared resize bridge (never allow-same-origin)
 *
 * HTML is framed ONLY from the backend's usercontent URL (a separate origin
 * that serves display HTML for exactly this frame); the URL guard refuses any
 * same-origin URL, and the opaque sandbox keeps the page away from app
 * cookies, storage and the session. The storage URL is a download, not a page.
 */

import { useRef, useState } from 'react';

import { isAllowedUserContentUrl } from '@/features/user-ui';
import { useUserViewBridge } from '@/features/user-ui/hooks/useUserViewBridge';
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

/** Older display rows (no usercontent URL): a plain link to the stored file. */
function DisplayHtmlLink({ item, agentId }: { item: DisplayMediaItem; agentId?: string }) {
  const urls = useInlineMediaUrls([item.file], agentId);
  const url = urls[item.file.id];
  const filename = item.file.original_filename;
  if (url === null) {
    return (
      <p data-testid="display-html-unavailable" className="text-xs text-muted-foreground">
        {filename} — preview unavailable
      </p>
    );
  }
  if (url === undefined) {
    return (
      <p data-testid="display-html-pending" className="text-sm text-muted-foreground">
        {filename}
      </p>
    );
  }
  return (
    <a
      data-testid="display-html-link"
      href={url}
      download={filename}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sm font-medium text-foreground underline underline-offset-2"
    >
      Open {filename}
    </a>
  );
}

function DisplayHtmlFrame({ item, agentId }: { item: DisplayMediaItem; agentId?: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(HTML_FRAME_DEFAULT_HEIGHT);
  const src = item.usercontent_url;
  const allowed = !!src && isAllowedUserContentUrl(src);
  useUserViewBridge({
    frameRef,
    src: allowed ? src : null,
    onResize: (next) => setHeight(clampHeight(next)),
  });
  if (!allowed) {
    return <DisplayHtmlLink item={item} agentId={agentId} />;
  }
  return (
    <iframe
      ref={frameRef}
      src={src}
      title={item.file.original_filename}
      data-testid="display-html-frame"
      data-user-ui-frame="true"
      sandbox="allow-scripts allow-pointer-lock allow-popups"
      referrerPolicy="no-referrer"
      className="w-full rounded-lg bg-white"
      style={{ height, border: 0, colorScheme: 'normal' }}
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
