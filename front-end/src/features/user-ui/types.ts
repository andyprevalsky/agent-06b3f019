/**
 * Types for the per-user `rose_user_ui` runtime.
 *
 * The backend contract (`GET /api/user-ui/active`, `GET /api/user-ui/versions`)
 * returns a published manifest plus the usercontent base URL its files live at.
 * Every user-authored file runs inside a sandboxed cross-origin iframe; nothing
 * user-authored is read or applied on the app origin.
 *
 * Whole-app settings (theme.json tokens, background image + fade, and the
 * background / sidebar.header / menu / home.dashboard / agent.panel slots) were
 * removed (UI ledger row 89). A manifest that still carries `theme` or `slots`
 * (or any other unknown field) is accepted and those fields are ignored.
 */

export interface UserUiEntry {
  entry: string;
}

export interface UserUiInlineEntry extends UserUiEntry {
  summary?: string;
  poster?: string;
}

export interface UserUiManifest {
  version: 1;
  shell?: UserUiEntry;
  inline?: Record<string, UserUiInlineEntry>;
  capabilities?: string[];
}

/** `{ versionId, manifest, baseUrl }`, or `{ versionId: null }` for stock UI. */
export interface ActiveUserUiResponse {
  versionId: string | null;
  manifest?: UserUiManifest;
  baseUrl?: string;
}

/**
 * One item of `GET /api/user-ui/versions` → `{ activeVersionId, versions: [...] }`
 * (back-end/src/domains/user-ui/service.ts listVersions). Legacy `{ id }` items
 * are normalized to `versionId` by the API parser.
 */
export interface UserUiVersionSummary {
  versionId: string;
  manifest: UserUiManifest;
  fileCount?: number;
  totalBytes?: number;
  createdAt?: string;
  active?: boolean;
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

/** Name of the backend realtime event emitted when a user UI version is published/activated. */
export const USER_UI_PUBLISHED_EVENT = 'user_ui.published' as const;

/** Typed hook point for that event (see hooks/liveRefresh.ts). */
export interface UserUiPublishedEvent {
  type: typeof USER_UI_PUBLISHED_EVENT;
  /** The version that became active (null when the user reverted to stock). */
  versionId: string | null;
}

/** Messages a user view may post to the host. Anything else is dropped. */
export type UserUiViewMessage = { type: 'rose:ready' } | { type: 'rose:resize'; height: number };
