/**
 * Compact chip row for files held in the quick launcher (pre-upload).
 */

import type { CSSProperties } from 'react';
import { FileIcon, ImageIcon, FileText, X } from 'lucide-react';
import type { LauncherLocalAttachment } from '../types';

interface AttachmentChipsProps {
  attachments: LauncherLocalAttachment[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

const CHIP_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  maxWidth: 148,
  padding: '5px 9px',
  borderRadius: 9999,
  background: 'var(--launcher-chip-bg)',
  color: 'var(--launcher-text)',
  fontSize: 11,
  lineHeight: 1.2,
};

const AttachmentChips = ({
  attachments,
  onRemove,
  disabled = false,
}: AttachmentChipsProps): React.JSX.Element | null => {
  if (attachments.length === 0) return null;

  return (
    <div style={ROW_STYLE} data-testid="launcher-attachments">
      {attachments.map((attachment) => (
        <div key={attachment.id} style={CHIP_STYLE} data-testid="launcher-attachment-chip">
          <FileGlyph file={attachment.file} />
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 96,
            }}
            title={attachment.file.name}
          >
            {attachment.file.name}
          </span>
          <button
            type="button"
            aria-label={`Remove ${attachment.file.name}`}
            disabled={disabled}
            onClick={() => onRemove(attachment.id)}
            style={{
              border: 'none',
              background: 'transparent',
              padding: 0,
              display: 'inline-flex',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              color: 'inherit',
            }}
          >
            <X size={12} strokeWidth={2.5} />
          </button>
        </div>
      ))}
    </div>
  );
};

function FileGlyph({ file }: { file: File }): React.JSX.Element {
  if (file.type.startsWith('image/')) return <ImageIcon size={12} />;
  if (file.type === 'application/pdf' || file.type.startsWith('text/')) {
    return <FileText size={12} />;
  }
  return <FileIcon size={12} />;
}

export default AttachmentChips;
