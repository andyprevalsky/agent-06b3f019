/**
 * InputContainer — textarea + bottom bar (paperclip, model picker, submit/stop).
 *
 * STATE MACHINE (INPUT):
 *   [EMPTY] <-- value === ''
 *       |
 *       | (type)
 *       v
 *   [HAS_TEXT] <-- value: string
 *       |
 *       | (submit / clear)
 *       v
 *   [EMPTY]
 *
 * STATE MACHINE (SUBMIT BUTTON): owned by SubmitOrStopButton (SubmitButtons.tsx)
 *   [SEND] <-- canSubmit; [STOP] <-- !canSubmit; [PAUSING] <-- isPausing
 *
 * ROSE DESKTOP (roseDesktop): bare paperclip (no background/border) at the
 * model selector's 26px height, no model info button, the 3-state SpeedToggle
 * right of the model selector (when `speed` is passed: Fast Mode operators),
 * and the dark-only glass send/stop button.
 *
 * KEYBOARD:
 *   plain Enter                 -> submit
 *   Cmd/Shift/Ctrl/Alt + Enter  -> native textarea newline
 */

import { useRef, forwardRef } from 'react';
import type React from 'react';
import { Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import * as analytics from '@/lib/analytics';
import { SpeedToggle } from '../FastModeToggle';
import { ModelSelector } from './ModelSelector';
import { SubmitOrStopButton } from './SubmitButtons';
import type { Model } from '../../hooks';

interface InputContainerProps {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder: string;
  onSubmit: () => void;
  onFilesPicked: (files: FileList) => void;
  agentCompleted: boolean;
  canSubmit: boolean;
  onPause?: () => void;
  isPausing: boolean;
  hasUploadingAttachments: boolean;
  selectedModel: string;
  onModelChange?: (model: string) => void;
  availableModels: Model[];
  showModelSelector: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  roseDesktop?: boolean;
  /** Rose Desktop speed toggle wiring; omitted when the account has no Fast Mode. */
  speed?: { fastMode: boolean; onFastModeChange?: (enabled: boolean) => void };
}

export function InputContainer(props: InputContainerProps) {
  const {
    value,
    onChange,
    disabled,
    placeholder,
    onSubmit,
    onFilesPicked,
    agentCompleted,
    canSubmit,
    onPause,
    isPausing,
    hasUploadingAttachments,
    selectedModel,
    onModelChange,
    availableModels,
    showModelSelector,
    textareaRef,
    roseDesktop = false,
    speed,
  } = props;
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <HiddenFileInput ref={fileInputRef} onPicked={onFilesPicked} />
      <div className="relative px-3">
        <TextareaRow
          ref={textareaRef}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          disabled={disabled}
          placeholder={placeholder}
        />
      </div>
      <div className="flex items-center justify-between gap-3 px-3 pt-2 w-full">
        <div className="flex items-center gap-1.5">
          <PaperclipButton
            bare={roseDesktop}
            disabled={disabled || agentCompleted}
            onClick={() => fileInputRef.current?.click()}
          />
          <ModelSelector
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            availableModels={availableModels}
            showModelSelector={showModelSelector}
            showInfo={!roseDesktop}
          />
          {speed && (
            <SpeedToggle
              fastMode={speed.fastMode}
              onFastModeChange={speed.onFastModeChange ?? (() => {})}
            />
          )}
        </div>
        <SubmitOrStopButton
          canSubmit={canSubmit}
          disabled={disabled}
          hasUploadingAttachments={hasUploadingAttachments}
          isPausing={isPausing}
          onSubmit={onSubmit}
          onPause={onPause}
          darkGlass={roseDesktop}
        />
      </div>
    </>
  );
}

interface HiddenFileInputProps {
  onPicked: (files: FileList) => void;
}

const HiddenFileInput = forwardRef<HTMLInputElement, HiddenFileInputProps>(({ onPicked }, ref) => (
  <input
    ref={ref}
    type="file"
    multiple
    className="hidden"
    onChange={(e) => {
      if (e.target.files && e.target.files.length > 0) {
        onPicked(e.target.files);
        e.target.value = '';
      }
    }}
  />
));
HiddenFileInput.displayName = 'HiddenFileInput';

interface TextareaRowProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  placeholder: string;
}

const TextareaRow = forwardRef<HTMLTextAreaElement, TextareaRowProps>(
  ({ value, onChange, onSubmit, disabled, placeholder }, ref) => {
    const hasTrackedTyping = useRef(false);
    const hasTrackedFocus = useRef(false);
    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isModifiedEnter = e.metaKey || e.shiftKey || e.ctrlKey || e.altKey;
      if (e.key === 'Enter' && !isModifiedEnter && !e.nativeEvent.isComposing) {
        e.preventDefault();
        onSubmit();
      }
    };
    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      if (!hasTrackedTyping.current && e.target.value.length > 0) {
        analytics.track('goal_typed');
        hasTrackedTyping.current = true;
      }
      onChange(e.target.value);
    };
    const handleFocus = () => {
      if (!hasTrackedFocus.current) {
        analytics.track('querybox_clicked');
        hasTrackedFocus.current = true;
      }
    };
    return (
      <textarea
        ref={ref}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        disabled={disabled}
        placeholder={placeholder}
        className={cn(
          'w-full bg-transparent border-none text-foreground placeholder:text-muted-foreground',
          'resize-none outline-none min-h-[56px] py-3',
          'font-normal text-base leading-6',
        )}
        rows={2}
      />
    );
  },
);
TextareaRow.displayName = 'TextareaRow';

const STOCK_PAPERCLIP_CLASS =
  'flex items-center justify-center w-8 h-8 rounded-lg transition-colors border border-gray-300 bg-gray-100 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300';
/** Rose Desktop: no background, border or shadow; hover darkens the icon only. */
const BARE_PAPERCLIP_CLASS =
  'flex items-center justify-center w-[26px] h-[26px] transition-colors bg-transparent text-muted-foreground hover:text-foreground';

function PaperclipButton({
  bare,
  disabled,
  onClick,
}: {
  bare: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={bare ? 'Attach files' : undefined}
          data-bare={bare ? 'true' : undefined}
          className={cn(
            bare ? BARE_PAPERCLIP_CLASS : STOCK_PAPERCLIP_CLASS,
            disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
            !disabled && !bare && 'hover:bg-gray-200 dark:hover:bg-gray-700',
          )}
        >
          <Paperclip className="w-4 h-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p className="text-xs">Attach files (drag & drop or paste)</p>
      </TooltipContent>
    </Tooltip>
  );
}
