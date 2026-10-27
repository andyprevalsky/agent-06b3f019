/**
 * STATE MACHINE: ConnectedAccountChip
 *
 * Two layouts, chosen by whether the chip owns a repair action:
 *
 * [SINGLE_ACTION]  (onResync undefined)
 *   root is a <button>; the whole chip is the remove affordance.
 *   [DISPLAY] --click chip--> parent removal flow
 *
 * [SPLIT_ACTION]  (onResync defined)
 *   root is a <span> holding up to three slots:
 *     [warning icon] [label / detail] [resync button] [remove button]
 *   [DISPLAY] --click resync--> parent repair flow
 *   [DISPLAY] --click remove--> parent removal flow
 *
 * The split layout exists because a damaged integration needs TWO distinct
 * actions, and nesting a second <button> inside the single-action chip's root
 * <button> is invalid HTML. Single-action chips keep the original whole-chip
 * behaviour so healthy chips elsewhere (Plaid, compute) are unchanged.
 *
 * [DESKTOP]  (variant="desktop", Rose Desktop flag on)
 *   root is a rounded <span data-tone>; removal is its own × button:
 *     [warning icon] [label · detail] [resync button] [× remove button]
 *   [DISPLAY] --click ×--> parent removal flow
 *   [DISPLAY] --click resync--> parent repair flow
 *   Dark mode lightens each tone's text so every chip stays readable.
 *
 * Pure presentation: parent components own actual connection/removal state.
 */

import { AlertTriangle, Loader2, Minus, RefreshCw, X } from 'lucide-react';

interface ConnectedAccountChipProps {
  label: string;
  detail?: string;
  tone?: 'synced' | 'syncing' | 'warning' | 'error' | 'neutral';
  onRemove?: () => void;
  removeLabel?: string;
  removing?: boolean;
  /** Repair action for a damaged account. Its presence selects the split layout. */
  onResync?: () => void;
  resyncLabel?: string;
  resyncing?: boolean;
  /** Blocks removal while a conflicting mutation on the same entity is in flight. */
  disabled?: boolean;
  title?: string;
  /** `desktop` = Rose Desktop chip with its own × remove button. Default `stock`. */
  variant?: 'stock' | 'desktop';
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

function desktopToneClasses(tone: NonNullable<ConnectedAccountChipProps['tone']>): string {
  switch (tone) {
    case 'synced':
      return 'border-rose-500/25 bg-rose-500/[0.08] text-rose-900 dark:text-rose-200';
    case 'syncing':
      return 'border-sky-500/25 bg-sky-500/[0.08] text-sky-900 dark:text-sky-200';
    case 'warning':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200';
    case 'error':
      return 'border-destructive/30 bg-destructive/10 text-destructive dark:text-red-300';
    case 'neutral':
      return 'border-border bg-muted/50 text-foreground dark:text-[#ecece8]';
  }
}

const DESKTOP_ACTION_CLASSES =
  'grid h-4 w-4 shrink-0 place-items-center rounded-full opacity-60 transition-opacity hover:bg-black/5 hover:opacity-100 focus-visible:opacity-100 disabled:opacity-40 dark:hover:bg-white/10';

/** Rose Desktop chip: label plus explicit resync / × controls, readable in dark mode. */
function DesktopAccountChip({
  label,
  detail,
  tone = 'neutral',
  onRemove,
  removeLabel,
  removing = false,
  onResync,
  resyncLabel,
  resyncing = false,
  disabled = false,
  title,
}: ConnectedAccountChipProps) {
  const isDamaged = tone === 'warning' || tone === 'error';
  return (
    <span
      data-tone={tone}
      title={title}
      className={`inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border pl-2.5 pr-1 text-xs ${desktopToneClasses(tone)}`}
    >
      {isDamaged && <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />}
      <span className="min-w-0 truncate">
        {label}
        {detail !== undefined && detail !== '' && <span className="opacity-70"> · {detail}</span>}
      </span>
      {onResync !== undefined && (
        <button
          type="button"
          aria-label={resyncLabel}
          className={DESKTOP_ACTION_CLASSES}
          disabled={resyncing || removing || disabled}
          onClick={onResync}
        >
          {resyncing ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <RefreshCw className="h-2.5 w-2.5" />
          )}
        </button>
      )}
      {onRemove !== undefined && (
        <button
          type="button"
          aria-label={removeLabel}
          className={DESKTOP_ACTION_CLASSES}
          disabled={removing || resyncing || disabled}
          onClick={onRemove}
        >
          {removing ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <X className="h-2.5 w-2.5" strokeWidth={2.6} />
          )}
        </button>
      )}
    </span>
  );
}

const ACTION_SLOT_CLASSES =
  'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm bg-background/70 transition-colors hover:bg-background/90 focus-visible:bg-background/90 disabled:opacity-60';

export default function ConnectedAccountChip(props: ConnectedAccountChipProps) {
  if (props.variant === 'desktop') return <DesktopAccountChip {...props} />;
  return <StockAccountChip {...props} />;
}

function StockAccountChip({
  label,
  detail,
  tone = 'neutral',
  onRemove,
  removeLabel,
  removing = false,
  onResync,
  resyncLabel,
  resyncing = false,
  disabled = false,
  title,
}: ConnectedAccountChipProps) {
  const classes = `group inline-flex h-5 max-w-full items-center gap-1.5 rounded border px-1.5 text-left transition-colors ${toneClasses(tone)}`;
  const hasDetail = detail !== undefined && detail !== '';
  const isDamaged = tone === 'warning' || tone === 'error';

  const labelNode = (
    <span className="min-w-0 truncate text-[11px] font-medium leading-none">
      {label}
      {hasDetail && <span className="font-normal opacity-70"> / {detail}</span>}
    </span>
  );

  // ── Split layout: a damaged chip with its own repair action ──
  if (onResync !== undefined) {
    return (
      <span className={classes} title={title}>
        {isDamaged && <AlertTriangle className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />}
        {labelNode}
        <button
          type="button"
          aria-label={resyncLabel}
          className={ACTION_SLOT_CLASSES}
          disabled={resyncing || removing || disabled}
          onClick={onResync}
        >
          {resyncing ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <RefreshCw className="h-2.5 w-2.5" />
          )}
        </button>
        {onRemove !== undefined && (
          <button
            type="button"
            aria-label={removeLabel}
            className={`${ACTION_SLOT_CLASSES} hover:text-destructive`}
            disabled={removing || resyncing || disabled}
            onClick={onRemove}
          >
            {removing ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <Minus className="h-2.5 w-2.5" />
            )}
          </button>
        )}
      </span>
    );
  }

  // ── Single-action layout: unchanged legacy behaviour ──
  const content = (
    <>
      {labelNode}
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
