/**
 * Repo layer for claude-credential-sync.
 *
 * Owns all side-effecting boundaries the domain touches outside of HTTP:
 *   - macOS Keychain reads/writes via `security(1)`
 *   - claude CLI discovery / install / `claude setup-token` OAuth flow
 *   - Filesystem probes (NVM versions dir, claude binary path)
 *   - Process-env + user shell PATH augmentation
 *
 * Service layer never shells out or touches the filesystem directly — it goes
 * through these named, typed functions.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync, execSync, spawn } from 'child_process';
import type { SyncStatusCallback } from './types';
import {
  CLAUDE_SETUP_TOKEN_TIMEOUT_MS,
  KEYCHAIN_SERVICE,
  LONG_LIVED_TOKEN_TTL_MS,
  NPM_INSTALL_TIMEOUT_MS,
  SHELL_PATH_PROBE_TIMEOUT_MS,
} from './config';

// ---------------------------------------------------------------------------
// PATH augmentation (packaged Electron has a minimal PATH)
// ---------------------------------------------------------------------------

/**
 * Build a ProcessEnv whose PATH covers the common install locations for
 * `npm` and `claude` — critical for packaged Electron apps where the
 * inherited PATH is minimal.
 */
export function getAugmentedEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? '';
  const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', `${home}/.npm-global/bin`];

  // Include ALL NVM node version bin dirs (packaged Electron won't have NVM_DIR set).
  try {
    const nvmDir = process.env.NVM_DIR ?? `${home}/.nvm`;
    const versionsDir = path.join(nvmDir, 'versions', 'node');
    if (fs.existsSync(versionsDir)) {
      const versions = fs.readdirSync(versionsDir);
      for (const v of versions) {
        const binDir = path.join(versionsDir, v, 'bin');
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

  const PATH = [...extraPaths, process.env.PATH].filter(Boolean).join(':');
  return { ...process.env, PATH };
}

// ---------------------------------------------------------------------------
// Claude CLI discovery + install
// ---------------------------------------------------------------------------

/**
 * Find the npm-installed claude binary path. Prefers npm global install over
 * any bundled/app-local copy. Returns null if not found.
 */
export function findNpmClaudePath(): string | null {
  const env = getAugmentedEnv();
  try {
    const npmBin = execSync('npm config get prefix', {
      stdio: 'pipe',
      encoding: 'utf8',
      env,
    }).trim();
    const claudePath = path.join(npmBin, 'bin', 'claude');
    if (fs.existsSync(claudePath)) {
      return claudePath;
    }
  } catch {
    // npm not available.
  }
  return null;
}

/** Full path to the npm-installed `claude` binary, falling back to a PATH lookup. */
export function getClaudePath(): string {
  return findNpmClaudePath() ?? 'claude';
}

export interface InstallClaudeCLIOptions {
  onStatus: SyncStatusCallback;
  onLog: (line: string) => void;
}

/**
 * Install the Claude Code CLI globally via npm.
 * Resolves on success; rejects on npm-missing, non-zero exit, or timeout.
 */
export function installClaudeCLI(opts: InstallClaudeCLIOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    opts.onStatus('Installing Claude Code...');
    opts.onLog('Installing Claude Code via npm');

    const env = getAugmentedEnv();
    let npmPath: string;
    try {
      npmPath = execSync('which npm', { stdio: 'pipe', encoding: 'utf8', env }).trim();
    } catch {
      reject(
        new Error('npm not found. Please install Node.js from https://nodejs.org and try again.')
      );
      return;
    }

    const proc = spawn(npmPath, ['install', '-g', '@anthropic-ai/claude-code'], {
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
      reject(new Error('Claude Code installation timed out after 2 minutes'));
    }, NPM_INSTALL_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        opts.onLog('Claude Code installed successfully');
        resolve();
      } else {
        reject(new Error(`npm install failed (exit ${code}): ${stderr.slice(0, 200)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Keychain primitives
// ---------------------------------------------------------------------------

/**
 * Check whether Claude Code credentials exist in the macOS Keychain.
 * Returns true iff `security find-generic-password` exits 0.
 */
export function keychainHasCredentials(): boolean {
  try {
    execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" 2>/dev/null`, {
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read Claude Code credentials from the macOS Keychain.
 * Returns the credential JSON string, or null if the entry is missing.
 */
export function readKeychainCredentials(): string | null {
  try {
    const result = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`, {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Write a credentials JSON string to the macOS Keychain.
 * Removes any existing entry first so the write is idempotent.
 * Throws a descriptive Error on failure.
 */
export function writeKeychainCredentials(credentials: string): void {
  try {
    // Remove old entry if it exists (best-effort).
    try {
      execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE], {
        stdio: 'pipe',
      });
    } catch {
      // No existing entry, that's fine.
    }

    const username = process.env.USER ?? 'unknown';
    execFileSync(
      'security',
      ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', username, '-w', credentials],
      { stdio: 'pipe' }
    );
  } catch (err) {
    throw new Error(
      `Failed to write credentials to Keychain: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ---------------------------------------------------------------------------
// claude setup-token OAuth flow
// ---------------------------------------------------------------------------

export interface RunSetupTokenOptions {
  /** When true, run `claude auth logout` first to force a fresh OAuth flow. */
  forceLogout: boolean;
  onStatus: SyncStatusCallback;
  onLog: (line: string) => void;
}

/**
 * Run `claude setup-token` to create a long-lived OAuth token (1 year).
 * Parses the token from stdout and writes it to the macOS Keychain.
 */
export function runClaudeSetupToken(opts: RunSetupTokenOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const claudePath = getClaudePath();
    const env = getAugmentedEnv();

    if (opts.forceLogout) {
      try {
        opts.onLog('MOCK: Running claude auth logout first');
        execFileSync(claudePath, ['auth', 'logout'], { stdio: 'pipe', env });
      } catch {
        // Ignore logout errors.
      }
    }

    opts.onStatus('Opening browser for authentication...');
    opts.onLog(`Running: ${claudePath} setup-token`);

    const proc = spawn(claudePath, ['setup-token'], { env, stdio: 'pipe' });

    let stdout = '';
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.stdout.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      const line = chunk.trim();
      if (line !== '') opts.onLog(`setup-token: ${line}`);
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Authentication timed out after 5 minutes. Please try again.'));
    }, CLAUDE_SETUP_TOKEN_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude setup-token failed (exit ${code}): ${stderr.slice(0, 200)}`));
        return;
      }

      const tokenMatch = stdout.match(/(sk-ant-oat[A-Za-z0-9_-]+)/);
      if (!tokenMatch) {
        reject(new Error('Could not parse token from claude setup-token output'));
        return;
      }

      const accessToken = tokenMatch[1];
      opts.onLog(`Parsed long-lived token (${accessToken.length} chars)`);

      const credentials = JSON.stringify({
        claudeAiOauth: {
          accessToken,
          expiresAt: Date.now() + LONG_LIVED_TOKEN_TTL_MS,
        },
      });

      try {
        writeKeychainCredentials(credentials);
        opts.onLog('Long-lived token written to Keychain');
        resolve();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
