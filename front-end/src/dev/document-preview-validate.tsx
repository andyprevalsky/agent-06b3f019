/**
 * Isolated harness for CompletionSummaryCard document outputs + RIGHT drawer.
 * Served at /document-preview-validate.html (no auth/realtime).
 *
 * Patches Supabase signed URLs and window.fetch so every supported preview
 * kind renders without a live storage backend.
 *
 * Supported preview kinds shown here:
 *   html, pdf, png, markdown, text, json, csv, xlsx, numbers, docx, pptx
 */
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { FilePointer } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { CompletionSummaryCard } from '@/features/terminal-component-group/components/CompletionSummaryCard';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import '@/index.css';

const HTML_BODY = `<!doctype html>
<html><head><meta charset="utf-8"><title>Rose Labs Report</title>
<style>body{font-family:Georgia,serif;padding:24px;background:#faf7f2;color:#1a1a1a}
h1{font-size:28px;margin:0 0 12px}p{line-height:1.5;max-width:40rem}</style>
</head><body><h1>Rose Labs Report</h1>
<p>This HTML document rendered inside the summary output drawer.</p>
</body></html>`;

const MARKDOWN_BODY = `# Rose Labs Brief

Markdown **preview** inside the right drawer.
`;
const TEXT_BODY = 'Plain text deliverable for Rose Labs.\nLine two.';
const JSON_BODY = JSON.stringify({ product: 'Rose', status: 'ready' }, null, 2);
const CSV_BODY = 'Name,Score\nAda,10\nGrace,20\n';

const PDF_BODY = `%PDF-1.1
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 180] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length 55 >>stream
BT /F1 24 Tf 40 100 Td (Rose Labs PDF) Tj ET
endstream
endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000373 00000 n 
trailer<< /Size 6 /Root 1 0 R >>
startxref
450
%%EOF`;

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeFile(filename: string, mime: string, size: number): FilePointer {
  return {
    id: `fp-${filename}`,
    storage_path: `demo/${filename}`,
    original_filename: filename,
    mime_type: mime,
    size_bytes: size,
    created_at: '2026-09-03T00:00:00Z',
  };
}

function buildXlsxBytes(): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Item', 'Amount'],
    ['Cloud', '42'],
    ['Agents', '99'],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Budget');
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

async function buildNumbersBytes(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('tables/forecast.csv', 'Month,Revenue\nJan,10\nFeb,20\n');
  return zip.generateAsync({ type: 'arraybuffer' });
}

async function buildDocxBytes(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
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
  return zip.generateAsync({ type: 'arraybuffer' });
}

async function buildPptxBytes(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
  );
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
  return zip.generateAsync({ type: 'arraybuffer' });
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const XLSX_BYTES = buildXlsxBytes();
const NUMBERS_BYTES = await buildNumbersBytes();
const DOCX_BYTES = await buildDocxBytes();
const PPTX_BYTES = await buildPptxBytes();
const PNG_BYTES = base64ToArrayBuffer(PNG_BASE64);
const PDF_BYTES = new TextEncoder().encode(PDF_BODY).buffer;

type Fixture = {
  file: FilePointer;
  bytes?: ArrayBuffer;
  text?: string;
  contentType: string;
};

const FIXTURES: Fixture[] = [
  {
    file: makeFile('report.html', 'text/html', HTML_BODY.length),
    text: HTML_BODY,
    contentType: 'text/html;charset=utf-8',
  },
  {
    file: makeFile('brief.pdf', 'application/pdf', PDF_BYTES.byteLength),
    bytes: PDF_BYTES,
    contentType: 'application/pdf',
  },
  {
    file: makeFile('logo.png', 'image/png', PNG_BYTES.byteLength),
    bytes: PNG_BYTES,
    contentType: 'image/png',
  },
  {
    file: makeFile('notes.md', 'text/markdown', MARKDOWN_BODY.length),
    text: MARKDOWN_BODY,
    contentType: 'text/markdown',
  },
  {
    file: makeFile('readme.txt', 'text/plain', TEXT_BODY.length),
    text: TEXT_BODY,
    contentType: 'text/plain',
  },
  {
    file: makeFile('meta.json', 'application/json', JSON_BODY.length),
    text: JSON_BODY,
    contentType: 'application/json',
  },
  {
    file: makeFile('rows.csv', 'text/csv', CSV_BODY.length),
    text: CSV_BODY,
    contentType: 'text/csv',
  },
  {
    file: makeFile(
      'budget.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      XLSX_BYTES.byteLength,
    ),
    bytes: XLSX_BYTES,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  {
    file: makeFile('forecast.numbers', 'application/vnd.apple.numbers', NUMBERS_BYTES.byteLength),
    bytes: NUMBERS_BYTES,
    contentType: 'application/vnd.apple.numbers',
  },
  {
    file: makeFile(
      'brief.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      DOCX_BYTES.byteLength,
    ),
    bytes: DOCX_BYTES,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  {
    file: makeFile(
      'deck.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      PPTX_BYTES.byteLength,
    ),
    bytes: PPTX_BYTES,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
];

const BY_NAME = Object.fromEntries(FIXTURES.map((f) => [f.file.original_filename, f]));

supabase.storage.from = (() => ({
  createSignedUrl: async (_path: string) => ({
    data: { signedUrl: `https://signed.example/${_path}` },
    error: null,
  }),
})) as typeof supabase.storage.from;

const originalFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.includes('signed.example')) {
    return originalFetch(input, init);
  }
  const name = decodeURIComponent(url.split('/').pop() || '');
  const fixture = BY_NAME[name];
  if (!fixture) {
    return new Response('missing fixture', { status: 404 });
  }
  if (fixture.text !== undefined) {
    return new Response(fixture.text, {
      status: 200,
      headers: { 'content-type': fixture.contentType },
    });
  }
  return new Response(fixture.bytes, {
    status: 200,
    headers: { 'content-type': fixture.contentType },
  });
}) as typeof window.fetch;

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <div className="min-h-screen bg-[#EEEFF2] p-6 dark:bg-[#111]">
        <div className="mx-auto max-w-lg space-y-3">
          <h1 className="text-sm font-medium text-muted-foreground">
            Document preview harness — click each chip (RIGHT drawer shows contents)
          </h1>
          <p className="text-xs text-muted-foreground" data-testid="supported-kinds">
            Supported: HTML, PDF, PNG, Markdown, Text, JSON, CSV, Excel, Numbers, Word, PowerPoint
          </p>
          <CompletionSummaryCard
            data={{
              summary:
                'Generated deliverable documents across common file types and attached them as structured outputs.',
              outputs: FIXTURES.map(({ file }) => ({
                key: file.original_filename,
                label: file.original_filename,
                value: file,
              })),
              toolUsage: [{ name: 'spawn_claude_code_agent', count: 1 }],
              totalToolCalls: 1,
              durationSeconds: 42,
              costDollars: 0.04,
            }}
          />
        </div>
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
);
