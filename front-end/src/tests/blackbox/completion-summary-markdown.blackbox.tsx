/**
 * Blackbox: Task Complete markdown FilePointers render as document previews.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';
import type { FilePointer } from '@/lib/api';

const createAttachmentSignedUrlMock = vi.fn();
const downloadAttachmentAsTextMock = vi.fn();

vi.mock('@/features/terminal-component-group/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/terminal-component-group/hooks')>();
  return {
    ...actual,
    createAttachmentSignedUrl: (...args: unknown[]) => createAttachmentSignedUrlMock(...args),
    downloadAttachmentAsText: (...args: unknown[]) => downloadAttachmentAsTextMock(...args),
  };
});

vi.mock('@/features/terminal-component-group/components/MarkdownText', () => ({
  MarkdownText: ({ text }: { text: string }) => <div data-testid="markdown-text">{text}</div>,
}));

import { CompletionSummaryCard } from '@/features/terminal-component-group/components/CompletionSummaryCard';

const POSITIONING: FilePointer = {
  id: 'file-md-1',
  storage_path: 'attachments/positioning-statement.md',
  original_filename: 'positioning-statement.md',
  mime_type: 'text/markdown',
  size_bytes: 2048,
  created_at: '2026-09-03T00:00:00Z',
};

const CALENDAR: FilePointer = {
  id: 'file-md-err',
  storage_path: 'attachments/90-day-content-calendar.md',
  original_filename: '90-day-content-calendar.md',
  mime_type: 'text/markdown',
  size_bytes: 4096,
  created_at: '2026-09-03T00:00:00Z',
};

describe('CompletionSummaryCard markdown report', () => {
  beforeEach(() => {
    createAttachmentSignedUrlMock.mockReset();
    downloadAttachmentAsTextMock.mockReset();
    createAttachmentSignedUrlMock.mockResolvedValue('https://signed.example/report.md');
  });

  it('renders markdown FilePointer outputs as a pretty document preview', async () => {
    downloadAttachmentAsTextMock.mockResolvedValue(
      '# Positioning\n\nOwn the creator niche with a weekly hook-tested calendar.',
    );

    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Assembled the creator report.',
          outputs: [
            { key: 'positioning_statement', label: 'Positioning Statement', value: POSITIONING },
          ],
        }}
      />,
    );

    expect(screen.getByText('Positioning Statement')).toBeInTheDocument();
    expect(screen.getByText('positioning-statement.md')).toBeInTheDocument();
    expect(screen.getByLabelText('Download positioning-statement.md')).toBeInTheDocument();
    expect(screen.queryByTitle('Copy to clipboard')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('markdown-text')).toHaveTextContent(
        'Own the creator niche with a weekly hook-tested calendar.',
      );
    });
    expect(createAttachmentSignedUrlMock).toHaveBeenCalledWith(
      'attachments/positioning-statement.md',
    );
    expect(downloadAttachmentAsTextMock).toHaveBeenCalledWith('https://signed.example/report.md');
  });

  it('keeps markdown report download when the preview body fails to load', async () => {
    downloadAttachmentAsTextMock.mockRejectedValue(new Error('blob missing'));

    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Assembled the creator report.',
          outputs: [
            {
              key: 'ninety_day_content_calendar',
              label: 'Ninety Day Content Calendar',
              value: CALENDAR,
            },
          ],
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('blob missing')).toBeInTheDocument();
    });
    expect(screen.getByText('90-day-content-calendar.md')).toBeInTheDocument();
    expect(screen.getByLabelText('Download 90-day-content-calendar.md')).toBeInTheDocument();
  });
});
