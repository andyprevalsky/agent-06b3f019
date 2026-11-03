/**
 * SubmitOrStopButton — the query box's send / stop LiquidWhiteButton.
 *
 * STATE MACHINE (SUBMIT BUTTON):
 *   [SEND]    <-- canSubmit === true (spinner while attachments upload)
 *   [STOP]    <-- canSubmit === false (renders pause/stop button)
 *   [PAUSING] <-- isPausing === true (spinner, disabled)
 *
 * darkGlass (Rose Desktop flag): adds the `rose-dark-glass` class and the SVG
 * refraction filter. roseQueryBox.css styles it only under html.dark (liquid
 * metal as a ~3px ring, black glass core, white icon); light mode keeps the
 * stock LiquidWhiteButton untouched.
 */

import { ArrowUp, Loader2, Square } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import LiquidWhiteButton from '@/components/ui/liquid-white-button';

export const DARK_GLASS_FILTER_ID = 'rose-dark-glass-refraction';

/** Black center → white rim, so the refraction is strongest at the border. */
const RIM_MASK = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs><radialGradient id="g" cx="50%" cy="50%" r="50%"><stop offset="60%" stop-color="#000"/><stop offset="100%" stop-color="#fff"/></radialGradient></defs><rect width="100" height="100" fill="url(#g)"/></svg>',
)}`;

interface SubmitOrStopButtonProps {
  canSubmit: boolean;
  disabled: boolean;
  hasUploadingAttachments: boolean;
  isPausing: boolean;
  onSubmit: () => void;
  onPause?: () => void;
  darkGlass?: boolean;
  label?: string;
}

export function SubmitOrStopButton({
  canSubmit,
  disabled,
  hasUploadingAttachments,
  isPausing,
  onSubmit,
  onPause,
  darkGlass = false,
  label,
}: SubmitOrStopButtonProps) {
  const className = darkGlass ? 'rose-dark-glass' : undefined;
  return (
    <>
      {darkGlass && <DarkGlassFilter />}
      {canSubmit ? (
        <SendButton
          className={className}
          disabled={disabled}
          hasUploadingAttachments={hasUploadingAttachments}
          onSubmit={onSubmit}
          label={label}
        />
      ) : (
        <StopButton className={className} isPausing={isPausing} onPause={onPause} />
      )}
    </>
  );
}

/** Backdrop refraction: turbulence masked to the rim, no chromatic split. */
function DarkGlassFilter() {
  return (
    <svg aria-hidden width="0" height="0" className="pointer-events-none absolute">
      <defs>
        <filter
          id={DARK_GLASS_FILTER_ID}
          x="0"
          y="0"
          width="100%"
          height="100%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.018 0.026"
            numOctaves={2}
            seed={11}
            result="noise"
          />
          <feImage
            href={RIM_MASK}
            x="0"
            y="0"
            width="100%"
            height="100%"
            preserveAspectRatio="none"
            result="rim"
          />
          <feComposite in="noise" in2="rim" operator="arithmetic" k1={1.15} result="masked" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="masked"
            scale={22}
            xChannelSelector="R"
            yChannelSelector="G"
            result="warp"
          />
          <feGaussianBlur in="warp" stdDeviation={1} />
        </filter>
      </defs>
    </svg>
  );
}

function SendButton({
  className,
  disabled,
  hasUploadingAttachments,
  onSubmit,
  label,
}: {
  className?: string;
  disabled: boolean;
  hasUploadingAttachments: boolean;
  onSubmit: () => void;
  label?: string;
}) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <LiquidWhiteButton
          className={className}
          onClick={onSubmit}
          disabled={disabled || hasUploadingAttachments}
          size="md"
          aria-label={label}
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

function StopButton({
  className,
  isPausing,
  onPause,
}: {
  className?: string;
  isPausing: boolean;
  onPause?: () => void;
}) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <LiquidWhiteButton className={className} onClick={onPause} disabled={isPausing} size="md">
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
