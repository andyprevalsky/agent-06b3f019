/**
 * Shared classes for the card-style integrations (GitHub Repos, CLIs, MCP servers)
 * so every connect form, row and action matches. No state.
 */

export const INTEGRATION_CARD_CLASSES =
  'rounded-lg border border-border bg-card/60 overflow-hidden';
export const INTEGRATION_CARD_HEADER_CLASSES = 'p-4 flex items-center gap-3';
export const INTEGRATION_ICON_TILE_CLASSES = 'h-9 w-9 shrink-0 overflow-hidden rounded-lg';
export const INTEGRATION_FORM_CLASSES = 'flex flex-col gap-2 border-t border-border p-4';
export const INTEGRATION_INPUT_CLASSES =
  'h-9 min-w-0 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-foreground/40';
export const INTEGRATION_CONNECT_BUTTON_CLASSES =
  'flex h-9 items-center gap-1.5 rounded-lg bg-foreground px-3 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-60';
export const INTEGRATION_ROW_CLASSES =
  'flex items-center justify-between gap-3 px-4 py-2.5 text-sm';
export const INTEGRATION_ICON_BUTTON_CLASSES =
  'h-8 w-8 shrink-0 rounded-lg flex items-center justify-center bg-muted text-muted-foreground hover:text-foreground disabled:opacity-60';
export const INTEGRATION_ADD_BUTTON_CLASSES =
  'h-9 w-9 shrink-0 rounded-lg flex items-center justify-center transition-all duration-200 bg-primary text-primary-foreground hover:bg-primary/90';
export const INTEGRATION_TEXT_ACTION_CLASSES =
  'h-8 shrink-0 rounded-lg bg-muted px-2.5 text-xs font-medium text-foreground hover:bg-muted/80 disabled:opacity-60';
