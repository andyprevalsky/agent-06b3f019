import type { IPC } from '../shared/types/ipc';

declare module '*.png' {
  const value: string;
  export default value;
}

declare global {
  interface Window {
    api: IPC;
  }
}

export {};


