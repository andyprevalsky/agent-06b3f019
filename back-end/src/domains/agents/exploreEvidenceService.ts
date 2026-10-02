/** Select bounded, source-attributed completed results from one explore task. */

import * as repo from './repo';

export function clipExploreEvidence(text: string): string {
  const limit = 1200;
  if (text.length <= limit) return text;

  const clipMiddle = (part: string, size: number): string => {
    if (part.length <= size) return part;
    const marker = '\n[...truncated...]\n';
    if (size <= marker.length + 2) return part.slice(0, size);
    const head = Math.ceil((size - marker.length) * 0.7);
    return part.slice(0, head) + marker + part.slice(-(size - marker.length - head));
  };

  // Tool summaries often have a short source header followed by long list
  // sections. A plain prefix can erase every section after the first one.
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const sections = paragraphs.filter((part) => /^[-*] /m.test(part));
  if (sections.length < 2) return clipMiddle(text, limit);

  const sourceHeader = clipMiddle(paragraphs[0], 170);
  const selected =
    sections.length <= 6 ? sections : [...sections.slice(0, 3), ...sections.slice(-3)];
  const separator = '\n\n';
  const perSection = Math.floor(
    (limit - sourceHeader.length - separator.length * selected.length) / selected.length
  );
  return [sourceHeader, ...selected.map((part) => clipMiddle(part, perSection))].join(separator);
}

export async function getExploreToolEvidence(agentId: string, userId: string, taskId: string) {
  const rows = await repo.findExploreToolEvidence(agentId, userId, taskId);
  const usable = rows.filter((row) => {
    const metadata = row.metadata as Record<string, unknown> | null;
    if (
      metadata?.toolName === 'spawn_agent' ||
      metadata?.error === true ||
      typeof metadata?.toolName !== 'string' ||
      typeof row.text !== 'string' ||
      !row.text.trim()
    ) {
      return false;
    }
    if (metadata.toolName !== 'web_fetch') return true;
    const resultText = row.text.split('**Result:**').at(-1)?.trim() ?? '';
    return !(
      /^the (?:requested )?(?:url|page) https?:\/\/\S+ returned\b/i.test(resultText) &&
      /(404|page not found|ページが見つかりません)/i.test(resultText)
    );
  });
  const selected = [
    ...new Map([...usable.slice(0, 4), ...usable.slice(-4)].map((row) => [row.id, row])).values(),
  ];
  return selected.map((row) => {
    const metadata = row.metadata as Record<string, unknown>;
    const marker = '**Result:**';
    const markerIndex = row.text.indexOf(marker);
    const body = (markerIndex >= 0 ? row.text.slice(markerIndex + marker.length) : row.text).trim();
    const sourceUrl = /^- \*\*url\*\*:\s*(https?:\/\/\S+)/m.exec(row.text)?.[1];
    const source =
      sourceUrl !== undefined && !body.slice(0, 170).includes(sourceUrl)
        ? `Source: ${sourceUrl}\n`
        : '';
    return `[${metadata.toolName}] ${clipExploreEvidence(source + body)}`;
  });
}
