/**
 * Repo layer for gpt-credential-sync.
 *
 * Owns filesystem access to Codex's local auth file.
 */

import fs from 'fs';
import { CODEX_AUTH_PATH } from './config';

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
