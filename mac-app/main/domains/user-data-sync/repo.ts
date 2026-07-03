import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../../base/config';
import {
  DOCUMENTS_UPLOAD_ENDPOINT,
  MAX_DOCUMENTS_PER_UPLOAD,
  USER_DATA_SYNC_LOG_PREFIX,
} from './config';
import type {
  AppleNotesRawNote,
  DocumentsUploadPayload,
  DocumentsUploadResult,
  LocalTextFile,
} from './types';

const execFileAsync = promisify(execFile);

const APPLE_NOTES_JXA = `
const Notes = Application('Notes');
Notes.includeStandardAdditions = true;
const out = [];
for (const account of Notes.accounts()) {
  for (const folder of account.folders()) {
    for (const note of folder.notes()) {
      out.push({
        id: String(note.id()),
        name: String(note.name()),
        body: String(note.body()),
        creationDate: note.creationDate() ? note.creationDate().toISOString() : null,
        modificationDate: note.modificationDate() ? note.modificationDate().toISOString() : null,
        folder: String(folder.name()),
        account: String(account.name())
      });
    }
  }
}
JSON.stringify(out);
`;

export async function uploadDocuments(
  payload: DocumentsUploadPayload,
  accessToken: string
): Promise<DocumentsUploadResult> {
  const response = await fetch(`${config.apiUrl}${DOCUMENTS_UPLOAD_ENDPOINT}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    return { ok: false, statusText: response.statusText, documentCount: 0 };
  }

  const data = (await response.json()) as { documentCount?: number };
  return { ok: true, documentCount: data.documentCount ?? payload.documents.length };
}

export async function exportAppleNotes(): Promise<AppleNotesRawNote[]> {
  const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', APPLE_NOTES_JXA], {
    maxBuffer: 50 * 1024 * 1024,
    timeout: 60_000,
  });
  const parsed = JSON.parse(stdout) as unknown;
  return Array.isArray(parsed) ? (parsed as AppleNotesRawNote[]) : [];
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root: string, allowedExtensions: Set<string>): Promise<LocalTextFile[]> {
  const out: LocalTextFile[] = [];

  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.obsidian') continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(ext)) continue;
      const [content, stat] = await Promise.all([
        fs.readFile(absolutePath, 'utf8'),
        fs.stat(absolutePath),
      ]);
      out.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath).split(path.sep).join('/'),
        content,
        mtimeMs: stat.mtimeMs,
      });
      if (out.length >= MAX_DOCUMENTS_PER_UPLOAD) return;
    }
  }

  await visit(root);
  return out;
}

export function readMarkdownFiles(root: string): Promise<LocalTextFile[]> {
  return walkFiles(root, new Set(['.md', '.markdown']));
}

export function readExportTextFiles(root: string): Promise<LocalTextFile[]> {
  return walkFiles(root, new Set(['.json', '.md', '.markdown', '.txt']));
}

export function watchDirectory(
  targetPath: string,
  onChange: () => void,
  onError: (error: Error) => void
): FSWatcher | null {
  try {
    const watcher = watch(targetPath, { recursive: true }, () => onChange());
    watcher.on('error', onError);
    return watcher;
  } catch (error) {
    console.error(`${USER_DATA_SYNC_LOG_PREFIX} Failed to watch ${targetPath}`, error);
    return null;
  }
}
