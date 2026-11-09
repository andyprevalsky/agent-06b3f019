/**
 * A long trajectory renders one InlineMediaGallery per media-bearing message.
 * Each closed gallery used to build its own preview Sheet (Radix Dialog root,
 * portal, presence and preview hooks) on every navigation even though a closed
 * sheet renders nothing. The sheet now mounts on the gallery's first tap and
 * then stays mounted, so its open/close behavior (including the close
 * animation) is unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const drawer = vi.hoisted(() => ({ mounts: 0 }));

vi.mock('@/features/terminal-component-group/components/DocumentPreviewDrawer', async () => {
  const { useEffect } = await import('react');
  return {
    DocumentPreviewDrawer: (props: { open: boolean; file: { id: string } | null }) => {
      useEffect(() => {
        drawer.mounts += 1;
      }, []);
      return props.open ? <div data-testid="preview-sheet" data-file={props.file?.id} /> : null;
    },
  };
});

vi.mock('@/features/terminal-component-group/components/inline-media/useInlineMediaUrls', () => ({
  useInlineMediaUrls: (files: Array<{ id: string }>) =>
    Object.fromEntries(files.map((file) => [file.id, `https://media.test/${file.id}.png`])),
}));

import { InlineMediaGallery } from '@/features/terminal-component-group/components/inline-media/InlineMediaGallery';

const image = (id: string) => ({
  id,
  storage_path: `media/${id}.png`,
  original_filename: `${id}.png`,
  mime_type: 'image/png',
  size_bytes: 1024,
  created_at: '2026-11-06T00:00:00Z',
});

describe('InlineMediaGallery preview sheet mounting', () => {
  afterEach(() => {
    drawer.mounts = 0;
  });

  it('builds no preview sheet for closed galleries; a gallery builds its sheet on first tap and keeps it', () => {
    render(
      <>
        <InlineMediaGallery files={[image('a1'), image('a2')]} />
        <InlineMediaGallery files={[image('b1')]} />
        <InlineMediaGallery files={[image('c1')]} />
      </>,
    );
    expect(screen.getAllByTestId('inline-media-item')).toHaveLength(4);
    expect(drawer.mounts).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Open b1.png' }));
    expect(drawer.mounts).toBe(1);
    expect(screen.getByTestId('preview-sheet').dataset.file).toBe('b1');

    // Re-opening in the same gallery reuses its sheet; other galleries stay unbuilt.
    fireEvent.click(screen.getByRole('button', { name: 'Open b1.png' }));
    expect(drawer.mounts).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Open a2.png' }));
    expect(drawer.mounts).toBe(2);
    expect(
      screen
        .getAllByTestId('preview-sheet')
        .map((el) => el.dataset.file)
        .sort(),
    ).toEqual(['a2', 'b1']);
  });
});
