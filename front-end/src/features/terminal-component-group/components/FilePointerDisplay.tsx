/**
 * FilePointerDisplay — generic files stay a download chip; markdown FilePointers
 * render as a full-width document preview (OAi demo Task Complete report).
 *
 * STATE MACHINE:
 * [NO URL] --> downloadUrl: null (chip disabled / markdown preview loading)
 *     |
 *     v (createSignedUrl resolves)
 * [READY CHIP] --> non-markdown: signed URL + download chip
 * [MD LOADING] --> markdown: signed URL fetched, body in flight
 *     |
 *     +--> [MD READY] --> MarkdownAttachmentCard with decoded text
 *     +--> [MD ERROR] --> preview error; download still uses the signed URL
 *
 * Silently keeps the chip/filename visible if the signed URL cannot be created.
 */

import { useEffect, useState } from 'react';
import { FileIcon, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { type FilePointer } from '../hooks';
import { formatFileSize } from './claudeCodeChip.utils';
import { isMarkdownFile } from './message-bubble/attachmentUtils';
import { MarkdownAttachmentCard } from './message-bubble/MarkdownAttachmentCard';
import type { MarkdownAttachmentPreview } from './message-bubble/useMarkdownAttachments';

const SIGNED_URL_TTL_SECONDS = 3600;

export function FilePointerDisplay({ file }: { file: FilePointer }) {
  const markdown = isMarkdownFile(file);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownAttachmentPreview | undefined>(
    markdown ? { status: 'loading' } : undefined,
  );

  useEffect(() => {
    let cancelled = false;
    async function getUrl() {
      try {
        const { data } = await supabase.storage
          .from('attachments')
          .createSignedUrl(file.storage_path, SIGNED_URL_TTL_SECONDS);
        if (cancelled) return;
        if (!data?.signedUrl) {
          if (markdown) {
            setMarkdownPreview({ status: 'error', message: 'Failed to load preview' });
          }
          return;
        }
        setDownloadUrl(data.signedUrl);
        if (!markdown) return;
        try {
          const response = await fetch(data.signedUrl);
          if (!response.ok) throw new Error('Failed to load preview');
          const text = await response.text();
          if (!cancelled) setMarkdownPreview({ status: 'ready', text });
        } catch (error) {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : 'Failed to load preview';
          setMarkdownPreview({ status: 'error', message });
        }
      } catch {
        if (!cancelled && markdown) {
          setMarkdownPreview({ status: 'error', message: 'Failed to load preview' });
        }
      }
    }
    void getUrl();
    return () => {
      cancelled = true;
    };
  }, [file.storage_path, markdown]);

  const handleDownload = () => {
    if (!downloadUrl) return;
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = file.original_filename;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  if (markdown) {
    return (
      <MarkdownAttachmentCard
        fp={file}
        preview={markdownPreview}
        onDownload={() => handleDownload()}
      />
    );
  }

  return (
    <a
      href={downloadUrl || '#'}
      download={file.original_filename}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-1 rounded-md',
        'bg-muted hover:bg-muted/80 transition-colors',
        'text-sm text-foreground',
        !downloadUrl && 'pointer-events-none opacity-60',
      )}
    >
      <FileIcon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="truncate max-w-[200px]">{file.original_filename}</span>
      <span className="text-[10px] text-muted-foreground">({formatFileSize(file.size_bytes)})</span>
      {downloadUrl && <Download className="h-3 w-3 text-muted-foreground" />}
    </a>
  );
}
