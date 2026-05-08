import { app } from 'electron';
import path from 'path';

export function getPackagedRendererPath(fileName: 'index.html' | 'launcher.html'): string {
  return path.join(app.getAppPath(), 'dist', 'ui', fileName);
}

export function getPackagedIconBasePath(): string {
  return path.join(app.getAppPath(), 'assets', 'icons');
}
