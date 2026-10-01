/** Select bounded, source-attributed completed results from one explore task. */

import * as repo from './repo';

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
      sourceUrl !== undefined && !body.includes(sourceUrl) ? `Source: ${sourceUrl}\n` : '';
    return `[${metadata.toolName}] ${(source + body).slice(0, 1200)}`;
  });
}
