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
 * TEXT ONLY (attachable=false, the code-agent direct channel): no paperclip.
 *
 * LAYOUT (every variant): the paperclip sits immediately LEFT of the model
 * name (ModelSelector / session model controls / read-only model label).
 *
 * ROSE DESKTOP (roseDesktop): bare paperclip (no background/border) at the
 * model selector's 26px height, no model info button, short Rose model names
 * (rose-flash / rose-ultra), the 3-state SpeedToggle
 * right of the model selector (when `speed` is passed: Fast Mode operators),
 * and the dark-only glass send/stop button.
 *
 * CORNER STATUS (cornerStatus, the code-agent view): pinned to the box's
 * top-right corner beside the textarea, which keeps clear of it (pr-16).
 *
 * ROSE DARK (roseDark = useRoseTheme().isDark): textarea text #f2f2ef with a
 * #8c8c86 placeholder and the model chip on #2f2f2c (mock panels/dark.js).
 * Light renders the exact stock classes.
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
import type { SpeedControl } from './types';
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
  hideModelSelector?: boolean;
  readOnlyModelLabel?: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  roseDesktop?: boolean;
  /** Rose Desktop dark mode: dark textarea + model chip. */
  roseDark?: boolean;
  /** Rose Desktop speed toggle wiring; omitted when the account has no Fast Mode. */
  speed?: SpeedControl;
  /** Status at the box's top-right corner (direct channel); the textarea keeps clear of it. */
  cornerStatus?: React.ReactNode;
  /** false = text only (code-agent direct channel): no paperclip. */
  attachable?: boolean;
  sessionControls?: React.ReactNode;
}

export function InputContainer(props: InputContainerProps) {
  const {
    value,
    onChange,
    disabled,
    placeholder,
    onSubmit,
    onFilesPicked,
    textareaRef,
    roseDesktop = false,
    roseDark = false,
    speed,
    attachable = true,
  } = props;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const paperclip = attachable && (
    <PaperclipButton
      bare={roseDesktop}
      disabled={disabled || props.agentCompleted}
      onClick={() => fileInputRef.current?.click()}
    />
  );
  return (
    <>
      <HiddenFileInput ref={fileInputRef} onPicked={onFilesPicked} />
      <TextareaArea cornerStatus={props.cornerStatus}>
        <TextareaRow
          ref={textareaRef}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          disabled={disabled}
          placeholder={placeholder}
          roseDark={roseDark}
        />
      </TextareaArea>
      <div
        data-testid="query-input-controls"
        className={
          roseDesktop
            ? 'flex items-end justify-between gap-3 pt-2 w-full'
            : 'flex items-center justify-between gap-3 px-3 pt-2 w-full'
        }
      >
        <div className={roseDesktop ? 'flex items-end gap-1.5' : 'flex items-center gap-1.5'}>
          {paperclip}
          {!props.hideModelSelector && (
            <ModelSelector
              selectedModel={props.selectedModel}
              onModelChange={props.onModelChange}
              availableModels={props.availableModels}
              showModelSelector={props.showModelSelector}
              roseDesktop={roseDesktop}
              roseDark={roseDark}
            />
          )}
          {props.sessionControls}
          <ReadOnlyModelLabel label={props.readOnlyModelLabel} />
          {speed && (
            <SpeedToggle {...speed} onFastModeChange={speed.onFastModeChange ?? (() => {})} />
          )}
        </div>
        <SubmitOrStopButton
          canSubmit={props.canSubmit}
          disabled={disabled}
          hasUploadingAttachments={props.hasUploadingAttachments}
          isPausing={props.isPausing}
          onSubmit={onSubmit}
          onPause={props.onPause}
          darkGlass={roseDesktop}
          label={props.readOnlyModelLabel ? 'Send' : undefined}
        />
      </div>
    </>
  );
}

/** The textarea's row; a corner status pins to its top right and the text keeps clear of it. */
function TextareaArea({
  cornerStatus,
  children,
}: {
  cornerStatus?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={cornerStatus ? 'relative pl-3 pr-16' : 'relative px-3'}>
      {cornerStatus && (
        <div
          data-testid="query-input-corner-status"
          className="absolute right-0 top-0 z-10 flex items-center gap-1"
        >
          {cornerStatus}
        </div>
      )}
      {children}
    </div>
  );
}

function ReadOnlyModelLabel({ label }: { label?: string }) {
  return label ? (
    <span data-testid="browser-model-label" className="text-xs text-muted-foreground">
      {label}
    </span>
  ) : null;
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
  roseDark: boolean;
}

/** Rose dark textarea colors; light keeps the stock theme-variable classes. */
const ROSE_DARK_TEXTAREA_CLASS = 'dark:text-[#f2f2ef] dark:placeholder:text-[#8c8c86]';

const TextareaRow = forwardRef<HTMLTextAreaElement, TextareaRowProps>(
  ({ value, onChange, onSubmit, disabled, placeholder, roseDark }, ref) => {
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
          roseDark && ROSE_DARK_TEXTAREA_CLASS,
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
