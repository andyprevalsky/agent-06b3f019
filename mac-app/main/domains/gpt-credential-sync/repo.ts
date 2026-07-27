/**
 * Repo layer for gpt-credential-sync.
 *
 * Owns every side effect the domain needs outside HTTP:
 *   - Filesystem access to Codex's auth file (`~/.codex/auth.json`)
 *   - `codex` CLI discovery, health probing, and npm install
 *   - Driving `codex login` (the ChatGPT OAuth browser flow)
 *
 * The service layer never shells out or touches the filesystem directly.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync, execSync, spawn } from 'child_process';
import { getAugmentedEnv } from '../../base/shellEnv';
import { toError } from '../../../shared/utils/error';
import type { SyncStatusCallback } from './types';
import {
  CODEX_AUTH_PATH,
  CODEX_LOGIN_TIMEOUT_MS,
  CODEX_NPM_PACKAGE,
  CODEX_VERSION_PROBE_TIMEOUT_MS,
  NPM_INSTALL_TIMEOUT_MS,
  SHELL_PROBE_TIMEOUT_MS,
} from './config';

// ---------------------------------------------------------------------------
// Codex auth file
// ---------------------------------------------------------------------------

export function hasCodexAuthFile(): boolean {
  try {
    return fs.existsSync(CODEX_AUTH_PATH);
  } catch {
    return false;
  }
}

export function readCodexAuthFile(): string | null {
  try {
    return fs.readFileSync(CODEX_AUTH_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Copy the current auth file aside before a login overwrites it.
 *
 * `codex login` replaces `auth.json` wholesale, so an existing API-key login
 * would otherwise be destroyed by connecting a ChatGPT account. Best-effort:
 * a failed backup must not block the login the user asked for.
 */
export function backupCodexAuthFile(): string | null {
  try {
    if (!fs.existsSync(CODEX_AUTH_PATH)) return null;
    const raw = fs.readFileSync(CODEX_AUTH_PATH, 'utf8');
    let mode = 'previous';
    try {
      const parsed = JSON.parse(raw) as { auth_mode?: string };
      // `auth_mode` is untrusted file content spliced into a path, so restrict it
      // to a safe slug. A value containing `/` or `..` would otherwise let the
      // backup escape ~/.codex/.
      const sanitized = (parsed.auth_mode ?? '').replace(/[^A-Za-z0-9_-]/g, '');
      if (sanitized !== '') {
        mode = sanitized.slice(0, 32);
      }
    } catch {
      // An unparseable file still deserves a backup, just under a generic name.
    }
    const backupPath = `${CODEX_AUTH_PATH}.${mode}.bak`;
    fs.writeFileSync(backupPath, raw, { mode: 0o600 });
    return backupPath;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Codex CLI discovery + health
// ---------------------------------------------------------------------------

/** Path to the npm-global `codex` binary, or null when it isn't installed. */
export function findNpmCodexPath(): string | null {
  const env = getAugmentedEnv();
  try {
    const npmPrefix = execSync('npm config get prefix', {
      stdio: 'pipe',
      encoding: 'utf8',
      env,
      timeout: SHELL_PROBE_TIMEOUT_MS,
    }).trim();
    const codexPath = path.join(npmPrefix, 'bin', 'codex');
    if (fs.existsSync(codexPath)) {
      return codexPath;
    }
  } catch {
    // npm not available.
  }
  return null;
}

/** Full path to the `codex` binary, falling back to a bare PATH lookup. */
export function getCodexPath(): string {
  return findNpmCodexPath() ?? 'codex';
}

/**
 * Whether the installed `codex` CLI can actually run.
 *
 * Presence on disk is not enough: the npm wrapper delegates to a vendored
 * per-platform binary that can go missing after an interrupted install, leaving
 * a shim on PATH whose every invocation dies with ENOENT. `codex --version` is
 * the cheapest call that exercises that delegation.
 */
export function codexCliIsUsable(): boolean {
  try {
    // execFileSync (not execSync) so the binary path is passed as an argv entry
    // rather than parsed by a shell — paths can contain spaces or metacharacters.
    execFileSync(getCodexPath(), ['--version'], {
      stdio: 'pipe',
      encoding: 'utf8',
      env: getAugmentedEnv(),
      timeout: CODEX_VERSION_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export interface CodexProcessOptions {
  onStatus: SyncStatusCallback;
  onLog: (line: string) => void;
}

/**
 * Install (or repair) the Codex CLI globally via npm.
 * Resolves on success; rejects on npm-missing, non-zero exit, or timeout.
 */
export function installCodexCLI(opts: CodexProcessOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    opts.onStatus('Installing Codex...');
    opts.onLog(`Installing ${CODEX_NPM_PACKAGE} via npm`);

    const env = getAugmentedEnv();
    let npmPath: string;
    try {
      npmPath = execSync('which npm', {
        stdio: 'pipe',
        encoding: 'utf8',
        env,
        timeout: SHELL_PROBE_TIMEOUT_MS,
      }).trim();
    } catch {
      reject(
        new Error('npm not found. Please install Node.js from https://nodejs.org and try again.')
      );
      return;
    }

    // --force so a half-installed package (missing vendored binary) is replaced
    // rather than skipped as "already satisfied".
    const proc = spawn(npmPath, ['install', '-g', '--force', CODEX_NPM_PACKAGE], {
      env,
      stdio: 'pipe',
    });

    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.stdout.on('data', (d: Buffer) => {
      opts.onLog(`npm install stdout: ${d.toString().trim()}`);
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Codex installation timed out after 2 minutes'));
    }, NPM_INSTALL_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        opts.onLog('Codex CLI installed successfully');
        resolve();
      } else {
        reject(new Error(`npm install failed (exit ${code}): ${stderr.slice(0, 200)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(toError(err));
    });
  });
}

/**
 * Run `codex login` — the ChatGPT OAuth flow, which opens the user's browser
 * and writes `auth_mode: "chatgpt"` into `~/.codex/auth.json` on success.
 *
 * Deliberately NOT `codex login --with-api-key`: an API-key login produces an
 * envelope the backend cannot use for ChatGPT-subscription compute.
 */
export function runCodexLogin(opts: CodexProcessOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const codexPath = getCodexPath();
    const env = getAugmentedEnv();

    opts.onStatus('Opening browser to sign in to ChatGPT...');
    opts.onLog(`Running: ${codexPath} login`);

    const proc = spawn(codexPath, ['login'], { env, stdio: 'pipe' });

    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line !== '') opts.onLog(`codex login: ${line}`);
    });
    proc.stderr.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      const line = chunk.trim();
      if (line !== '') opts.onLog(`codex login (stderr): ${line}`);
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('ChatGPT sign-in timed out after 5 minutes. Please try again.'));
    }, CODEX_LOGIN_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`codex login failed (exit ${code}): ${stderr.slice(0, 200)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(toError(err));
    });
  });
}
