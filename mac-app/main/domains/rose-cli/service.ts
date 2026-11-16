/**
 * rose-cli — service layer (pure logic; filesystem injected as LauncherIo)
 *
 *   ensureLauncher ─► CLI entry present? ─no─► { success: false, error }
 *                    └► launcher text/mode current? ─no─► atomic write (0755)
 *                    └► { success: true, path: ~/.rose/bin/rose }
 *
 * The launcher runs the app's own binary as Node on the bundled CLI, so it
 * needs no npm, no global install and no PATH or shell rc edits.
 */
import path from 'path';
import { getErrorMessage } from '../../../shared/utils/error';
import {
  CLI_ENTRY_RELATIVE,
  COMPILED_DIR_TO_REPO_ROOT,
  DEV_CLI_DIR,
  LAUNCHER_MODE,
  LAUNCHER_RELATIVE,
  PACKAGED_CLI_DIR,
} from './config';
import type { LauncherIo, LauncherTarget, RoseCliInstallResult } from './types';

/** POSIX single-quoted shell word: safe for spaces, quotes, `$`, newlines. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function launcherPathFor(home: string): string {
  return path.join(home, LAUNCHER_RELATIVE);
}

/** The bundled CLI entry: Resources/rose-cli when packaged, the repo checkout in dev. */
export function cliEntryPath(params: {
  isPackaged: boolean;
  resourcesPath: string;
  /** Directory of the compiled rose-cli module (dist/main/main/domains/rose-cli). */
  moduleDir: string;
}): string {
  return params.isPackaged
    ? path.join(params.resourcesPath, PACKAGED_CLI_DIR, CLI_ENTRY_RELATIVE)
    : path.resolve(params.moduleDir, COMPILED_DIR_TO_REPO_ROOT, DEV_CLI_DIR, CLI_ENTRY_RELATIVE);
}

/** The `rose` launcher: the app's binary as Node on the bundled CLI, argv passed through. */
export function buildLauncherScript(target: { execPath: string; cliEntry: string }): string {
  const moved = `rose: the Rose app is no longer at ${target.execPath}. Open Rose once to repair this launcher.`;
  return [
    '#!/bin/sh',
    '# rose CLI launcher. The Rose Mac app rewrites this file on every start so it',
    '# always runs the CLI bundled with the installed app, wherever the app lives.',
    `if [ ! -x ${shellSingleQuote(target.execPath)} ]; then`,
    `  printf '%s\\n' ${shellSingleQuote(moved)} >&2`,
    '  exit 127',
    'fi',
    `ELECTRON_RUN_AS_NODE=1 exec ${shellSingleQuote(target.execPath)} ${shellSingleQuote(target.cliEntry)} "$@"`,
    '',
  ].join('\n');
}

/** Write the launcher when it is missing, stale or not 0755; never throws. */
export async function ensureLauncher(
  target: LauncherTarget,
  io: LauncherIo
): Promise<RoseCliInstallResult> {
  try {
    if (!(await io.exists(target.cliEntry))) {
      return {
        success: false,
        error: `This Rose app build is missing its rose CLI (${target.cliEntry}). Reinstall Rose from roselabs.ai.`,
      };
    }
    const content = buildLauncherScript(target);
    const current = await io.readLauncher(target.launcherPath);
    if (current === null || current.content !== content || current.mode !== LAUNCHER_MODE) {
      await io.writeLauncher(target.launcherPath, content);
    }
    return { success: true, path: target.launcherPath };
  } catch (error) {
    return {
      success: false,
      error: `Could not install the rose CLI at ${target.launcherPath}: ${getErrorMessage(error)}`,
    };
  }
}
