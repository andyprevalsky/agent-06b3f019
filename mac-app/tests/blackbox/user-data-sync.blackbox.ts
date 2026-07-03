import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubAllElectron } from './electron-stubs';

stubAllElectron();

vi.mock('../../main/base/config', () => ({
  config: {
    apiUrl: 'https://backend.test',
    supabase: { url: 'https://supabase.test', anonKey: 'anon-test' },
    encryptionKey: 'test-key',
    isDev: true,
  },
}));

vi.mock('../../main/services/auth', () => ({
  AuthService: {
    getSession: vi.fn(),
  },
}));

vi.mock('../../main/domains/user-data-sync/repo', () => ({
  uploadDocuments: vi.fn(async () => ({ ok: true, documentCount: 1 })),
  exportAppleNotes: vi.fn(async () => []),
  pathExists: vi.fn(async () => true),
  readMarkdownFiles: vi.fn(async () => []),
  readExportTextFiles: vi.fn(async () => []),
  watchDirectory: vi.fn(() => ({ close: vi.fn(), on: vi.fn() })),
}));

import { AuthService } from '../../main/services/auth';
import { UserDataSync } from '../../main/domains/user-data-sync/runtime';
import * as repo from '../../main/domains/user-data-sync/repo';

const SESSION = {
  access_token: 'token-1',
  refresh_token: 'refresh-1',
  expires_at: Date.now() + 60_000,
  user: { id: 'user-1' },
} as unknown as Awaited<ReturnType<typeof AuthService.getSession>>;

describe('user-data-sync blackbox', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
  });

  afterEach(() => {
    UserDataSync.stopRealTimeSync();
    process.env = { ...originalEnv };
  });

  it('normalizes Obsidian markdown files and uploads them to documents endpoint', async () => {
    process.env.ROSE_OBSIDIAN_VAULTS = '/Users/test/MainVault';
    vi.mocked(repo.readMarkdownFiles).mockResolvedValue([
      {
        absolutePath: '/Users/test/MainVault/Projects/Calypso.md',
        relativePath: 'Projects/Calypso.md',
        content: '# Calypso\nVendor follow-ups live here.',
        mtimeMs: Date.parse('2026-07-03T10:00:00Z'),
      },
    ]);

    const result = await UserDataSync.syncSource('obsidian');

    expect(result[0]).toMatchObject({ source: 'obsidian', discovered: 1, uploaded: 1 });
    expect(repo.uploadDocuments).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repo.uploadDocuments).mock.calls[0][0]).toMatchObject({
      source: 'obsidian',
      documents: [
        {
          externalId: 'MainVault:Projects/Calypso.md',
          title: 'Calypso',
          metadata: { vault: 'MainVault', path: 'Projects/Calypso.md' },
        },
      ],
    });
  });

  it('parses ChatGPT conversation JSON exports into conversation documents', async () => {
    process.env.ROSE_CHATGPT_EXPORT_DIR = '/Users/test/ChatGPT';
    vi.mocked(repo.readExportTextFiles).mockResolvedValue([
      {
        absolutePath: '/Users/test/ChatGPT/conversations.json',
        relativePath: 'conversations.json',
        content: JSON.stringify([
          {
            id: 'conv-1',
            title: 'Launch plan',
            update_time: 1783060503,
            messages: [{ role: 'user', content: 'Remember the Nimbus launch preference.' }],
          },
        ]),
        mtimeMs: Date.parse('2026-07-03T10:00:00Z'),
      },
    ]);

    await UserDataSync.syncSource('chatgpt');

    expect(repo.uploadDocuments).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repo.uploadDocuments).mock.calls[0][0]).toMatchObject({
      source: 'chatgpt',
      documents: [
        {
          externalId: 'conv-1',
          title: 'Launch plan',
          metadata: { provider: 'chatgpt', exportFormat: 'conversation_json' },
        },
      ],
    });
    expect(vi.mocked(repo.uploadDocuments).mock.calls[0][0].documents[0].content).toContain(
      'Nimbus launch preference'
    );
  });

  it('skips uploads when there is no authenticated session', async () => {
    vi.mocked(AuthService.getSession).mockResolvedValue(null);

    const result = await UserDataSync.syncSource('apple_notes');

    expect(result[0]).toMatchObject({ source: 'apple_notes', skipped: true });
    expect(repo.uploadDocuments).not.toHaveBeenCalled();
  });

  it('registers realtime watchers only for connected configured sources', async () => {
    process.env.ROSE_OBSIDIAN_VAULTS = '/Users/test/MainVault';
    process.env.ROSE_CHATGPT_EXPORT_DIR = '/Users/test/ChatGPT';

    await UserDataSync.startRealTimeSync(new Set(['obsidian']));

    expect(repo.watchDirectory).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repo.watchDirectory).mock.calls[0][0]).toBe('/Users/test/MainVault');
  });
});
