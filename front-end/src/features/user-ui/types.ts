/**
 * Types for the per-user `rose_user_ui` runtime.
 *
 * The backend contract (`GET /api/user-ui/active`, `GET /api/user-ui/versions`)
 * returns a published manifest plus the usercontent base URL its files live at.
 * Every user-authored file runs inside a sandboxed cross-origin iframe; only
 * `theme.json` is read on the app origin, and it is data (validated tokens).
 */

export const USER_UI_SLOT_NAMES = [
  'background',
  'sidebar.header',
  'menu',
  'home.dashboard',
  'agent.panel',
] as const;

export type UserUiSlotName = (typeof USER_UI_SLOT_NAMES)[number];

export interface UserUiEntry {
  entry: string;
}

export interface UserUiInlineEntry extends UserUiEntry {
  summary?: string;
  poster?: string;
}

export interface UserUiManifest {
  version: 1;
  theme?: string;
  shell?: UserUiEntry;
  slots?: Partial<Record<UserUiSlotName, UserUiEntry>>;
  inline?: Record<string, UserUiInlineEntry>;
  capabilities?: string[];
}

/** `{ versionId, manifest, baseUrl }`, or `{ versionId: null }` for stock UI. */
export interface ActiveUserUiResponse {
  versionId: string | null;
  manifest?: UserUiManifest;
  baseUrl?: string;
}

export interface UserUiVersionSummary {
  id: string;
  manifest: UserUiManifest;
}

export interface UserUiThemeBackground {
  image?: string;
  fadeAfterFirstMessage?: number;
}

export interface UserUiTheme {
  tokens?: Record<string, string>;
  background?: UserUiThemeBackground;
}

/** `message.metadata.inlineView` — pinned to the version that produced it. */
export interface InlineViewMetadata {
  view: string;
  versionId: string;
  props?: unknown;
}

/** The fully-resolved active UI the host renders (null fields = stock UI). */
export interface ActiveUserUi {
  versionId: string;
  manifest: UserUiManifest;
  baseUrl: string;
}

export interface ResolvedBackground {
  /** Theme background image (null when only a `background` slot exists). */
  imageUrl: string | null;
  fadeOpacity: number;
}

/** Messages a user view may post to the host. Anything else is dropped. */
export type UserUiViewMessage = { type: 'rose:ready' } | { type: 'rose:resize'; height: number };
