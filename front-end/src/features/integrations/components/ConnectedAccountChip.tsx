/**
 * STATE MACHINE: ConnectedAccountChip
 *
 * [DISPLAY_ONE_LINE] --removable--> [REMOVE_AFFORDANCE_VISIBLE]
 * [REMOVE_AFFORDANCE_VISIBLE] --click chip--> parent removal flow
 *
 * Pure presentation: parent components own actual connection/removal state.
 * Label, optional detail, and remove affordance all stay on one line.
 */

import { Loader2, Minus } from 'lucide-react';

interface ConnectedAccountChipProps {
  label: string;
  detail?: string;
  tone?: 'synced' | 'syncing' | 'warning' | 'error' | 'neutral';
  onRemove?: () => void;
  removeLabel?: string;
  removing?: boolean;
  /** Blocks removal while a conflicting mutation on the same entity is in flight. */
  disabled?: boolean;
  title?: string;
}

function toneClasses(tone: NonNullable<ConnectedAccountChipProps['tone']>): string {
  switch (tone) {
    case 'synced':
      return 'border-rose-500/25 bg-rose-500/10 text-rose-900 dark:text-rose-100';
    case 'syncing':
      return 'border-sky-500/25 bg-sky-500/10 text-sky-900 dark:text-sky-100';
    case 'warning':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100';
    case 'error':
      return 'border-destructive/30 bg-destructive/10 text-destructive';
    case 'neutral':
      return 'border-border bg-muted/50 text-foreground';
  }
}

export default function ConnectedAccountChip({
  label,
  detail,
  tone = 'neutral',
  onRemove,
  removeLabel,
  removing = false,
  disabled = false,
  title,
}: ConnectedAccountChipProps) {
  const classes = `group inline-flex h-5 max-w-full items-center gap-1.5 rounded border px-1.5 text-left transition-colors ${toneClasses(tone)}`;
  const hasDetail = detail !== undefined && detail !== '';
  const content = (
    <>
      <span className="min-w-0 truncate text-[11px] font-medium leading-none">
        {label}
        {hasDetail && <span className="font-normal opacity-70"> / {detail}</span>}
      </span>
      {onRemove !== undefined && (
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm bg-background/70 opacity-100 transition-colors group-hover:bg-background/90 group-focus-visible:bg-background/90">
          {removing ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <Minus className="h-2.5 w-2.5" />
          )}
        </span>
      )}
    </>
  );

  if (onRemove === undefined) {
    return (
      <span className={classes} title={title}>
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={removeLabel}
      className={`${classes} hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:opacity-60`}
      disabled={removing || disabled}
      onClick={onRemove}
      title={title}
    >
      {content}
    </button>
  );
}
