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
 * STATE MACHINE (SUBMIT BUTTON):
 *   [SEND]  <-- canSubmit === true
 *   [STOP]  <-- canSubmit === false (renders pause/stop button)
 *   [PAUSING] <-- isPausing === true (spinner, disabled)
 *
 * KEYBOARD:
 *   plain Enter                 -> submit
 *   Cmd/Shift/Ctrl/Alt + Enter  -> native textarea newline
 */

import { useRef, forwardRef } from 'react';
import type React from 'react';
import { ArrowUp, Square, Loader2, Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import * as analytics from '@/lib/analytics';
import LiquidWhiteButton from '@/components/ui/liquid-white-button';
import { ModelSelector } from './ModelSelector';
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
            disabled={disabled || agentCompleted}
            onClick={() => fileInputRef.current?.click()}
          />
          <ModelSelector
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            availableModels={availableModels}
            showModelSelector={showModelSelector}
          />
        </div>
        <SubmitOrStopButton
          canSubmit={canSubmit}
          disabled={disabled}
          hasUploadingAttachments={hasUploadingAttachments}
          isPausing={isPausing}
          onSubmit={onSubmit}
          onPause={onPause}
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

function PaperclipButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className={cn(
            'flex items-center justify-center w-8 h-8 rounded-lg transition-colors',
            'border border-gray-300 bg-gray-100 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300',
            disabled
              ? 'opacity-50 cursor-not-allowed'
              : 'hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer',
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

interface SubmitOrStopButtonProps {
  canSubmit: boolean;
  disabled: boolean;
  hasUploadingAttachments: boolean;
  isPausing: boolean;
  onSubmit: () => void;
  onPause?: () => void;
}

function SubmitOrStopButton({
  canSubmit,
  disabled,
  hasUploadingAttachments,
  isPausing,
  onSubmit,
  onPause,
}: SubmitOrStopButtonProps) {
  if (canSubmit) {
    return (
      <SendButton
        disabled={disabled}
        hasUploadingAttachments={hasUploadingAttachments}
        onSubmit={onSubmit}
      />
    );
  }
  return <StopButton isPausing={isPausing} onPause={onPause} />;
}

function SendButton({
  disabled,
  hasUploadingAttachments,
  onSubmit,
}: {
  disabled: boolean;
  hasUploadingAttachments: boolean;
  onSubmit: () => void;
}) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <LiquidWhiteButton
          onClick={onSubmit}
          disabled={disabled || hasUploadingAttachments}
          size="md"
        >
          {hasUploadingAttachments ? (
            <Loader2 className="w-5 h-5 animate-spin" strokeWidth={2.5} />
          ) : (
            <ArrowUp className="w-5 h-5" strokeWidth={2.5} />
          )}
        </LiquidWhiteButton>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        <SubmitTooltipBody hasUploadingAttachments={hasUploadingAttachments} />
      </TooltipContent>
    </Tooltip>
  );
}

function StopButton({ isPausing, onPause }: { isPausing: boolean; onPause?: () => void }) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <LiquidWhiteButton onClick={onPause} disabled={isPausing} size="md">
          {isPausing ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Square className="w-4 h-4" fill="currentColor" />
          )}
        </LiquidWhiteButton>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        <p className="text-xs">Stop</p>
      </TooltipContent>
    </Tooltip>
  );
}

function SubmitTooltipBody({ hasUploadingAttachments }: { hasUploadingAttachments: boolean }) {
  if (hasUploadingAttachments) {
    return (
      <p className="text-xs">
        <span>Uploading files...</span>
      </p>
    );
  }
  return (
    <p className="text-xs flex items-center gap-1">
      <span>Send</span>
      <span>(</span>
      <span>Enter</span>
      <span>)</span>
    </p>
  );
}
