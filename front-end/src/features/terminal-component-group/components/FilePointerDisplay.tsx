/**
 * FilePointerDisplay — generic files stay a download chip; markdown FilePointers
 * render as a full-width document preview (OAi demo Task Complete report).
 *
 * STATE MACHINE: see useFilePointerPreview.
 */

import { FileIcon, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type FilePointer } from '../hooks';
import { formatFileSize } from './claudeCodeChip.utils';
import { MarkdownAttachmentCard } from './message-bubble/MarkdownAttachmentCard';
import { useFilePointerPreview } from './useFilePointerPreview';

function triggerFileDownload(url: string, filename: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

export function FilePointerDisplay({ file }: { file: FilePointer }) {
  const { downloadUrl, markdown, markdownPreview } = useFilePointerPreview(file);

  if (markdown) {
    return (
      <MarkdownAttachmentCard
        fp={file}
        preview={markdownPreview}
        onDownload={() => {
          if (downloadUrl) triggerFileDownload(downloadUrl, file.original_filename);
        }}
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
