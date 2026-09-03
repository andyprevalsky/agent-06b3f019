/**
 * Shared document preview loader for summary mini-previews and the RIGHT drawer.
 * Async + object-URL side effects only; React hooks live in useDocumentPreview.
 */

import { supabase } from '@/lib/supabase';
import { downloadAttachmentAsBlob, downloadAttachmentAsText, type FilePointer } from '../hooks';
import {
  documentPreviewKind,
  parseDelimitedTable,
  parseDocxPackage,
  parseNumbersPackage,
  parsePptxPackage,
  parseSpreadsheetBytes,
  type DocumentPreviewKind,
  type SpreadsheetPreview,
} from './documentPreview.utils';

export const SIGNED_URL_TTL_SECONDS = 3600;

export type DocumentPreviewPayload = {
  kind: DocumentPreviewKind;
  downloadUrl: string;
  previewUrl?: string;
  html?: string;
  text?: string;
  spreadsheet?: SpreadsheetPreview;
  previewImageUrl?: string;
};

export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  // jsdom Blobs may lack arrayBuffer()/stream(); FileReader works in tests + browsers.
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsArrayBuffer(blob);
  });
}

export async function loadDocumentPreview(
  file: FilePointer,
  options?: { activeSheet?: string },
): Promise<{ payload: DocumentPreviewPayload; objectUrls: string[] }> {
  const kind = documentPreviewKind(file);
  const objectUrls: string[] = [];

  const { data, error } = await supabase.storage
    .from('attachments')
    .createSignedUrl(file.storage_path, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message || 'Could not create signed URL');
  }
  const downloadUrl = data.signedUrl;

  if (kind === 'html') {
    const html = await downloadAttachmentAsText(downloadUrl);
    return { payload: { kind, downloadUrl, html }, objectUrls };
  }

  if (kind === 'text' || kind === 'markdown') {
    const text = await downloadAttachmentAsText(downloadUrl);
    return { payload: { kind, downloadUrl, text }, objectUrls };
  }

  if (kind === 'csv') {
    const text = await downloadAttachmentAsText(downloadUrl);
    const delimiter = file.original_filename.toLowerCase().endsWith('.tsv') ? '\t' : ',';
    const rows = parseDelimitedTable(text, delimiter);
    return {
      payload: {
        kind,
        downloadUrl,
        text,
        spreadsheet: { sheetNames: ['Sheet1'], activeSheet: 'Sheet1', rows },
      },
      objectUrls,
    };
  }

  if (kind === 'spreadsheet') {
    const blob = await downloadAttachmentAsBlob(downloadUrl);
    const spreadsheet = await parseSpreadsheetBytes(
      await blobToArrayBuffer(blob),
      options?.activeSheet,
    );
    return { payload: { kind, downloadUrl, spreadsheet }, objectUrls };
  }

  if (kind === 'numbers') {
    const blob = await downloadAttachmentAsBlob(downloadUrl);
    const parsed = await parseNumbersPackage(await blobToArrayBuffer(blob));
    if (parsed.previewImageUrl) objectUrls.push(parsed.previewImageUrl);
    return {
      payload: {
        kind,
        downloadUrl,
        spreadsheet: parsed.spreadsheet,
        previewImageUrl: parsed.previewImageUrl,
        text: parsed.text,
      },
      objectUrls,
    };
  }

  if (kind === 'docx') {
    const blob = await downloadAttachmentAsBlob(downloadUrl);
    const parsed = await parseDocxPackage(await blobToArrayBuffer(blob));
    return { payload: { kind, downloadUrl, text: parsed.text }, objectUrls };
  }

  if (kind === 'pptx') {
    const blob = await downloadAttachmentAsBlob(downloadUrl);
    const parsed = await parsePptxPackage(await blobToArrayBuffer(blob));
    return { payload: { kind, downloadUrl, text: parsed.text }, objectUrls };
  }

  if (kind === 'download') {
    return { payload: { kind, downloadUrl }, objectUrls };
  }

  const blob = await downloadAttachmentAsBlob(downloadUrl);
  const previewUrl = URL.createObjectURL(blob);
  objectUrls.push(previewUrl);
  return { payload: { kind, downloadUrl, previewUrl }, objectUrls };
}
