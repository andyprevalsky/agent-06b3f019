export type UserDataSource = 'chatgpt' | 'claude' | 'apple_notes' | 'obsidian';

export interface UserDataDocument {
  externalId: string;
  title: string;
  content: string;
  url?: string;
  sourceUpdatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentsUploadPayload {
  source: UserDataSource;
  documents: UserDataDocument[];
}

export interface DocumentsUploadResult {
  ok: boolean;
  statusText?: string;
  documentCount: number;
}

export interface AppleNotesRawNote {
  id?: string;
  name?: string;
  body?: string;
  creationDate?: string;
  modificationDate?: string;
  folder?: string;
  account?: string;
}

export interface LocalTextFile {
  absolutePath: string;
  relativePath: string;
  content: string;
  mtimeMs: number;
}

export interface SourceSyncSummary {
  source: UserDataSource;
  discovered: number;
  uploaded: number;
  skipped: boolean;
  error?: string;
}
