/**
 * Blackbox tests: CompletionSummaryCard document outputs open a RIGHT drawer
 * and render file contents (HTML srcDoc, spreadsheet tables, text, etc.).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { renderWithProviders } from './test-wrapper';
import type { FilePointer } from '@/lib/api';
import { CompletionSummaryCard } from '@/features/terminal-component-group/components/CompletionSummaryCard';
import {
  documentPreviewKind,
  documentTypeLabel,
} from '@/features/terminal-component-group/components/documentPreview.utils';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/file' } }),
      }),
    },
  },
  getSession: () => null,
}));

vi.mock('@/features/terminal-component-group/components/MarkdownText', () => ({
  MarkdownText: ({ text }: { text: string }) => <div data-testid="markdown-text">{text}</div>,
}));

const downloadBlobMock = vi.fn();
const downloadTextMock = vi.fn();

vi.mock('@/features/terminal-component-group/api', async () => {
  const actual = await vi.importActual<typeof import('@/features/terminal-component-group/api')>(
    '@/features/terminal-component-group/api',
  );
  return {
    ...actual,
    downloadAttachmentAsBlob: (...args: unknown[]) => downloadBlobMock(...args),
    downloadAttachmentAsText: (...args: unknown[]) => downloadTextMock(...args),
  };
});

function makeFile(
  overrides: Partial<FilePointer> & Pick<FilePointer, 'original_filename' | 'mime_type'>,
): FilePointer {
  return {
    id: overrides.id ?? `fp-${overrides.original_filename}`,
    storage_path: overrides.storage_path ?? `user/${overrides.original_filename}`,
    original_filename: overrides.original_filename,
    mime_type: overrides.mime_type,
    size_bytes: overrides.size_bytes ?? 1024,
    created_at: overrides.created_at ?? '2026-09-03T00:00:00Z',
  };
}

function buildXlsxBlob(): Blob {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Item', 'Amount'],
    ['Cloud', '42'],
    ['Agents', '99'],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Budget');
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

async function buildNumbersBlob(): Promise<Blob> {
  const zip = new JSZip();
  zip.file('tables/forecast.csv', 'Month,Revenue\nJan,10\nFeb,20\n');
  const bytes = await zip.generateAsync({ type: 'arraybuffer' });
  return new Blob([bytes], { type: 'application/vnd.apple.numbers' });
}

const HTML_BODY =
  '<!doctype html><html><body><h1>Rose Labs Report</h1><p>Rendered body</p></body></html>';

describe('documentPreview.utils kinds', () => {
  it('classifies each output file family', () => {
    expect(
      documentPreviewKind(makeFile({ original_filename: 'a.html', mime_type: 'text/html' })),
    ).toBe('html');
    expect(
      documentPreviewKind(
        makeFile({
          original_filename: 'a.xlsx',
          mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      ),
    ).toBe('spreadsheet');
    expect(
      documentPreviewKind(
        makeFile({ original_filename: 'a.numbers', mime_type: 'application/vnd.apple.numbers' }),
      ),
    ).toBe('numbers');
    expect(
      documentPreviewKind(makeFile({ original_filename: 'a.pdf', mime_type: 'application/pdf' })),
    ).toBe('pdf');
    expect(
      documentPreviewKind(makeFile({ original_filename: 'a.csv', mime_type: 'text/csv' })),
    ).toBe('csv');
    expect(
      documentTypeLabel(
        makeFile({ original_filename: 'a.xlsx', mime_type: 'application/octet-stream' }),
      ),
    ).toBe('Excel');
  });
});

describe('CompletionSummaryCard right drawer content', () => {
  beforeEach(() => {
    downloadBlobMock.mockReset();
    downloadTextMock.mockReset();
    downloadTextMock.mockImplementation(async () => HTML_BODY);
    downloadBlobMock.mockImplementation(async () => buildXlsxBlob());
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens RIGHT drawer and renders HTML contents via srcDoc', async () => {
    const user = userEvent.setup();
    const file = makeFile({ original_filename: 'report.html', mime_type: 'text/html' });
    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          outputs: [{ key: 'doc', label: 'Document', value: file }],
        }}
      />,
    );

    await user.click(screen.getByTestId('file-pointer-chip'));
    const drawer = await screen.findByTestId('document-preview-drawer');
    expect(drawer.className).toMatch(/right-0|slide-in-from-right/);

    const iframe = await screen.findByTestId('document-preview-html');
    expect(iframe.tagName).toBe('IFRAME');
    expect(iframe).toHaveAttribute('srcdoc', expect.stringContaining('Rose Labs Report'));
    expect(downloadTextMock).toHaveBeenCalled();
  });

  it('renders Excel cell contents in a table', async () => {
    const user = userEvent.setup();
    const file = makeFile({
      original_filename: 'budget.xlsx',
      mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    downloadBlobMock.mockResolvedValue(buildXlsxBlob());

    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          outputs: [{ key: 'sheet', label: 'Sheet', value: file }],
        }}
      />,
    );

    await user.click(screen.getByTestId('file-pointer-chip'));
    await waitFor(() => {
      expect(screen.getByTestId('document-preview-spreadsheet')).toBeInTheDocument();
    });
    expect(screen.getByText('Cloud')).toBeInTheDocument();
    expect(screen.getByText('99')).toBeInTheDocument();
  });

  it('renders Numbers package CSV contents in a table', async () => {
    const user = userEvent.setup();
    const file = makeFile({
      original_filename: 'forecast.numbers',
      mime_type: 'application/vnd.apple.numbers',
    });
    downloadBlobMock.mockResolvedValue(await buildNumbersBlob());

    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          outputs: [{ key: 'sheet', label: 'Sheet', value: file }],
        }}
      />,
    );

    await user.click(screen.getByTestId('file-pointer-chip'));
    await waitFor(() => {
      expect(screen.getByTestId('document-preview-spreadsheet')).toBeInTheDocument();
    });
    expect(screen.getByText('Revenue')).toBeInTheDocument();
    expect(screen.getByText('Feb')).toBeInTheDocument();
  });

  it('renders CSV contents in a table', async () => {
    const user = userEvent.setup();
    const file = makeFile({ original_filename: 'rows.csv', mime_type: 'text/csv' });
    downloadTextMock.mockResolvedValue('Name,Score\nAda,10\n');

    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          outputs: [{ key: 'csv', label: 'CSV', value: file }],
        }}
      />,
    );

    await user.click(screen.getByTestId('file-pointer-chip'));
    await waitFor(() => {
      expect(screen.getByTestId('document-preview-spreadsheet')).toBeInTheDocument();
    });
    expect(screen.getByText('Ada')).toBeInTheDocument();
  });
});
