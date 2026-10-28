/**
 * Middle column of the launcher form: chips + error + textarea.
 */

import type { CSSProperties, KeyboardEvent, RefObject } from 'react';
import type { LauncherLocalAttachment } from '../types';
import AttachmentChips from './AttachmentChips';

const TEXTAREA_STYLE: CSSProperties = {
  width: '100%',
  minWidth: 0,
  background: 'transparent',
  fontSize: 13,
  lineHeight: '18px',
  color: 'var(--launcher-text)',
  border: 'none',
  outline: 'none',
  resize: 'none',
  padding: '11px 0',
  margin: 0,
  fontFamily: 'inherit',
  overflow: 'hidden',
  boxSizing: 'border-box',
};

interface QueryFormMiddleProps {
  middleRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  query: string;
  setQuery: (value: string) => void;
  submitting: boolean;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  attachments: LauncherLocalAttachment[];
  onRemoveAttachment: (id: string) => void;
  attachError: string | null;
}

const QueryFormMiddle = ({
  middleRef,
  inputRef,
  query,
  setQuery,
  submitting,
  handleKeyDown,
  attachments,
  onRemoveAttachment,
  attachError,
}: QueryFormMiddleProps): React.JSX.Element => {
  const hasFiles = attachments.length > 0;
  return (
    <div
      ref={middleRef}
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: hasFiles ? 8 : 0,
        paddingTop: hasFiles ? 12 : 0,
        paddingBottom: hasFiles ? 12 : 0,
      }}
    >
      <AttachmentChips
        attachments={attachments}
        onRemove={onRemoveAttachment}
        disabled={submitting}
      />
      {attachError !== null && attachError !== '' ? (
        <div
          data-testid="launcher-attach-error"
          style={{ fontSize: 11, color: 'var(--launcher-error)', lineHeight: 1.2 }}
        >
          {attachError}
        </div>
      ) : null}
      <textarea
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={submitting}
        placeholder="Enter any desire"
        className="placeholder-input"
        rows={1}
        style={TEXTAREA_STYLE}
      />
    </div>
  );
};

export default QueryFormMiddle;
