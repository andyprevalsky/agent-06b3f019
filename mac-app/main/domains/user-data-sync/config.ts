export const DOCUMENTS_UPLOAD_ENDPOINT = '/api/integrations/documents/upload';

export const MAX_DOCUMENTS_PER_UPLOAD = 500;
export const MAX_DOCUMENT_CONTENT_CHARS = 250_000;

export const USER_DATA_SYNC_LOG_PREFIX = '[UserDataSync]';

export const OBSIDIAN_VAULTS_ENV = 'ROSE_OBSIDIAN_VAULTS';
export const CHATGPT_EXPORT_DIR_ENV = 'ROSE_CHATGPT_EXPORT_DIR';
export const CLAUDE_EXPORT_DIR_ENV = 'ROSE_CLAUDE_EXPORT_DIR';

export const APPLE_NOTES_GROUP_CONTAINER = 'Library/Group Containers/group.com.apple.notes';

export const SOURCE_RECONCILE_INTERVAL_MS = {
  chatgpt: 6 * 60 * 60 * 1000,
  claude: 6 * 60 * 60 * 1000,
  apple_notes: 15 * 60 * 1000,
  obsidian: 60 * 60 * 1000,
} as const;

export const SOURCE_WATCH_DEBOUNCE_MS = {
  chatgpt: 30 * 1000,
  claude: 30 * 1000,
  apple_notes: 60 * 1000,
  obsidian: 2 * 1000,
} as const;
