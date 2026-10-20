/**
 * Resolves an inline trajectory view against the version it was sent with.
 *
 *   message.versionId === active.versionId → active manifest (no request)
 *   otherwise                              → GET /api/user-ui/versions (cached
 *                                            for the session; one refetch when a
 *                                            newer version is missing)
 *
 * Files resolve to `${backend}/usercontent/${versionId}/${entry}`, so a later
 * publish never changes how an older message renders.
 */
import { useEffect, useState, type RefObject } from 'react';

import { BACKEND_BASE_URL } from '@/lib/backendUrl';

import { fetchUserUiVersions } from '../api';
import { INLINE_VIEW_ROOT_MARGIN, joinUserContentUrl, versionBaseUrl } from '../config';
import type { ActiveUserUi, InlineViewMetadata, UserUiManifest } from '../types';

let versionCache: Promise<Map<string, UserUiManifest>> | null = null;
const refetchedForMissing = new Set<string>();

function loadVersions(): Promise<Map<string, UserUiManifest>> {
  if (versionCache === null) {
    versionCache = fetchUserUiVersions()
      .then((versions) => new Map(versions.map((version) => [version.id, version.manifest])))
      .catch((error: unknown) => {
        versionCache = null;
        throw error;
      });
  }
  return versionCache;
}

/** Session-scoped cache reset (logout, tests). */
export function resetUserUiVersionCache(): void {
  versionCache = null;
  refetchedForMissing.clear();
}

export async function loadVersionManifest(versionId: string): Promise<UserUiManifest | null> {
  const versions = await loadVersions();
  const found = versions.get(versionId);
  if (found || refetchedForMissing.has(versionId)) return found ?? null;
  refetchedForMissing.add(versionId);
  versionCache = null;
  return (await loadVersions()).get(versionId) ?? null;
}

export interface ResolvedInlineView {
  status: 'loading' | 'ready' | 'unavailable';
  src: string | null;
  posterUrl: string | null;
  summary: string | null;
}

function resolveFiles(
  manifest: UserUiManifest | null,
  meta: InlineViewMetadata,
): ResolvedInlineView {
  const entry = manifest?.inline?.[meta.view];
  if (!entry) return { status: 'unavailable', src: null, posterUrl: null, summary: null };
  const base = versionBaseUrl(BACKEND_BASE_URL, meta.versionId);
  return {
    status: 'ready',
    src: joinUserContentUrl(base, entry.entry),
    posterUrl: entry.poster ? joinUserContentUrl(base, entry.poster) : null,
    summary: typeof entry.summary === 'string' ? entry.summary : null,
  };
}

export function useInlineViewFiles(
  meta: InlineViewMetadata,
  active: ActiveUserUi | null,
): ResolvedInlineView {
  const pinnedIsActive = active?.versionId === meta.versionId;
  const [fetched, setFetched] = useState<UserUiManifest | null | undefined>(undefined);

  useEffect(() => {
    if (pinnedIsActive) return;
    let cancelled = false;
    setFetched(undefined);
    loadVersionManifest(meta.versionId)
      .then((manifest) => {
        if (!cancelled) setFetched(manifest);
      })
      .catch(() => {
        if (!cancelled) setFetched(null);
      });
    return () => {
      cancelled = true;
    };
  }, [meta.versionId, pinnedIsActive]);

  if (pinnedIsActive) return resolveFiles(active.manifest, meta);
  if (fetched === undefined)
    return { status: 'loading', src: null, posterUrl: null, summary: null };
  return resolveFiles(fetched, meta);
}

/** True once the element is within INLINE_VIEW_ROOT_MARGIN of the viewport. */
export function useNearViewport(ref: RefObject<HTMLElement>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setNear(entry.isIntersecting);
      },
      { rootMargin: INLINE_VIEW_ROOT_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return near;
}
