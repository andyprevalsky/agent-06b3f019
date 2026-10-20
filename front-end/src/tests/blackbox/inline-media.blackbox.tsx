/**
 * Blackbox tests for rose-user-ui "Images and media inline by default"
 * (UI ledger #13, desktop web + mobile web/PWA):
 *  - an image attachment renders as an inline <img> without any click, on
 *    desktop and at a 390px mobile viewport (no click-to-reveal chip)
 *  - layout is reserved from metadata (no layout shift) and images lazy-load
 *  - several media files form a horizontal gallery strip; videos play inline,
 *    muted, with a poster frame (preload=metadata)
 *  - tap/click opens the existing DocumentPreviewDrawer
 *  - tool results / structured outputs use the same inline path; non-media
 *    files keep their chips
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import type { FilePointer } from '@/lib/api';
import { AttachmentDisplay } from '@/features/terminal-component-group/components/message-bubble/AttachmentDisplay';
import { StructuredResponseDisplay } from '@/features/terminal-component-group/components/StructuredResponseDisplay';
import { FilePointerDisplay } from '@/features/terminal-component-group/components/FilePointerDisplay';
import { documentPreviewKind } from '@/features/terminal-component-group/components/documentPreview.utils';

const API_BASE = 'http://localhost:3001/api';
const createSignedUrl = vi.fn(async (path: string) => ({
  data: { signedUrl: `https://signed.example/${path}` },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { storage: { from: () => ({ createSignedUrl }) } },
  getSession: () => ({ access_token: 'test-token' }),
}));

const downloadBlobMock = vi.fn(async () => new Blob(['img'], { type: 'image/png' }));

vi.mock('@/features/terminal-component-group/api', async () => {
  const actual = await vi.importActual<typeof import('@/features/terminal-component-group/api')>(
    '@/features/terminal-component-group/api',
  );
  return { ...actual, downloadAttachmentAsBlob: () => downloadBlobMock() };
});

function file(
  name: string,
  mime: string,
  extra: Partial<FilePointer> = {},
): FilePointer {
  return {
    id: `fp-${name}`,
    storage_path: `user/${name}`,
    original_filename: name,
    mime_type: mime,
    size_bytes: 2048,
    created_at: '2026-10-20T00:00:00Z',
    ...extra,
  };
}

function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

beforeEach(() => {
  mockSession();
  createSignedUrl.mockClear();
  downloadBlobMock.mockClear();
  server.use(
    http.get(`${API_BASE}/agents/:agentId/attachments/:fileId/url`, ({ params }) =>
      HttpResponse.json({ signed_url: `https://backend-signed.example/${String(params.fileId)}` }),
    ),
  );
});

afterEach(() => {
  setViewport(1024);
  localStorage.clear();
});

describe('inline media by default', () => {
  it.each([
    ['desktop', 1280],
    ['390px mobile', 390],
  ])('renders an image attachment as an inline <img> without a click on %s', async (_l, width) => {
    setViewport(width);
    renderWithProviders(
      <AttachmentDisplay attachments={[file('shot.png', 'image/png')]} agentId="agent-1" />,
    );
    const img = await screen.findByRole('img', { name: 'shot.png' });
    expect(img).toHaveAttribute('src', 'https://backend-signed.example/fp-shot.png');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveClass('w-full', 'object-contain');
    const strip = screen.getByTestId('inline-media');
    expect(strip).toHaveAttribute('data-layout', 'single');
    expect(strip).toHaveClass('w-full');
    expect(screen.getByTestId('inline-media-item')).toHaveClass('w-full');
    expect(screen.queryByTestId('file-pointer-chip')).not.toBeInTheDocument();
    // Agent attachments are signed by the backend, never client-side.
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it('reserves the box from metadata width/height before the image loads', () => {
    renderWithProviders(
      <AttachmentDisplay
        attachments={[file('wide.png', 'image/png', { width: 800, height: 600 })]}
        agentId="agent-1"
      />,
    );
    const item = screen.getByTestId('inline-media-item');
    expect(item.style.aspectRatio).toBe(String(800 / 600));
    expect(within(item).getByTestId('inline-media-pending')).toBeInTheDocument();
  });

  it('falls back to a 16:9 reservation, then adopts the intrinsic aspect on load', async () => {
    renderWithProviders(
      <AttachmentDisplay attachments={[file('tall.png', 'image/png')]} agentId="agent-1" />,
    );
    const item = screen.getByTestId('inline-media-item');
    expect(item.style.aspectRatio).toBe(String(16 / 9));
    const img = await screen.findByRole('img', { name: 'tall.png' });
    Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 300 });
    Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 600 });
    img.dispatchEvent(new Event('load'));
    await waitFor(() => expect(item.style.aspectRatio).toBe('0.5'));
  });

  it('lays several media files out as a horizontal gallery strip', async () => {
    renderWithProviders(
      <AttachmentDisplay
        attachments={[
          file('a.png', 'image/png'),
          file('b.jpg', 'image/jpeg'),
          file('demo.mp4', 'video/mp4'),
          file('notes.txt', 'text/plain'),
        ]}
        agentId="agent-1"
      />,
    );
    const strip = screen.getByTestId('inline-media');
    expect(strip).toHaveAttribute('data-layout', 'gallery');
    expect(strip).toHaveClass('flex', 'overflow-x-auto', 'snap-x');
    const items = within(strip).getAllByTestId('inline-media-item');
    expect(items.map((i) => i.getAttribute('data-filename'))).toEqual([
      'a.png',
      'b.jpg',
      'demo.mp4',
    ]);
    items.forEach((i) => expect(i).toHaveClass('shrink-0', 'snap-start'));
    const video = await within(strip).findByTestId('inline-media-video');
    expect(video).toHaveAttribute('src', 'https://backend-signed.example/fp-demo.mp4');
    expect((video as HTMLVideoElement).muted).toBe(true);
    expect(video).toHaveAttribute('playsinline');
    expect(video).toHaveAttribute('preload', 'metadata');
    // Non-media files stay as download tiles outside the strip.
    expect(within(strip).queryByText('notes.txt')).not.toBeInTheDocument();
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
  });

  it('opens the existing DocumentPreviewDrawer when an inline image is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AttachmentDisplay attachments={[file('shot.png', 'image/png')]} agentId="agent-1" />,
    );
    await screen.findByRole('img', { name: 'shot.png' });
    await user.click(screen.getByRole('button', { name: 'Open shot.png' }));
    const drawer = await screen.findByTestId('document-preview-drawer');
    expect(await within(drawer).findByTestId('document-preview-image')).toBeInTheDocument();
    // The drawer reuses the already-resolved backend URL instead of re-signing.
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(downloadBlobMock).toHaveBeenCalledTimes(1);
  });

  it('plays videos inline and opens them in the drawer from the bare expand icon', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AttachmentDisplay attachments={[file('clip.webm', 'video/webm')]} agentId="agent-1" />,
    );
    await screen.findByTestId('inline-media-video');
    const expand = screen.getByRole('button', { name: 'Open clip.webm' });
    expect(expand.className).not.toMatch(/\b(bg-|border|rounded)/);
    await user.click(expand);
    const drawer = await screen.findByTestId('document-preview-drawer');
    const video = await within(drawer).findByTestId('document-preview-video');
    expect(video).toHaveAttribute('src', 'https://backend-signed.example/fp-clip.webm');
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it('classifies video files as previewable video', () => {
    expect(documentPreviewKind(file('x.mov', 'application/octet-stream'))).toBe('video');
    expect(documentPreviewKind(file('x.bin', 'video/mp4'))).toBe('video');
  });
});

describe('inline media in tool results and file outputs', () => {
  it('renders an output image inline instead of a chip', async () => {
    renderWithProviders(<FilePointerDisplay file={file('chart.png', 'image/png')} />);
    const img = await screen.findByRole('img', { name: 'chart.png' });
    expect(img).toHaveAttribute('src', 'https://signed.example/user/chart.png');
    expect(screen.queryByTestId('file-pointer-chip')).not.toBeInTheDocument();
  });

  it('groups list[file_pointer] media into one gallery and keeps chips for documents', async () => {
    renderWithProviders(
      <StructuredResponseDisplay
        structuredResponse={{
          screenshots: [
            file('one.png', 'image/png'),
            file('report.pdf', 'application/pdf'),
            file('two.png', 'image/png'),
          ],
        }}
        outputSchema={{
          fields: [{ name: 'screenshots', type: 'list[file_pointer]', description: '' }],
        }}
      />,
    );
    const strips = screen.getAllByTestId('inline-media');
    expect(strips).toHaveLength(1);
    expect(strips[0]).toHaveAttribute('data-layout', 'gallery');
    expect(await within(strips[0]).findAllByRole('img')).toHaveLength(2);
    const chips = screen.getAllByTestId('file-pointer-chip');
    expect(chips.map((c) => c.getAttribute('data-filename'))).toEqual(['report.pdf']);
  });
});
