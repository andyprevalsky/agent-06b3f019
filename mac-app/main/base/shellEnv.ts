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
import { execFileSync } from 'child_process';

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

/**
 * The user's PATH according to their own login shell.
 *
 * Probes `$SHELL` rather than hard-coding bash: macOS defaults to zsh, and a
 * bash login shell does not source `~/.zshrc`, so PATH entries added there
 * (where most user-installed CLIs land) would be invisible. Executed argv-style
 * so no part of the shell path is re-parsed by another shell.
 */
function loginShellPath(): string[] {
  try {
    const shell = process.env.SHELL ?? '/bin/zsh';
    const output = execFileSync(shell, ['-ilc', 'echo $PATH'], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: SHELL_PATH_PROBE_TIMEOUT_MS,
    }).trim();
    // `-i` sources rc files, which routinely echo banners/version notices to
    // stdout before our own `echo`. PATH is the LAST line; splitting the whole
    // buffer on ':' would inject those banner fragments as PATH entries.
    const shellPath = output.split('\n').pop()?.trim() ?? '';
    return shellPath === '' ? [] : shellPath.split(':').filter(Boolean);
  } catch {
    return [];
  }
}

function discoverExtraPaths(): string[] {
  const home = process.env.HOME ?? '';

  // Order matters: the first bin dir containing `npm` wins, and that decides
  // which Node install `npm config get prefix` reports. The ACTIVE toolchain has
  // to come first — `$NVM_BIN`, then the user's own login-shell PATH. Leading
  // with the version scan below would let an arbitrary readdirSync order resolve
  // `npm` against an inactive Node, installing CLIs under the wrong prefix.
  const activePaths: string[] = [];
  if (process.env.NVM_BIN !== undefined && process.env.NVM_BIN !== '') {
    activePaths.push(process.env.NVM_BIN);
  }
  activePaths.push(...loginShellPath());

  const standardPaths = ['/usr/local/bin', '/opt/homebrew/bin', `${home}/.npm-global/bin`];

  // Fallback only: every NVM node version bin dir, for a packaged Electron app
  // that inherited neither NVM_BIN nor a usable login-shell PATH.
  const nvmFallbackPaths: string[] = [];
  try {
    const nvmDir = process.env.NVM_DIR ?? `${home}/.nvm`;
    const versionsDir = path.join(nvmDir, 'versions', 'node');
    if (fs.existsSync(versionsDir)) {
      for (const version of fs.readdirSync(versionsDir)) {
        const binDir = path.join(versionsDir, version, 'bin');
        if (fs.existsSync(binDir)) {
          nvmFallbackPaths.push(binDir);
        }
      }
    }
  } catch {
    // NVM not installed, skip.
  }

  const seen = new Set<string>();
  return [...activePaths, ...standardPaths, ...nvmFallbackPaths].filter((entry) => {
    if (entry === '' || seen.has(entry)) return false;
    seen.add(entry);
    return true;
  });
}

/**
 * Build a ProcessEnv whose PATH covers the common install locations for `npm`
 * and npm-global CLIs, ordered so the user's ACTIVE toolchain resolves first:
 * `$NVM_BIN` and the login-shell PATH, then standard bin dirs, then a scan of
 * every NVM node version as a last-resort fallback.
 *
 * Discovery is cached for the process lifetime; only the first call pays the
 * login-shell probe.
 */
export function getAugmentedEnv(): NodeJS.ProcessEnv {
  cachedExtraPaths ??= discoverExtraPaths();
  const PATH = [...cachedExtraPaths, process.env.PATH].filter(Boolean).join(':');
  return { ...process.env, PATH };
}
