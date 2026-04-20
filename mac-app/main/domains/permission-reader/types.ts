/**
 * Types for the permission-reader domain.
 *
 * Encapsulates the shapes produced when parsing Chrome's
 * `Preferences` file into the per-origin permission grants we sync
 * to the remote browser session.
 */

/**
 * One permission grant extracted from Chrome's `content_settings.exceptions`.
 *
 * `origin` is either a concrete origin (e.g. `https://www.amazon.com`) or a
 * subdomain-wildcard pattern (`[*.]amazon.com`) — we preserve both shapes so
 * downstream pattern-matching keeps working.
 *
 * `setting` mirrors Chrome's integer encoding: `1` = allow, `2` = block.
 * Default (`0`) and ask (`3`) values are filtered out upstream.
 */
export interface PermissionGrant {
  origin: string;
  permission: string;
  setting: number;
}

/**
 * Aggregate result returned by `readPermissions` — the flat grant list, a
 * deterministic hash over that list (drives sync-layer cache invalidation),
 * and a convenience count.
 */
export interface PermissionData {
  grants: PermissionGrant[];
  hash: string;
  grantCount: number;
}
