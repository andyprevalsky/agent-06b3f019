import type { IPC } from '../../shared/types/ipc';

export const getElectronApi = (): IPC | undefined => {
  return (window as Window & { api?: IPC }).api;
};
