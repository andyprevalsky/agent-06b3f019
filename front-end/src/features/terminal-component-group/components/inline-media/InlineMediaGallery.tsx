/**
 * InlineMediaGallery — images and videos inline in the trajectory by default.
 *
 * STATE MACHINE:
 *   LAYOUT  : 1 file  -> [SINGLE]  full column width, aspect preserved
 *             2+ files -> [GALLERY] horizontal snap-scrolling strip
 *   PER ITEM: [PENDING URL] (reserved-size placeholder) --signed--> [READY]
 *                                                       \--fail--> [UNAVAILABLE]
 *             [READY image] --click/tap--> DocumentPreviewDrawer
 *             [READY video] plays inline (muted, controls); bare expand icon
 *                           --click--> DocumentPreviewDrawer
 *   DRAWER  : openId === null -> [CLOSED]; openId set -> [OPEN] for that file
 *
 * Layout shift: each item reserves its box from metadata width/height when
 * present, else DEFAULT_MEDIA_ASPECT until the intrinsic size loads. Images
 * load lazily (loading="lazy"); videos fetch metadata only until played.
 * No chip, frame or tile around media — the media itself is the surface.
 *
 * SYSTEM CONTEXT:
 *   AttachmentDisplay (user + assistant message files), FilePointerDisplay /
 *   FilePointerGroup (tool results, structured outputs, completion summaries)
 *   -> InlineMediaGallery -> DocumentPreviewDrawer
 */

import { useState } from 'react';
import { Maximize2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { FilePointer } from '../../hooks';
import { DocumentPreviewDrawer } from '../DocumentPreviewDrawer';
import { DEFAULT_MEDIA_ASPECT, inlineMediaKind, metadataAspectRatio } from './inlineMedia.utils';
import { useInlineMediaUrls } from './useInlineMediaUrls';

interface InlineMediaGalleryProps {
  files: FilePointer[];
  agentId?: string;
  className?: string;
}

export function InlineMediaGallery({ files, agentId, className }: InlineMediaGalleryProps) {
  const urls = useInlineMediaUrls(files, agentId);
  const [openId, setOpenId] = useState<string | null>(null);
  if (files.length === 0) return null;
  const openFile = files.find((f) => f.id === openId) ?? null;
  const layout = files.length === 1 ? 'single' : 'gallery';

  return (
    <>
      <div
        data-testid="inline-media"
        data-layout={layout}
        className={cn(
          'w-full',
          layout === 'gallery' && 'flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1',
          className,
        )}
      >
        {files.map((file) => (
          <InlineMediaItem
            key={file.id}
            file={file}
            url={urls[file.id]}
            layout={layout}
            onOpen={() => setOpenId(file.id)}
          />
        ))}
      </div>
      <DocumentPreviewDrawer
        file={openFile}
        open={openFile !== null}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
        signedUrl={openFile ? (urls[openFile.id] ?? undefined) : undefined}
      />
    </>
  );
}

interface InlineMediaItemProps {
  file: FilePointer;
  /** undefined = pending, null = failed, string = signed URL. */
  url: string | null | undefined;
  layout: 'single' | 'gallery';
  onOpen: () => void;
}

function InlineMediaItem({ file, url, layout, onOpen }: InlineMediaItemProps) {
  const [naturalAspect, setNaturalAspect] = useState<number | null>(null);
  const aspect = metadataAspectRatio(file) ?? naturalAspect ?? DEFAULT_MEDIA_ASPECT;
  const kind = inlineMediaKind(file);
  const sizing =
    layout === 'single' ? 'w-full max-h-[80vh]' : 'h-56 shrink-0 snap-start md:h-64 max-w-[85%]';

  return (
    <div
      data-testid="inline-media-item"
      data-kind={kind ?? 'image'}
      data-filename={file.original_filename}
      className={cn('relative overflow-hidden rounded-lg', sizing)}
      style={{ aspectRatio: String(aspect) }}
    >
      {url === undefined ? (
        <div
          data-testid="inline-media-pending"
          aria-label={`Loading ${file.original_filename}`}
          className="h-full w-full animate-pulse bg-muted/50"
        />
      ) : url === null ? (
        <button
          type="button"
          data-testid="inline-media-unavailable"
          onClick={onOpen}
          className="flex h-full w-full items-center justify-center bg-muted/40 px-3 text-center text-xs text-muted-foreground"
        >
          {file.original_filename} — preview unavailable
        </button>
      ) : kind === 'video' ? (
        <InlineVideo file={file} url={url} onOpen={onOpen} onAspect={setNaturalAspect} />
      ) : (
        <InlineImage file={file} url={url} onOpen={onOpen} onAspect={setNaturalAspect} />
      )}
    </div>
  );
}

interface InlineMediaElementProps {
  file: FilePointer;
  url: string;
  onOpen: () => void;
  onAspect: (aspect: number) => void;
}

function InlineImage({ file, url, onOpen, onAspect }: InlineMediaElementProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${file.original_filename}`}
      className="block h-full w-full cursor-zoom-in"
    >
      <img
        src={url}
        alt={file.original_filename}
        loading="lazy"
        decoding="async"
        width={file.width}
        height={file.height}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            onAspect(img.naturalWidth / img.naturalHeight);
          }
        }}
        className="h-full w-full object-contain"
      />
    </button>
  );
}

function InlineVideo({ file, url, onOpen, onAspect }: InlineMediaElementProps) {
  return (
    <>
      <video
        src={url}
        aria-label={file.original_filename}
        data-testid="inline-media-video"
        muted
        playsInline
        controls
        preload="metadata"
        onLoadedMetadata={(e) => {
          const video = e.currentTarget;
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            onAspect(video.videoWidth / video.videoHeight);
          }
        }}
        className="h-full w-full bg-black object-contain"
      />
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${file.original_filename}`}
        className="absolute right-2 top-2 text-white/80 drop-shadow transition-colors hover:text-white"
      >
        <Maximize2 className="h-4 w-4" />
      </button>
    </>
  );
}
