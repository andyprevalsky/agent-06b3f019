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
import { sync as syncUserDataSources } from '../../main/domains/user-data-sync/service';
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
    vi.mocked(repo.uploadDocuments).mockResolvedValue({ ok: true, documentCount: 1 });
    vi.mocked(repo.exportAppleNotes).mockResolvedValue([]);
    vi.mocked(repo.pathExists).mockResolvedValue(true);
    vi.mocked(repo.readMarkdownFiles).mockResolvedValue([]);
    vi.mocked(repo.readExportTextFiles).mockResolvedValue([]);
    vi.mocked(repo.watchDirectory).mockReturnValue({ close: vi.fn(), on: vi.fn() });
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
          {
            conversation_id: 'conv-2',
            title: '   ',
            messages: [{ role: 'assistant', content: { parts: ['Default title branch.'] } }],
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
        {
          externalId: 'conv-2',
          title: 'ChatGPT conversation',
          metadata: { provider: 'chatgpt', exportFormat: 'conversation_json' },
        },
      ],
    });
    expect(vi.mocked(repo.uploadDocuments).mock.calls[0][0].documents[0].content).toContain(
      'Nimbus launch preference'
    );
  });

  it('parses Claude exports and falls back to file documents for invalid JSON', async () => {
    process.env.ROSE_CLAUDE_EXPORT_DIR = '~/Claude';
    vi.mocked(repo.readExportTextFiles).mockResolvedValue([
      {
        absolutePath: '/Users/test/Claude/conversations.json',
        relativePath: 'conversations.json',
        content: JSON.stringify({
          uuid: 'claude-1',
          name: 'Architecture notes',
          updated_at: '2026-07-03T11:00:00Z',
          chat_messages: [
            { sender: 'human', content: [{ text: 'Use stable token affinity.' }] },
            { role: 'assistant', content: { parts: ['Pin leases by lineage.'] } },
          ],
        }),
        mtimeMs: Date.parse('2026-07-03T11:00:00Z'),
      },
      {
        absolutePath: '/Users/test/Claude/raw.txt',
        relativePath: 'raw.txt',
        content: 'Plain export note',
        mtimeMs: Date.parse('2026-07-03T12:00:00Z'),
      },
    ]);

    await UserDataSync.syncSource('claude');

    expect(repo.pathExists).toHaveBeenCalledWith(expect.stringContaining('/Claude'));
    expect(repo.uploadDocuments).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repo.uploadDocuments).mock.calls[0][0]).toMatchObject({
      source: 'claude',
      documents: [
        {
          externalId: 'claude-1',
          title: 'Architecture notes',
          sourceUpdatedAt: '2026-07-03T11:00:00Z',
          metadata: { provider: 'claude', exportFormat: 'conversation_json' },
        },
        {
          title: 'raw',
          content: 'Plain export note',
          metadata: { source: 'claude', path: 'raw.txt', root: 'Claude' },
        },
      ],
    });
  });

  it('normalizes Apple Notes HTML and skips empty notes', async () => {
    vi.mocked(repo.uploadDocuments).mockResolvedValue({ ok: true, documentCount: 2 });
    vi.mocked(repo.exportAppleNotes).mockResolvedValue([
      {
        body: '<p>Important&nbsp;&amp;&nbsp;urgent</p><br>Follow up',
        creationDate: '2026-07-01T10:00:00Z',
        folder: 'Work',
        account: 'iCloud',
      },
      {
        id: 'note-2',
        name: 'Release checklist',
        body: '&lt;done&gt;',
        creationDate: '2026-07-02T10:00:00Z',
        modificationDate: '2026-07-03T10:00:00Z',
      },
      {
        id: 'empty-note',
        name: 'Empty',
        body: '',
      },
    ]);

    const result = await UserDataSync.syncSource('apple_notes');

    expect(result[0]).toMatchObject({ source: 'apple_notes', discovered: 2, uploaded: 2 });
    expect(vi.mocked(repo.uploadDocuments).mock.calls[0][0]).toMatchObject({
      source: 'apple_notes',
      documents: [
        {
          title: 'Important & urgent',
          content: 'Important & urgent\n\nFollow up',
          sourceUpdatedAt: '2026-07-01T10:00:00Z',
          metadata: { folder: 'Work', account: 'iCloud', createdAt: '2026-07-01T10:00:00Z' },
        },
        {
          externalId: 'note-2',
          title: 'Release checklist',
          content: '<done>',
          sourceUpdatedAt: '2026-07-03T10:00:00Z',
        },
      ],
    });
  });

  it('reports upload and collection errors without marking the source skipped', async () => {
    process.env.ROSE_OBSIDIAN_VAULTS = '/Users/test/MainVault,/Users/test/MissingVault';
    vi.mocked(repo.pathExists).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(repo.readMarkdownFiles).mockResolvedValue([
      {
        absolutePath: '/Users/test/MainVault/Plan.md',
        relativePath: 'Plan.md',
        content: 'Launch plan',
        mtimeMs: Date.parse('2026-07-03T10:00:00Z'),
      },
    ]);
    vi.mocked(repo.uploadDocuments).mockResolvedValueOnce({
      ok: false,
      documentCount: 0,
      statusText: 'bad gateway',
    });

    const uploadFailure = await UserDataSync.syncSource('obsidian');

    expect(uploadFailure[0]).toMatchObject({
      source: 'obsidian',
      discovered: 1,
      uploaded: 0,
      skipped: false,
      error: 'bad gateway',
    });

    vi.mocked(repo.exportAppleNotes).mockRejectedValueOnce(new Error('Notes unavailable'));
    const collectionFailure = await UserDataSync.syncSource('apple_notes');

    expect(collectionFailure[0]).toMatchObject({
      source: 'apple_notes',
      discovered: 0,
      uploaded: 0,
      skipped: false,
      error: 'Notes unavailable',
    });
  });

  it('falls back for primitive JSON exports and skips non-forced sources until due', async () => {
    process.env.ROSE_CHATGPT_EXPORT_DIR = '~';
    vi.mocked(repo.readExportTextFiles).mockResolvedValue([
      {
        absolutePath: '/Users/test/conversations.json',
        relativePath: 'conversations.json',
        content: JSON.stringify('plain primitive export'),
        mtimeMs: Date.parse('2026-07-03T14:00:00Z'),
      },
    ]);

    const first = await UserDataSync.syncSource('chatgpt');
    const second = await UserDataSync.sync(new Set(['chatgpt']));

    expect(first[0]).toMatchObject({ source: 'chatgpt', discovered: 1, uploaded: 1 });
    expect(second[0]).toMatchObject({
      source: 'chatgpt',
      discovered: 0,
      uploaded: 0,
      skipped: true,
    });
    expect(repo.pathExists).toHaveBeenCalledWith(expect.not.stringContaining('~'));
    expect(vi.mocked(repo.uploadDocuments).mock.calls[0][0].documents[0]).toMatchObject({
      externalId: expect.stringContaining('conversations.json'),
      title: 'conversations',
      content: JSON.stringify('plain primitive export'),
    });
  });

  it('syncs all connected sources and reports empty sources without uploading', async () => {
    vi.mocked(repo.pathExists).mockResolvedValue(false);
    vi.mocked(repo.exportAppleNotes).mockResolvedValue([]);

    const result = await syncUserDataSources(undefined, true);

    expect(result.map((summary) => summary.source)).toEqual([
      'chatgpt',
      'claude',
      'apple_notes',
      'obsidian',
    ]);
    expect(result.every((summary) => summary.discovered === 0 && !summary.skipped)).toBe(true);
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

  it('debounces realtime watcher changes and force-syncs the changed source', async () => {
    vi.useFakeTimers();
    process.env.ROSE_OBSIDIAN_VAULTS = '/Users/test/MainVault';
    let onChange: (() => void) | null = null;
    const watcher = { close: vi.fn(), on: vi.fn() };
    vi.mocked(repo.watchDirectory).mockImplementation((_target, changeHandler) => {
      onChange = changeHandler;
      return watcher as unknown as ReturnType<typeof repo.watchDirectory>;
    });
    vi.mocked(repo.readMarkdownFiles).mockResolvedValue([
      {
        absolutePath: '/Users/test/MainVault/Realtime.md',
        relativePath: 'Realtime.md',
        content: 'Updated live',
        mtimeMs: Date.parse('2026-07-03T13:00:00Z'),
      },
    ]);

    await UserDataSync.startRealTimeSync(new Set(['obsidian']));
    expect(onChange).not.toBeNull();
    onChange?.();
    onChange?.();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(repo.uploadDocuments).toHaveBeenCalledTimes(1);
    UserDataSync.stopRealTimeSync();
    expect(watcher.close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('registers each realtime watcher once and ignores null watcher handles', async () => {
    process.env.ROSE_OBSIDIAN_VAULTS = '/Users/test/MainVault';
    process.env.ROSE_CHATGPT_EXPORT_DIR = '/Users/test/ChatGPT';
    process.env.ROSE_CLAUDE_EXPORT_DIR = '/Users/test/Claude';
    const watcher = { close: vi.fn(), on: vi.fn() };
    vi.mocked(repo.watchDirectory)
      .mockReturnValueOnce(watcher as unknown as ReturnType<typeof repo.watchDirectory>)
      .mockReturnValueOnce(null)
      .mockReturnValue(watcher as unknown as ReturnType<typeof repo.watchDirectory>);

    await UserDataSync.startRealTimeSync();
    await UserDataSync.startRealTimeSync();

    expect(repo.watchDirectory).toHaveBeenCalledTimes(5);
    UserDataSync.stopRealTimeSync();
    expect(watcher.close).toHaveBeenCalledTimes(4);
  });
});
