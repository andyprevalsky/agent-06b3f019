/**
 * Inner form for the launcher pill — attach + input + submit.
 *
 * Layout (always — paperclip + send vertically centered in the FULL box):
 *
 *   [ 📎 ]   [ chips?          ]   [ ↑ ]
 *            [ textarea…       ]
 */

import {
  useEffect,
  useRef,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { ArrowUp, Paperclip } from 'lucide-react';
import type { LauncherLocalAttachment } from '../types';
import QueryFormMiddle from './QueryFormMiddle';

interface QueryFormProps {
  query: string;
  setQuery: (value: string) => void;
  submitting: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  handleSubmit: (event?: FormEvent) => Promise<void>;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  canSubmitWithoutQuery?: boolean;
  attachments: LauncherLocalAttachment[];
  onRemoveAttachment: (id: string) => void;
  onPickFiles: (files: FileList | File[]) => void;
  attachError: string | null;
  onContentHeightChange?: (height: number) => void;
}

const FORM_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  height: '100%',
  gap: 10,
  paddingLeft: 14,
  paddingRight: 4,
  boxSizing: 'border-box',
};

const ATTACH_BUTTON_STYLE: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  border: 'none',
  background: 'transparent',
  color: 'var(--launcher-muted)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  padding: 0,
  cursor: 'pointer',
  alignSelf: 'center',
};

const SUBMIT_BUTTON_STYLE: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: '50%',
  border: 'var(--launcher-submit-border)',
  background: 'var(--launcher-submit-bg)',
  boxShadow: 'var(--launcher-submit-shadow)',
  color: 'var(--launcher-submit-icon)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  padding: 0,
  alignSelf: 'center',
};

function useQueryFormLayout(
  query: string,
  attachments: LauncherLocalAttachment[],
  attachError: string | null,
  inputRef: RefObject<HTMLTextAreaElement | null>,
  middleRef: RefObject<HTMLDivElement | null>,
  onContentHeightChange?: (height: number) => void
): void {
  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 18 * 5 + 22)}px`;
  }, [query, inputRef]);

  useEffect(() => {
    if (onContentHeightChange === undefined || middleRef.current === null) return;
    onContentHeightChange(middleRef.current.scrollHeight);
  }, [query, attachments, attachError, onContentHeightChange, middleRef]);
}

function AttachButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="attach-button"
      aria-label="Attach files"
      disabled={disabled}
      onClick={onClick}
      style={{
        ...ATTACH_BUTTON_STYLE,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <Paperclip size={16} strokeWidth={2.25} />
    </button>
  );
}

function SubmitButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="submit-button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...SUBMIT_BUTTON_STYLE,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <ArrowUp className="w-5 h-5" strokeWidth={2.5} />
    </button>
  );
}

const QueryForm = ({
  query,
  setQuery,
  submitting,
  inputRef,
  handleSubmit,
  handleKeyDown,
  canSubmitWithoutQuery = false,
  attachments,
  onRemoveAttachment,
  onPickFiles,
  attachError,
  onContentHeightChange,
}: QueryFormProps): React.JSX.Element => {
  const canSubmit = !submitting && (query.trim() !== '' || canSubmitWithoutQuery);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const middleRef = useRef<HTMLDivElement>(null);
  useQueryFormLayout(query, attachments, attachError, inputRef, middleRef, onContentHeightChange);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = event.target.files;
    if (files !== null && files.length > 0) onPickFiles(files);
    event.target.value = '';
  };

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      style={FORM_STYLE}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        data-testid="launcher-file-input"
        onChange={onFileChange}
      />
      <AttachButton disabled={submitting} onClick={() => fileInputRef.current?.click()} />
      <QueryFormMiddle
        middleRef={middleRef}
        inputRef={inputRef}
        query={query}
        setQuery={setQuery}
        submitting={submitting}
        handleKeyDown={handleKeyDown}
        attachments={attachments}
        onRemoveAttachment={onRemoveAttachment}
        attachError={attachError}
      />
      <SubmitButton
        disabled={!canSubmit}
        onClick={() => {
          void handleSubmit();
        }}
      />
    </form>
  );
};

export default QueryForm;
