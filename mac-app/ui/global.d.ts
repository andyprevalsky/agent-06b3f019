import type { IPC } from '../shared/types/ipc';

declare global {
  interface Window {
    api: IPC;
  }
}

export {};


