/**
 * rose-cli — runtime layer (Electron wiring)
 *
 *   app ready ─► ensureInstalled() ─► ~/.rose/bin/rose (0755, atomic rename)
 *                  ELECTRON_RUN_AS_NODE=1 exec '<app execPath>' '<resources>/rose-cli/bin/rose.mjs' "$@"
 *                  rewritten on every start, so it follows a moved or translocated app
 *   IPC: roseCli:ensureInstalled   → { success, path?, error? } (the web UI shows the path)
 *        roseCli:pickProjectFolder → native folder picker → { canceled, path? }
 *        roseCli:importProject     → ImportRunManager (serviceImport.ts) → { runId } | { error }
 *        roseCli:cancelImport      → SIGTERM, then SIGKILL after a grace period
 *   event: roseCli:importEvent (every window) — one per CLI stdout object, then exit
 *
 * Never edits the user's shell rc files or PATH.
 */
import { randomUUID } from 'crypto';
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type WebContents,
} from 'electron';
import { logConsole, logConsoleError, logIpc } from '../../base/logger';
import { getAugmentedEnv } from '../../base/shellEnv';
import { getErrorMessage } from '../../../shared/utils/error';
import {
  CANCEL_IMPORT_CHANNEL,
  ENSURE_INSTALLED_CHANNEL,
  IMPORT_EVENT_CHANNEL,
  IMPORT_PROJECT_CHANNEL,
  LOG_TAG,
  PICK_FOLDER_BUTTON,
  PICK_FOLDER_CHANNEL,
  PICK_FOLDER_TITLE,
} from './config';
import { isDirectory, launcherIo, spawnImport } from './repo';
import { cliEntryPath, ensureLauncher, launcherPathFor } from './service';
import { ImportRunManager, folderPickResult } from './serviceImport';
import type {
  LauncherTarget,
  RoseCliFolderPickResult,
  RoseCliImportEvent,
  RoseCliInstallResult,
} from './types';

let started = false;

function currentTarget(): LauncherTarget {
  return {
    launcherPath: launcherPathFor(app.getPath('home')),
    execPath: process.execPath,
    cliEntry: cliEntryPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      moduleDir: __dirname,
    }),
  };
}

export async function ensureInstalled(): Promise<RoseCliInstallResult> {
  let target: LauncherTarget;
  try {
    target = currentTarget();
  } catch (error) {
    return { success: false, error: `Could not locate the rose CLI: ${getErrorMessage(error)}` };
  }
  return await ensureLauncher(target, launcherIo);
}

function broadcastImportEvent(event: RoseCliImportEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IMPORT_EVENT_CHANNEL, event);
  }
}

const importRuns = new ImportRunManager({
  isDirectory,
  ensureLauncher: ensureInstalled,
  env: getAugmentedEnv,
  home: () => app.getPath('home'),
  spawn: spawnImport,
  emit: broadcastImportEvent,
  newRunId: randomUUID,
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
});

async function pickProjectFolder(sender: WebContents): Promise<RoseCliFolderPickResult> {
  const options: OpenDialogOptions = {
    title: PICK_FOLDER_TITLE,
    buttonLabel: PICK_FOLDER_BUTTON,
    properties: ['openDirectory'],
  };
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.fromWebContents(sender);
  try {
    const picked =
      window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
    return folderPickResult(picked);
  } catch (error) {
    logConsoleError(LOG_TAG, 'Folder picker failed', error);
    return { canceled: true };
  }
}

function registerHandlers(): void {
  ipcMain.handle(ENSURE_INSTALLED_CHANNEL, async () => {
    logIpc('IN', ENSURE_INSTALLED_CHANNEL);
    return await ensureInstalled();
  });
  ipcMain.handle(PICK_FOLDER_CHANNEL, async (event) => {
    logIpc('IN', PICK_FOLDER_CHANNEL);
    return await pickProjectFolder(event.sender);
  });
  ipcMain.handle(IMPORT_PROJECT_CHANNEL, async (_event, request: unknown) => {
    logIpc('IN', IMPORT_PROJECT_CHANNEL);
    return await importRuns.start(request);
  });
  ipcMain.handle(CANCEL_IMPORT_CHANNEL, (_event, runId: unknown) => {
    logIpc('IN', CANCEL_IMPORT_CHANNEL);
    importRuns.cancel(runId);
  });
}

export function startRoseCli(): void {
  if (started) return;
  started = true;
  registerHandlers();
  app.on('before-quit', () => importRuns.cancelAll());
  void ensureInstalled().then((result) => {
    if (result.success) logConsole(LOG_TAG, `rose CLI launcher ready at ${result.path ?? ''}`);
    else logConsoleError(LOG_TAG, result.error ?? 'rose CLI launcher install failed');
  });
}
