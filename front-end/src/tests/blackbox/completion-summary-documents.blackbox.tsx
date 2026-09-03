/**
 * Blackbox tests: CompletionSummaryCard document outputs open a RIGHT drawer
 * and render file contents (HTML srcDoc, spreadsheet tables, text, etc.).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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

async function buildDocxBlob(): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Rose Labs Word Brief</w:t></w:r></w:p>
    <w:p><w:r><w:t>Docx contents visible in the right drawer.</w:t></w:r></w:p>
  </w:body>
</w:document>`,
  );
  const bytes = await zip.generateAsync({ type: 'arraybuffer' });
  return new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

async function buildPptxBlob(): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    'ppt/slides/slide1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>Rose Labs Deck</a:t></a:r></a:p>
    <a:p><a:r><a:t>Slide text in the right drawer.</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`,
  );
  const bytes = await zip.generateAsync({ type: 'arraybuffer' });
  return new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
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
      documentPreviewKind(
        makeFile({
          original_filename: 'a.docx',
          mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      ),
    ).toBe('docx');
    expect(
      documentPreviewKind(
        makeFile({
          original_filename: 'a.pptx',
          mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        }),
      ),
    ).toBe('pptx');
    expect(
      documentTypeLabel(
        makeFile({ original_filename: 'a.xlsx', mime_type: 'application/octet-stream' }),
      ),
    ).toBe('Excel');
    expect(
      documentTypeLabel(
        makeFile({
          original_filename: 'a.docx',
          mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      ),
    ).toBe('Word');
    expect(
      documentTypeLabel(
        makeFile({
          original_filename: 'a.pptx',
          mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        }),
      ),
    ).toBe('PowerPoint');
  });
});

describe('CompletionSummaryCard inline mini-previews + right drawer', () => {
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

  it('shows an HTML mini-preview in the summary without opening the drawer', async () => {
    const file = makeFile({ original_filename: 'report.html', mime_type: 'text/html' });
    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          outputs: [{ key: 'doc', label: 'Document', value: file }],
        }}
      />,
    );

    const mini = await screen.findByTestId('file-pointer-mini-preview');
    expect(mini).toHaveAttribute('data-preview-kind', 'html');
    expect(screen.getByTestId('file-pointer-mini-html')).toBeInTheDocument();
    expect(screen.queryByTestId('document-preview-drawer')).not.toBeInTheDocument();
  });

  it('shows spreadsheet mini-preview cells in the summary', async () => {
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

    await screen.findByTestId('file-pointer-mini-spreadsheet');
    expect(screen.getByText('Cloud')).toBeInTheDocument();
    expect(screen.getByText('99')).toBeInTheDocument();
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

    await screen.findByTestId('file-pointer-mini-html');
    await user.click(screen.getByTestId('file-pointer-chip'));
    const drawer = await screen.findByTestId('document-preview-drawer');
    expect(drawer.className).toMatch(/right-0|slide-in-from-right/);

    const iframe = await within(drawer).findByTestId('document-preview-html');
    expect(iframe.tagName).toBe('IFRAME');
    expect(iframe).toHaveAttribute('srcdoc', expect.stringContaining('Rose Labs Report'));
    expect(downloadTextMock).toHaveBeenCalled();
  });

  it('renders Excel cell contents in the drawer table', async () => {
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

    await screen.findByTestId('file-pointer-mini-spreadsheet');
    await user.click(screen.getByTestId('file-pointer-chip'));
    const drawer = await screen.findByTestId('document-preview-drawer');
    await within(drawer).findByTestId('document-preview-spreadsheet');
    expect(within(drawer).getByText('Cloud')).toBeInTheDocument();
    expect(within(drawer).getByText('99')).toBeInTheDocument();
  });

  it('renders Numbers package CSV contents in the drawer table', async () => {
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

    await screen.findByTestId('file-pointer-mini-spreadsheet');
    await user.click(screen.getByTestId('file-pointer-chip'));
    const drawer = await screen.findByTestId('document-preview-drawer');
    await within(drawer).findByTestId('document-preview-spreadsheet');
    expect(within(drawer).getByText('Revenue')).toBeInTheDocument();
    expect(within(drawer).getByText('Feb')).toBeInTheDocument();
  });

  it('renders CSV contents in the drawer table', async () => {
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

    await screen.findByTestId('file-pointer-mini-spreadsheet');
    await user.click(screen.getByTestId('file-pointer-chip'));
    const drawer = await screen.findByTestId('document-preview-drawer');
    await within(drawer).findByTestId('document-preview-spreadsheet');
    expect(within(drawer).getByText('Ada')).toBeInTheDocument();
  });

  it('renders Word docx text contents in mini + drawer', async () => {
    const user = userEvent.setup();
    const file = makeFile({
      original_filename: 'brief.docx',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    downloadBlobMock.mockResolvedValue(await buildDocxBlob());

    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          outputs: [{ key: 'doc', label: 'Brief', value: file }],
        }}
      />,
    );

    await screen.findByTestId('file-pointer-mini-text');
    expect(screen.getByTestId('file-pointer-mini-text')).toHaveTextContent(/Rose Labs Word Brief/);
    await user.click(screen.getByTestId('file-pointer-chip'));
    const drawer = await screen.findByTestId('document-preview-drawer');
    await within(drawer).findByTestId('document-preview-text');
    expect(within(drawer).getByText(/Rose Labs Word Brief/)).toBeInTheDocument();
  });

  it('renders PowerPoint pptx slide text contents in mini + drawer', async () => {
    const user = userEvent.setup();
    const file = makeFile({
      original_filename: 'deck.pptx',
      mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    downloadBlobMock.mockResolvedValue(await buildPptxBlob());

    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          outputs: [{ key: 'deck', label: 'Deck', value: file }],
        }}
      />,
    );

    await screen.findByTestId('file-pointer-mini-text');
    expect(screen.getByTestId('file-pointer-mini-text')).toHaveTextContent(/Rose Labs Deck/);
    await user.click(screen.getByTestId('file-pointer-chip'));
    const drawer = await screen.findByTestId('document-preview-drawer');
    await within(drawer).findByTestId('document-preview-text');
    expect(within(drawer).getByText(/Rose Labs Deck/)).toBeInTheDocument();
  });
});
