/**
 * Shared context object, types and pure resolution for Rose Desktop Apps
 * (left-bar Apps section + full-screen app view, UI ledger rows 10/39).
 * Split from the provider so rows, the app view and the code-agent chip
 * don't import the module that owns the state.
 *
 *   AppTarget (what the user opened)          + GET /api/user-ui/apps list
 *     { kind: 'app', appId }   (left-bar row)  ──┐
 *     { kind: 'task', taskId } (preview card)  ──┴─► resolveAppView() ─► OpenAppView
 *
 * A task target whose task backs a listed app (Rose's newest session, or the
 * agent that last published a user app) resolves to that app.
 */

import { createContext, useContext } from 'react';

import type { UserAppEntry } from '@/lib/api/userApps';

export type AppTarget =
  | { kind: 'app'; appId: string }
  | { kind: 'task'; taskId: string; previewUrl: string | null; title: string | null };

/** Which versions the History tab lists. */
export type AppHistoryScope = { kind: 'app'; slug: string } | { kind: 'all' } | null;

/** Everything the full-screen app view needs, resolved from a target. */
export interface OpenAppView {
  /** Stable identity: frame state resets when it changes. */
  key: string;
  title: string;
  kind: 'builtin' | 'user' | 'session';
  /** Published usercontent URL (user apps): framed directly, no sign-in. */
  url: string | null;
  /** Code-session dev-server preview (Rose / a task): status + sign-in handoff first. */
  previewUrl: string | null;
  /** The code session the query box steers and Publish opens a PR for; null = none. */
  taskId: string | null;
  publish: 'pull_request' | 'usercontent';
  history: AppHistoryScope;
}

export interface UserAppsValue {
  /** True once GET /apps succeeded (the section renders nothing before / on 403). */
  loaded: boolean;
  apps: UserAppEntry[];
  activeVersionId: string | null;
  target: AppTarget | null;
  openApp: (target: AppTarget) => void;
  closeApp: () => void;
}

export const UserAppsContext = createContext<UserAppsValue | null>(null);

/** null outside a UserAppsProvider (stock layouts, isolated tests). */
export function useUserApps(): UserAppsValue | null {
  return useContext(UserAppsContext);
}

function appView(app: UserAppEntry): OpenAppView {
  if (app.kind === 'builtin') {
    return {
      key: `app:${app.id}`,
      title: app.title,
      kind: 'builtin',
      url: null,
      previewUrl: app.preview_url,
      taskId: app.task_id,
      publish: 'pull_request',
      history: { kind: 'all' },
    };
  }
  return {
    key: `app:${app.id}`,
    title: app.title,
    kind: 'user',
    url: app.url,
    previewUrl: null,
    taskId: app.task_id,
    publish: 'usercontent',
    history: { kind: 'app', slug: app.id },
  };
}

/** The view for a target, or null when its app is no longer listed. */
export function resolveAppView(
  target: AppTarget | null,
  apps: readonly UserAppEntry[],
): OpenAppView | null {
  if (target === null) return null;
  if (target.kind === 'app') {
    const app = apps.find((a) => a.id === target.appId);
    return app ? appView(app) : null;
  }
  const owner = apps.find((a) => a.task_id === target.taskId);
  if (owner) return appView(owner);
  return {
    key: `task:${target.taskId}`,
    title: target.title ?? 'Preview',
    kind: 'session',
    url: null,
    previewUrl: target.previewUrl,
    taskId: target.taskId,
    publish: 'pull_request',
    history: null,
  };
}

/** Left-bar row of the open view (a task view highlights the app it resolved to). */
export function openAppId(target: AppTarget | null, apps: readonly UserAppEntry[]): string | null {
  const view = resolveAppView(target, apps);
  return view !== null && view.key.startsWith('app:') ? view.key.slice('app:'.length) : null;
}
