import { createHash } from 'node:crypto';
import { type FSWatcher } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { getErrorMessage } from '../../../shared/utils/error';
import { AuthService } from '../../services/auth';
import { sessionForLocalMachineData } from '../auth/impersonation';
import {
  APPLE_NOTES_GROUP_CONTAINER,
  CHATGPT_EXPORT_DIR_ENV,
  CLAUDE_EXPORT_DIR_ENV,
  MAX_DOCUMENT_CONTENT_CHARS,
  MAX_DOCUMENTS_PER_UPLOAD,
  OBSIDIAN_VAULTS_ENV,
  SOURCE_RECONCILE_INTERVAL_MS,
  SOURCE_WATCH_DEBOUNCE_MS,
  USER_DATA_SYNC_LOG_PREFIX,
} from './config';
import * as repo from './repo';
import type {
  AppleNotesRawNote,
  LocalTextFile,
  SourceSyncSummary,
  UserDataDocument,
  UserDataSource,
} from './types';

const SOURCES: UserDataSource[] = ['chatgpt', 'claude', 'apple_notes', 'obsidian'];
const lastSyncAt = new Map<UserDataSource, number>();
const watchers = new Map<string, FSWatcher>();
const debounceTimers = new Map<UserDataSource, NodeJS.Timeout>();

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function truncateContent(content: string): string {
  return content.length > MAX_DOCUMENT_CONTENT_CHARS
    ? content.slice(0, MAX_DOCUMENT_CONTENT_CHARS)
    : content;
}

function expandPath(rawPath: string): string {
  if (rawPath === '~') return homedir();
  if (rawPath.startsWith('~/')) return path.join(homedir(), rawPath.slice(2));
  return rawPath;
}

function envPathList(envName: string): string[] {
  return (process.env[envName] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map(expandPath);
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function sourceIsConnected(source: UserDataSource, connected?: Set<string>): boolean {
  return connected === undefined || connected.has(source);
}

function dueForSource(source: UserDataSource, force: boolean): boolean {
  if (force) return true;
  const previous = lastSyncAt.get(source);
  if (previous === undefined) return true;
  return Date.now() - previous >= SOURCE_RECONCILE_INTERVAL_MS[source];
}

function noteToDocument(note: AppleNotesRawNote): UserDataDocument | null {
  const content = stripHtml(note.body ?? '');
  if (content.length === 0) return null;
  const title = note.name?.trim() || content.split('\n')[0]?.slice(0, 80) || 'Apple Note';
  const stableId = note.id?.trim() || sha256(`${title}\n${content}`);
  return {
    externalId: stableId,
    title,
    content: truncateContent(content),
    sourceUpdatedAt: note.modificationDate ?? note.creationDate,
    metadata: {
      folder: note.folder,
      account: note.account,
      createdAt: note.creationDate,
    },
  };
}

function obsidianFileToDocument(vaultRoot: string, file: LocalTextFile): UserDataDocument {
  const vault = path.basename(vaultRoot);
  const title = path.basename(file.relativePath, path.extname(file.relativePath));
  return {
    externalId: `${vault}:${file.relativePath}`,
    title,
    content: truncateContent(file.content),
    sourceUpdatedAt: new Date(file.mtimeMs).toISOString(),
    metadata: {
      vault,
      path: file.relativePath,
    },
  };
}

function fileDocument(source: UserDataSource, root: string, file: LocalTextFile): UserDataDocument {
  return {
    externalId: `${path.basename(root)}:${file.relativePath}`,
    title: path.basename(file.relativePath, path.extname(file.relativePath)),
    content: truncateContent(file.content),
    sourceUpdatedAt: new Date(file.mtimeMs).toISOString(),
    metadata: {
      source,
      path: file.relativePath,
      root: path.basename(root),
    },
  };
}

function textFromConversationMessages(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromConversationMessages(item))
      .filter(Boolean)
      .join('\n\n');
  }
  if (value === null || typeof value !== 'object') return typeof value === 'string' ? value : '';
  const record = value as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role : undefined;
  const content = record.content;
  if (typeof content === 'string') return role ? `${role}: ${content}` : content;
  if (Array.isArray(content)) return textFromConversationMessages(content);
  if (content !== null && typeof content === 'object') {
    const parts = (content as Record<string, unknown>).parts;
    return textFromConversationMessages(parts);
  }
  const message = record.message;
  if (message !== undefined) return textFromConversationMessages(message);
  return '';
}

function chatgptConversationDocument(item: Record<string, unknown>): UserDataDocument | null {
  const title =
    typeof item.title === 'string' && item.title.trim()
      ? item.title.trim()
      : 'ChatGPT conversation';
  const id =
    (typeof item.id === 'string' && item.id) ||
    (typeof item.conversation_id === 'string' && item.conversation_id) ||
    sha256(JSON.stringify(item));
  const content = textFromConversationMessages(item.mapping ?? item.messages ?? item);
  if (!content.trim()) return null;
  const updated =
    typeof item.update_time === 'number'
      ? new Date(item.update_time * 1000).toISOString()
      : undefined;
  return {
    externalId: id,
    title,
    content: truncateContent(content),
    sourceUpdatedAt: updated,
    metadata: { provider: 'chatgpt', exportFormat: 'conversation_json' },
  };
}

function claudeConversationDocument(item: Record<string, unknown>): UserDataDocument | null {
  const title =
    (typeof item.name === 'string' && item.name.trim()) ||
    (typeof item.title === 'string' && item.title.trim()) ||
    'Claude conversation';
  const id =
    (typeof item.uuid === 'string' && item.uuid) ||
    (typeof item.id === 'string' && item.id) ||
    sha256(JSON.stringify(item));
  const content = textFromConversationMessages(item.chat_messages ?? item.messages ?? item);
  if (!content.trim()) return null;
  const updated =
    (typeof item.updated_at === 'string' && item.updated_at) ||
    (typeof item.created_at === 'string' && item.created_at) ||
    undefined;
  return {
    externalId: id,
    title,
    content: truncateContent(content),
    sourceUpdatedAt: updated,
    metadata: { provider: 'claude', exportFormat: 'conversation_json' },
  };
}

function documentsFromJsonFile(
  source: UserDataSource,
  root: string,
  file: LocalTextFile
): UserDataDocument[] {
  try {
    const parsed = JSON.parse(file.content) as unknown;
    const records = Array.isArray(parsed) ? parsed : [parsed];
    const docs = records
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item)
      )
      .map((item) =>
        source === 'chatgpt' ? chatgptConversationDocument(item) : claudeConversationDocument(item)
      )
      .filter((doc): doc is UserDataDocument => doc !== null);
    return docs.length > 0 ? docs : [fileDocument(source, root, file)];
  } catch {
    return [fileDocument(source, root, file)];
  }
}

async function collectAppleNotes(): Promise<UserDataDocument[]> {
  const notes = await repo.exportAppleNotes();
  return notes.map(noteToDocument).filter((doc): doc is UserDataDocument => doc !== null);
}

async function collectObsidian(): Promise<UserDataDocument[]> {
  const roots = envPathList(OBSIDIAN_VAULTS_ENV);
  const docs: UserDataDocument[] = [];
  for (const root of roots) {
    if (!(await repo.pathExists(root))) continue;
    const files = await repo.readMarkdownFiles(root);
    docs.push(...files.map((file) => obsidianFileToDocument(root, file)));
  }
  return docs;
}

async function collectExportSource(
  source: Extract<UserDataSource, 'chatgpt' | 'claude'>
): Promise<UserDataDocument[]> {
  const envName = source === 'chatgpt' ? CHATGPT_EXPORT_DIR_ENV : CLAUDE_EXPORT_DIR_ENV;
  const roots = envPathList(envName);
  const docs: UserDataDocument[] = [];
  for (const root of roots) {
    if (!(await repo.pathExists(root))) continue;
    const files = await repo.readExportTextFiles(root);
    for (const file of files) {
      docs.push(
        ...(file.relativePath.endsWith('.json')
          ? documentsFromJsonFile(source, root, file)
          : [fileDocument(source, root, file)])
      );
    }
  }
  return docs;
}

async function collectDocuments(source: UserDataSource): Promise<UserDataDocument[]> {
  if (source === 'apple_notes') return collectAppleNotes();
  if (source === 'obsidian') return collectObsidian();
  return collectExportSource(source);
}

async function uploadSource(source: UserDataSource, force: boolean): Promise<SourceSyncSummary> {
  if (!dueForSource(source, force)) {
    return { source, discovered: 0, uploaded: 0, skipped: true };
  }
  const session = sessionForLocalMachineData(await AuthService.getSession());
  if (session === null) return { source, discovered: 0, uploaded: 0, skipped: true };

  try {
    const documents = (await collectDocuments(source)).slice(0, MAX_DOCUMENTS_PER_UPLOAD);
    if (documents.length === 0) {
      lastSyncAt.set(source, Date.now());
      return { source, discovered: 0, uploaded: 0, skipped: false };
    }
    const result = await repo.uploadDocuments({ source, documents }, session.access_token);
    if (!result.ok) {
      return {
        source,
        discovered: documents.length,
        uploaded: 0,
        skipped: false,
        error: result.statusText ?? 'upload failed',
      };
    }
    lastSyncAt.set(source, Date.now());
    return { source, discovered: documents.length, uploaded: result.documentCount, skipped: false };
  } catch (error) {
    return { source, discovered: 0, uploaded: 0, skipped: false, error: getErrorMessage(error) };
  }
}

export async function sync(connected?: Set<string>, force = false): Promise<SourceSyncSummary[]> {
  const selected = SOURCES.filter((source) => sourceIsConnected(source, connected));
  const summaries = await Promise.all(selected.map((source) => uploadSource(source, force)));
  for (const summary of summaries) {
    if (summary.error !== undefined) {
      console.error(`${USER_DATA_SYNC_LOG_PREFIX} ${summary.source} sync failed: ${summary.error}`);
    } else if (!summary.skipped) {
      console.log(
        `${USER_DATA_SYNC_LOG_PREFIX} ${summary.source} synced ${summary.uploaded}/${summary.discovered} documents`
      );
    }
  }
  return summaries;
}

function scheduleSourceSync(source: UserDataSource): void {
  const existing = debounceTimers.get(source);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(source);
    void uploadSource(source, true);
  }, SOURCE_WATCH_DEBOUNCE_MS[source]);
  debounceTimers.set(source, timer);
}

async function watchIfExists(
  key: string,
  source: UserDataSource,
  targetPath: string
): Promise<void> {
  if (watchers.has(key) || !(await repo.pathExists(targetPath))) return;
  const watcher = repo.watchDirectory(
    targetPath,
    () => scheduleSourceSync(source),
    (error) => console.error(`${USER_DATA_SYNC_LOG_PREFIX} watcher error for ${source}`, error)
  );
  if (watcher !== null) watchers.set(key, watcher);
}

export async function startRealTimeSync(connected?: Set<string>): Promise<void> {
  if (sourceIsConnected('apple_notes', connected)) {
    await watchIfExists(
      'apple_notes',
      'apple_notes',
      path.join(homedir(), APPLE_NOTES_GROUP_CONTAINER)
    );
  }
  if (sourceIsConnected('obsidian', connected)) {
    await Promise.all(
      envPathList(OBSIDIAN_VAULTS_ENV).map((vault) =>
        watchIfExists(`obsidian:${vault}`, 'obsidian', vault)
      )
    );
  }
  if (sourceIsConnected('chatgpt', connected)) {
    await Promise.all(
      envPathList(CHATGPT_EXPORT_DIR_ENV).map((root) =>
        watchIfExists(`chatgpt:${root}`, 'chatgpt', root)
      )
    );
  }
  if (sourceIsConnected('claude', connected)) {
    await Promise.all(
      envPathList(CLAUDE_EXPORT_DIR_ENV).map((root) =>
        watchIfExists(`claude:${root}`, 'claude', root)
      )
    );
  }
}

export function stopRealTimeSync(): void {
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  for (const watcher of watchers.values()) watcher.close();
  watchers.clear();
}
