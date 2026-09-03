/**
 * Blackbox tests: CompletionSummaryCard document outputs open a left drawer.
 *
 * One case per output file family (html, xlsx, numbers, pdf, csv, png, docx)
 * so regressions in preview routing or chip wiring cannot hide behind a single
 * generic FilePointer assertion. HTML must render inside a sandboxed iframe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

function makeFile(overrides: Partial<FilePointer> & Pick<FilePointer, 'original_filename' | 'mime_type'>): FilePointer {
  return {
    id: overrides.id ?? `fp-${overrides.original_filename}`,
    storage_path: overrides.storage_path ?? `user/${overrides.original_filename}`,
    original_filename: overrides.original_filename,
    mime_type: overrides.mime_type,
    size_bytes: overrides.size_bytes ?? 1024,
    created_at: overrides.created_at ?? '2026-09-03T00:00:00Z',
  };
}

const FILE_CASES: Array<{
  label: string;
  file: FilePointer;
  expectedKind: ReturnType<typeof documentPreviewKind>;
  expectedTypeLabel: string;
  previewTestId: string;
}> = [
  {
    label: 'html',
    file: makeFile({
      original_filename: 'report.html',
      mime_type: 'text/html',
      size_bytes: 256,
    }),
    expectedKind: 'html',
    expectedTypeLabel: 'HTML',
    previewTestId: 'document-preview-html',
  },
  {
    label: 'xlsx',
    file: makeFile({
      original_filename: 'budget.xlsx',
      mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size_bytes: 4096,
    }),
    expectedKind: 'download',
    expectedTypeLabel: 'Excel',
    previewTestId: 'document-preview-download-only',
  },
  {
    label: 'numbers',
    file: makeFile({
      original_filename: 'forecast.numbers',
      mime_type: 'application/vnd.apple.numbers',
      size_bytes: 8192,
    }),
    expectedKind: 'download',
    expectedTypeLabel: 'Numbers',
    previewTestId: 'document-preview-download-only',
  },
  {
    label: 'pdf',
    file: makeFile({
      original_filename: 'brief.pdf',
      mime_type: 'application/pdf',
      size_bytes: 2048,
    }),
    expectedKind: 'pdf',
    expectedTypeLabel: 'PDF',
    previewTestId: 'document-preview-pdf',
  },
  {
    label: 'csv',
    file: makeFile({
      original_filename: 'rows.csv',
      mime_type: 'text/csv',
      size_bytes: 128,
    }),
    expectedKind: 'text',
    expectedTypeLabel: 'Text',
    previewTestId: 'document-preview-text',
  },
  {
    label: 'png',
    file: makeFile({
      original_filename: 'chart.png',
      mime_type: 'image/png',
      size_bytes: 512,
    }),
    expectedKind: 'image',
    expectedTypeLabel: 'Image',
    previewTestId: 'document-preview-image',
  },
  {
    label: 'docx',
    file: makeFile({
      original_filename: 'memo.docx',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size_bytes: 3072,
    }),
    expectedKind: 'download',
    expectedTypeLabel: 'Word',
    previewTestId: 'document-preview-download-only',
  },
];

describe('documentPreview.utils', () => {
  for (const testCase of FILE_CASES) {
    it(`classifies ${testCase.label} as ${testCase.expectedKind}`, () => {
      expect(documentPreviewKind(testCase.file)).toBe(testCase.expectedKind);
      expect(documentTypeLabel(testCase.file)).toBe(testCase.expectedTypeLabel);
    });
  }
});

describe('CompletionSummaryCard document drawer', () => {
  beforeEach(() => {
    downloadBlobMock.mockReset();
    downloadTextMock.mockReset();
    downloadBlobMock.mockImplementation(async () => {
      return new Blob(['%PDF-fake'], { type: 'application/pdf' });
    });
    downloadTextMock.mockImplementation(async (url: string) => {
      void url;
      return '<html><body><h1>Rose Labs Report</h1></body></html>';
    });
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const testCase of FILE_CASES) {
    it(`opens left drawer for ${testCase.label} output and shows ${testCase.previewTestId}`, async () => {
      const user = userEvent.setup();
      renderWithProviders(
        <CompletionSummaryCard
          data={{
            summary: `Delivered ${testCase.label}`,
            outputs: [{ key: 'doc', label: 'Document', value: testCase.file }],
          }}
        />,
      );

      const chip = screen.getByTestId('file-pointer-chip');
      expect(chip).toHaveAttribute('data-filename', testCase.file.original_filename);
      expect(chip).toHaveAttribute('data-mime', testCase.file.mime_type);
      expect(screen.getByText(testCase.file.original_filename)).toBeInTheDocument();
      expect(screen.getByText(`(${testCase.expectedTypeLabel})`)).toBeInTheDocument();

      await user.click(chip);

      expect(await screen.findByTestId('document-preview-drawer')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByTestId(testCase.previewTestId)).toBeInTheDocument();
      });

      if (testCase.expectedKind === 'html') {
        const iframe = screen.getByTestId('document-preview-html');
        expect(iframe.tagName).toBe('IFRAME');
        expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
        expect(iframe).toHaveAttribute('src', 'blob:preview');
        expect(downloadTextMock).toHaveBeenCalled();
        expect(screen.getByTestId('document-preview-html')).toBeInTheDocument();
      }

      if (testCase.expectedKind === 'text') {
        expect(screen.getByTestId('document-preview-text')).toHaveTextContent('Rose Labs Report');
        expect(downloadTextMock).toHaveBeenCalled();
      }

      if (testCase.expectedKind === 'download') {
        expect(screen.getByTestId('document-preview-download-only')).toHaveTextContent(
          testCase.file.original_filename,
        );
      }
    });
  }

  it('renders multiple file outputs without a copy button', () => {
    renderWithProviders(
      <CompletionSummaryCard
        data={{
          summary: 'Done',
          outputs: FILE_CASES.slice(0, 3).map((c) => ({
            key: c.label,
            label: c.label,
            value: c.file,
          })),
        }}
      />,
    );
    expect(screen.getAllByTestId('file-pointer-chip')).toHaveLength(3);
    expect(screen.queryByTitle('Copy to clipboard')).not.toBeInTheDocument();
  });
});
