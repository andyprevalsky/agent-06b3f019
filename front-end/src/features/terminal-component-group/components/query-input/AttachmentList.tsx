/**
 * Attachment chip list — renders one chip per pending/uploading/done/error attachment.
 *
 * Pure display: lifecycle lives in `useAttachments`. Clicking the X invokes `onRemove`.
 */

import { Loader2, X, FileIcon, ImageIcon, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { PendingAttachment } from './types';

interface AttachmentListProps {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}

export function AttachmentList({ attachments, onRemove }: AttachmentListProps) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pb-2">
      {attachments.map((attachment) => (
        <AttachmentChip
          key={attachment.id}
          attachment={attachment}
          onRemove={() => onRemove(attachment.id)}
        />
      ))}
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-2 py-1 rounded-lg text-xs border',
        STATUS_CLASSNAMES[attachment.status],
      )}
    >
      <AttachmentIcon attachment={attachment} />
      <div className="flex flex-col">
        <span className="truncate max-w-[120px]" title={attachment.file.name}>
          {attachment.file.name}
        </span>
        <span className="text-[10px] opacity-70">{formatFileSize(attachment.file.size)}</span>
      </div>
      <AttachmentStatusIndicator attachment={attachment} />
      <button
        onClick={onRemove}
        className="ml-1 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

const STATUS_CLASSNAMES: Record<PendingAttachment['status'], string> = {
  error:
    'bg-red-50 border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400',
  done: 'bg-green-50 border-green-200 text-green-700 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400',
  uploading:
    'bg-gray-100 border-gray-200 text-gray-700 dark:bg-[#2f2f2c] dark:border-white/[0.12] dark:text-[#e4e4df]',
  pending:
    'bg-gray-100 border-gray-200 text-gray-700 dark:bg-[#2f2f2c] dark:border-white/[0.12] dark:text-[#e4e4df]',
};

function AttachmentIcon({ attachment }: { attachment: PendingAttachment }) {
  if (attachment.thumbnailUrl && attachment.status === 'done') {
    return (
      <img
        src={attachment.thumbnailUrl}
        alt={attachment.file.name}
        className="w-6 h-6 object-cover rounded"
      />
    );
  }
  return getFileIcon(attachment.file);
}

function AttachmentStatusIndicator({ attachment }: { attachment: PendingAttachment }) {
  if (attachment.status === 'uploading') {
    return (
      <div className="flex items-center gap-1">
        <Loader2 className="w-3 h-3 animate-spin" />
        <span>{attachment.progress}%</span>
      </div>
    );
  }
  if (attachment.status === 'pending') {
    return <Loader2 className="w-3 h-3 animate-spin opacity-50" />;
  }
  if (attachment.status === 'done') {
    return <span className="text-green-600 dark:text-green-400">✓</span>;
  }
  if (attachment.status === 'error') {
    return (
      <Tooltip>
        <TooltipTrigger>
          <span className="text-red-600 dark:text-red-400">✗</span>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">{attachment.error || 'Upload failed'}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  return null;
}

function getFileIcon(file: File) {
  if (file.type.startsWith('image/')) return <ImageIcon className="w-4 h-4" />;
  if (file.type === 'application/pdf' || file.type.startsWith('text/')) {
    return <FileText className="w-4 h-4" />;
  }
  return <FileIcon className="w-4 h-4" />;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
