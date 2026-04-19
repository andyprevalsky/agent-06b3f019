/**
 * FilePointerDisplay — renders a single FilePointer as a clickable download chip.
 *
 * STATE MACHINE:
 * [NO URL] --> downloadUrl: null (link disabled)
 *     |
 *     v (createSignedUrl resolves)
 * [READY] --> downloadUrl: string (anchor active, download icon shown)
 *
 * Silently falls back to the disabled state if the signed URL cannot be created —
 * the user still sees the filename and size.
 */

import { useEffect, useState } from 'react';
import { FileIcon, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { type FilePointer } from '../hooks';
import { formatFileSize } from './claudeCodeChip.utils';

const SIGNED_URL_TTL_SECONDS = 3600;

export function FilePointerDisplay({ file }: { file: FilePointer }) {
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function getUrl() {
      try {
        const { data } = await supabase.storage
          .from('attachments')
          .createSignedUrl(file.storage_path, SIGNED_URL_TTL_SECONDS);
        if (!cancelled && data?.signedUrl) {
          setDownloadUrl(data.signedUrl);
        }
      } catch {
        // Silently fail — user can still see filename
      }
    }
    void getUrl();
    return () => {
      cancelled = true;
    };
  }, [file.storage_path]);

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
