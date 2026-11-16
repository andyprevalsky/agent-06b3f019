/**
 * Blackbox tests for rose-user-ui "Images and media inline by default"
 * (UI ledger #13, desktop web + mobile web/PWA). Rose Desktop flag only
 * (lib/roseDesktop.ts); the stock UI keeps thumbnails, the lightbox and chips:
 *  - an image attachment renders as an inline <img> without any click, on
 *    desktop and at a 390px mobile viewport (no click-to-reveal chip)
 *  - layout is reserved from metadata (no layout shift) and images lazy-load
 *  - several media files form a horizontal gallery strip; videos play inline,
 *    muted, with a poster frame (preload=metadata)
 *  - tap/click opens the existing DocumentPreviewDrawer
 *  - tool results / structured outputs / completion summaries use the same
 *    inline path; non-media files keep their chips
 *  - flag off: stock thumbnail + ImageLightbox, chips, videos download-only
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
import { CompletionSummaryCard } from '@/features/terminal-component-group/components/CompletionSummaryCard';
import { DocumentPreviewDrawer } from '@/features/terminal-component-group/components/DocumentPreviewDrawer';
import {
  documentPreviewKind,
  documentTypeLabel,
} from '@/features/terminal-component-group/components/documentPreview.utils';
import { signedUrlOptions } from '@/features/terminal-component-group/components/documentPreview.load';

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

function file(name: string, mime: string, extra: Partial<FilePointer> = {}): FilePointer {
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

  it('classifies video files as previewable video only when opted in', () => {
    const mov = file('x.mov', 'application/octet-stream');
    const mp4 = file('x.bin', 'video/mp4');
    expect(documentPreviewKind(mov, { video: true })).toBe('video');
    expect(documentPreviewKind(mp4, { video: true })).toBe('video');
    expect(documentTypeLabel(mp4, { video: true })).toBe('Video');
    // Stock classification is unchanged: videos stay download-only.
    expect(documentPreviewKind(mov)).toBe('download');
    expect(documentPreviewKind(mp4)).toBe('download');
    expect(documentTypeLabel(mp4)).not.toBe('Video');
    // Images and documents classify the same either way.
    expect(documentPreviewKind(file('a.png', 'image/png'), { video: true })).toBe('image');
    expect(documentPreviewKind(file('a.pdf', 'application/pdf'), { video: true })).toBe('pdf');
  });

  it('marks a failed signature as unavailable and still opens the drawer on tap', async () => {
    server.use(
      http.get(`${API_BASE}/agents/:agentId/attachments/:fileId/url`, () =>
        HttpResponse.json({ error: 'nope' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <AttachmentDisplay attachments={[file('gone.png', 'image/png')]} agentId="agent-1" />,
    );
    const unavailable = await screen.findByTestId('inline-media-unavailable');
    expect(unavailable).toHaveTextContent('gone.png');
    await user.click(unavailable);
    expect(await screen.findByTestId('document-preview-drawer')).toBeInTheDocument();
  });
});

describe('SVG display (owner decision 2026-11-08)', () => {
  // An SVG may carry <script> or onload. It is only ever an <img> (browsers never run
  // scripts in an image) and its markup is never inlined into the app DOM.
  const scripted =
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';

  it('renders an SVG as an inline <img>, never as inline markup, inline and in the drawer', async () => {
    const user = userEvent.setup();
    downloadBlobMock.mockResolvedValueOnce(new Blob([scripted], { type: 'image/svg+xml' }));
    const { container } = renderWithProviders(
      <AttachmentDisplay attachments={[file('chart.svg', 'image/svg+xml')]} agentId="agent-1" />,
    );
    const img = await screen.findByRole('img', { name: 'chart.svg' });
    expect(img.tagName).toBe('IMG');
    expect(container.querySelector('svg script, script, foreignObject')).toBeNull();
    expect(container.innerHTML).not.toContain('alert(');
    await user.click(screen.getByRole('button', { name: 'Open chart.svg' }));
    const drawer = await screen.findByTestId('document-preview-drawer');
    const preview = await within(drawer).findByTestId('document-preview-image');
    expect(preview.querySelector('img')).not.toBeNull();
    expect(document.body.innerHTML).not.toContain('alert(');
    expect(document.querySelector('iframe[data-testid="document-preview-html"]')).toBeNull();
  });

  it('signs an SVG URL as a download, so opening it never renders it as a page', async () => {
    renderWithProviders(<AttachmentDisplay attachments={[file('chart.svg', 'image/svg+xml')]} />);
    await screen.findByRole('img', { name: 'chart.svg' });
    expect(createSignedUrl).toHaveBeenCalledWith('user/chart.svg', expect.any(Number), {
      download: true,
    });
    expect(signedUrlOptions('user/shot.png')).toBeUndefined();
    expect(signedUrlOptions('user/CHART.SVG')).toEqual({ download: true });
  });
});

describe('inline media in tool results and file outputs', () => {
  it('renders completion-summary image outputs inline, documents keep the mini preview', async () => {
    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          outputs: [
            {
              key: 'shots',
              label: 'Screenshots',
              value: [file('home.png', 'image/png'), file('about.png', 'image/png')],
            },
          ],
        }}
      />,
    );
    const strip = await screen.findByTestId('inline-media');
    expect(strip).toHaveAttribute('data-layout', 'gallery');
    expect(await within(strip).findAllByRole('img')).toHaveLength(2);
    expect(screen.queryByTestId('file-pointer-chip')).not.toBeInTheDocument();
  });

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
          fields: [
            { name: 'screenshots', type: 'list[file_pointer]', description: '', required: true },
          ],
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

// ─── Flag off: the stock UI is unchanged ─────────────────────────────────────

describe('stock UI (Rose Desktop flag off)', () => {
  it('keeps the 240px thumbnail and the full-screen lightbox for image attachments', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AttachmentDisplay attachments={[file('shot.png', 'image/png')]} agentId="agent-1" />,
      { roseDesktop: false },
    );
    const img = await screen.findByRole('img', { name: 'shot.png' });
    expect(img).toHaveClass('w-60', 'h-60', 'object-cover');
    expect(screen.queryByTestId('inline-media')).not.toBeInTheDocument();
    await user.click(img);
    // ImageLightbox portals a second, full-size copy with close + download.
    await waitFor(() => expect(screen.getAllByRole('img', { name: 'shot.png' })).toHaveLength(2));
    expect(screen.queryByTestId('document-preview-drawer')).not.toBeInTheDocument();
  });

  it('keeps videos as download tiles in messages', () => {
    renderWithProviders(
      <AttachmentDisplay attachments={[file('clip.mp4', 'video/mp4')]} agentId="agent-1" />,
      { roseDesktop: false },
    );
    expect(screen.getByText('clip.mp4')).toBeInTheDocument();
    expect(screen.queryByTestId('inline-media')).not.toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
  });

  it('keeps output images and lists as chips', () => {
    renderWithProviders(
      <StructuredResponseDisplay
        structuredResponse={{
          screenshots: [file('one.png', 'image/png'), file('report.pdf', 'application/pdf')],
        }}
        outputSchema={{
          fields: [
            { name: 'screenshots', type: 'list[file_pointer]', description: '', required: true },
          ],
        }}
      />,
      { roseDesktop: false },
    );
    expect(screen.queryByTestId('inline-media')).not.toBeInTheDocument();
    const chips = screen.getAllByTestId('file-pointer-chip');
    expect(chips.map((c) => c.getAttribute('data-filename'))).toEqual(['one.png', 'report.pdf']);
  });

  it('keeps a single output image as a chip', () => {
    renderWithProviders(<FilePointerDisplay file={file('chart.png', 'image/png')} />, {
      roseDesktop: false,
    });
    expect(screen.getByTestId('file-pointer-chip')).toHaveAttribute('data-filename', 'chart.png');
    expect(screen.queryByTestId('inline-media')).not.toBeInTheDocument();
  });

  it('keeps videos download-only in the preview drawer', async () => {
    renderWithProviders(
      <DocumentPreviewDrawer file={file('clip.mp4', 'video/mp4')} open onOpenChange={vi.fn()} />,
      { roseDesktop: false },
    );
    const drawer = await screen.findByTestId('document-preview-drawer');
    await waitFor(() =>
      expect(within(drawer).queryByTestId('document-preview-loading')).not.toBeInTheDocument(),
    );
    expect(within(drawer).queryByTestId('document-preview-video')).not.toBeInTheDocument();
    expect(within(drawer).getByTestId('document-preview-download')).toBeInTheDocument();
  });
});
