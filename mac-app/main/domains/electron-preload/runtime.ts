/**
 * Runtime layer for the electron-preload domain.
 *
 * This module runs inside Electron's preload context (per `webPreferences.
 * preload` in `main/index.ts`). Importing it is a side effect: it constructs
 * the IPC bridge via `buildIpcApi(ipcRenderer)` and installs it on the
 * renderer's `window` under `BRIDGE_KEY` via `contextBridge.exposeInMainWorld`.
 *
 * The thin `main/preload.ts` entry that Electron loads by filesystem path
 * simply imports this module for its side effect.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_KEY } from './config';
import { buildIpcApi } from './service';

contextBridge.exposeInMainWorld(BRIDGE_KEY, buildIpcApi(ipcRenderer));
