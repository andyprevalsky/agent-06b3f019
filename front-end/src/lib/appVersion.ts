/**
 * STATE MACHINE: appVersion (stale build auto refresh)
 *
 * An installed PWA (and a long-lived tab) keeps the JavaScript it launched
 * with for days: iOS resumes the suspended page instead of loading it again.
 * Each production build publishes its id in /version.json; the running page
 * compares it with its own and reloads onto the new build.
 *
 * [IDLE] --page load / resume (visible, bfcache pageshow)--> [CHECKING]
 * [CHECKING] --GET /version.json (no-store)-->
 *     same build | fetch failed | no build id -----------------> [IDLE]
 *     newer build, no unsent text ------------------------------> [RELOADING]
 *     newer build, the user has typed text ---------------------> [PENDING]
 *         (rechecked on the next resume; a draft is never thrown away)
 *     newer build already reloaded for this session -------------> [IDLE] (no loop)
 * [ANY] --vite:preloadError (a chunk of the replaced deploy is gone)--> [RELOADING]
 *       (once per session per build; with unsent text the error surfaces instead)
 */

/** Build id baked in by vite.config.ts (production builds only). */
export const APP_BUILD_ID: string | undefined = import.meta.env.VITE_ROSE_BUILD_ID || undefined;

/** Emitted next to index.html by the `rose-build-version` Vite plugin. */
export const APP_VERSION_URL = '/version.json';

/** Resumes closer together than this share one version check. */
export const APP_VERSION_MIN_CHECK_INTERVAL_MS = 30_000;

const RELOAD_GUARD_PREFIX = 'rose:version-reload:';

/** Input types whose value is something the user typed (a draft to keep). */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

interface AppVersionWatchOptions {
  buildId?: string;
  fetchImpl?: typeof fetch;
  reload?: () => void;
  now?: () => number;
}

/** True when an input, textarea or editable region holds text the user has not sent. */
export function hasUnsentText(root: ParentNode = document): boolean {
  const fields = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('textarea, input');
  for (const field of fields) {
    const typed = field instanceof HTMLTextAreaElement || TEXT_INPUT_TYPES.has(field.type);
    if (typed && field.value.trim()) return true;
  }
  for (const editable of root.querySelectorAll('[contenteditable="true"]')) {
    if (editable.textContent?.trim()) return true;
  }
  return false;
}

/** The build id currently deployed, or null when it cannot be read. */
export async function fetchDeployedBuildId(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(`${APP_VERSION_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as { buildId?: unknown };
    return typeof body.buildId === 'string' && body.buildId ? body.buildId : null;
  } catch {
    return null;
  }
}

/** Reloads at most once per session for `target`, so a lagging CDN cannot loop the page. */
function reloadOnce(target: string, reason: string, reload: () => void): boolean {
  const key = `${RELOAD_GUARD_PREFIX}${target}`;
  try {
    if (window.sessionStorage.getItem(key)) return false;
    window.sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return false;
  }
  console.warn(`[AppVersion] ${reason}; reloading`);
  reload();
  return true;
}

/** Installs the stale-build checks; returns a cleanup for tests. */
export function initAppVersionWatch(options: AppVersionWatchOptions = {}): () => void {
  const buildId = options.buildId ?? APP_BUILD_ID;
  if (!buildId || !/^https?:$/.test(window.location.protocol)) return () => {};

  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const reload = options.reload ?? (() => window.location.reload());
  const now = options.now ?? (() => Date.now());
  let lastCheck = Number.NEGATIVE_INFINITY;
  let checking = false;

  const check = async (trigger: string) => {
    if (checking || now() - lastCheck < APP_VERSION_MIN_CHECK_INTERVAL_MS) return;
    checking = true;
    lastCheck = now();
    try {
      const deployed = await fetchDeployedBuildId(fetchImpl);
      if (!deployed || deployed === buildId || document.visibilityState !== 'visible') return;
      if (hasUnsentText()) {
        lastCheck = Number.NEGATIVE_INFINITY;
        return;
      }
      reloadOnce(deployed, `build ${buildId} replaced by ${deployed} (${trigger})`, reload);
    } finally {
      checking = false;
    }
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') void check('resume');
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) void check('bfcache');
  };
  const onLoad = () => void check('load');
  const onPreloadError = (event: Event) => {
    // A typed draft outweighs the failed import: the error surfaces as before.
    if (hasUnsentText()) return;
    const reason = `a code chunk of build ${buildId} failed to load`;
    if (reloadOnce(`chunk:${buildId}`, reason, reload)) event.preventDefault();
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('vite:preloadError', onPreloadError);
  if (document.readyState === 'complete') onLoad();
  else window.addEventListener('load', onLoad, { once: true });

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('vite:preloadError', onPreloadError);
    window.removeEventListener('load', onLoad);
  };
}
