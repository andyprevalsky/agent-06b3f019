/**
 * Isolated harness for CompletionSummaryCard document outputs + left drawer.
 * Served at /document-preview-validate.html (no auth/realtime).
 *
 * Patches Supabase signed URLs and window.fetch so HTML renders in the drawer
 * iframe without a live storage backend.
 */
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { FilePointer } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { CompletionSummaryCard } from '@/features/terminal-component-group/components/CompletionSummaryCard';
import '@/index.css';

const HTML_BODY = `<!doctype html>
<html><head><meta charset="utf-8"><title>Rose Labs Report</title>
<style>body{font-family:Georgia,serif;padding:24px;background:#faf7f2;color:#1a1a1a}
h1{font-size:28px;margin:0 0 12px}p{line-height:1.5;max-width:40rem}</style>
</head><body><h1>Rose Labs Report</h1>
<p>This HTML document rendered inside the summary output drawer.</p>
</body></html>`;

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

const FILES = [
  makeFile('report.html', 'text/html', HTML_BODY.length),
  makeFile(
    'budget.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    8192,
  ),
  makeFile('forecast.numbers', 'application/vnd.apple.numbers', 12288),
  makeFile('brief.pdf', 'application/pdf', 4096),
  makeFile('rows.csv', 'text/csv', 64),
];

supabase.storage.from = (() => ({
  createSignedUrl: async () => ({
    data: { signedUrl: 'https://signed.example/file' },
    error: null,
  }),
})) as typeof supabase.storage.from;

const originalFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('signed.example')) {
    if (url.includes('pdf') || init?.method === 'HEAD') {
      return new Response('%PDF-1.4 demo', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }
    return new Response(HTML_BODY, {
      status: 200,
      headers: { 'content-type': 'text/html;charset=utf-8' },
    });
  }
  return originalFetch(input, init);
}) as typeof window.fetch;

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <div className="min-h-screen bg-[#EEEFF2] p-6 dark:bg-[#111]">
        <div className="mx-auto max-w-lg space-y-3">
          <h1 className="text-sm font-medium text-muted-foreground">
            Document preview harness — click a chip to open the left drawer
          </h1>
          <CompletionSummaryCard
            data={{
              summary:
                'Generated the deliverable documents and attached them as structured outputs.',
              outputs: FILES.map((file) => ({
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
