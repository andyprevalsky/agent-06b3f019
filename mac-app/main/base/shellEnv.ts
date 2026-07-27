/**
 * Shell environment discovery for shelling out from the main process.
 *
 * A packaged Electron app inherits a minimal PATH from launchd — it typically
 * contains neither `npm` nor any globally-installed CLI (`claude`, `codex`).
 * Every domain that shells out to a developer CLI needs the same PATH
 * augmentation, so it lives here rather than being re-derived per domain.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/** Timeout for the login-shell probe used to recover the user's real PATH. */
export const SHELL_PATH_PROBE_TIMEOUT_MS = 3_000;

/**
 * Cached discovered PATH segments.
 *
 * Discovery spawns a login shell, which blocks the Electron main thread for up
 * to SHELL_PATH_PROBE_TIMEOUT_MS. The answer does not change over a session, so
 * it is computed once and reused — every later caller pays nothing.
 */
let cachedExtraPaths: string[] | null = null;

/** Reset the discovery cache. Test-only seam. */
export function resetAugmentedEnvCache(): void {
  cachedExtraPaths = null;
}

function discoverExtraPaths(): string[] {
  const home = process.env.HOME ?? '';
  const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', `${home}/.npm-global/bin`];

  // Include ALL NVM node version bin dirs (packaged Electron won't have NVM_DIR set).
  try {
    const nvmDir = process.env.NVM_DIR ?? `${home}/.nvm`;
    const versionsDir = path.join(nvmDir, 'versions', 'node');
    if (fs.existsSync(versionsDir)) {
      for (const version of fs.readdirSync(versionsDir)) {
        const binDir = path.join(versionsDir, version, 'bin');
        if (fs.existsSync(binDir)) {
          extraPaths.push(binDir);
        }
      }
    }
  } catch {
    // NVM not installed, skip.
  }

  // Also try the user's default shell PATH as a last resort.
  try {
    const shellPath = execSync('/bin/bash -ilc "echo $PATH"', {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: SHELL_PATH_PROBE_TIMEOUT_MS,
    }).trim();
    if (shellPath !== '') {
      extraPaths.push(...shellPath.split(':'));
    }
  } catch {
    // Ignore.
  }

  return extraPaths;
}

/**
 * Build a ProcessEnv whose PATH covers the common install locations for `npm`
 * and npm-global CLIs: standard bin dirs, every NVM node version's bin dir, and
 * the user's own login-shell PATH as a last resort.
 *
 * Discovery is cached for the process lifetime; only the first call pays the
 * login-shell probe.
 */
export function getAugmentedEnv(): NodeJS.ProcessEnv {
  cachedExtraPaths ??= discoverExtraPaths();
  const PATH = [...cachedExtraPaths, process.env.PATH].filter(Boolean).join(':');
  return { ...process.env, PATH };
}
