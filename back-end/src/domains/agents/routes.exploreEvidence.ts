/** Internal route for bounded, saved explore tool results after a parent timeout. */

import { Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as repo from './repo';
import { noCacheHeaders } from './routes.helpers';

const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

router.get(
  '/:id/explore-tool-evidence',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    if (req.isInternal !== true || typeof req.userId !== 'string') {
      res.status(403).json({ error: 'Internal agent access required' });
      return;
    }
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : '';
    if (taskId.length < 1 || taskId.length > 128) {
      res.status(400).json({ error: 'Valid taskId is required' });
      return;
    }
    const rows = await repo.findExploreToolEvidence(req.params.id, req.userId, taskId);
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
    const results = selected.map((row) => {
      const metadata = row.metadata as Record<string, unknown>;
      const marker = '**Result:**';
      const markerIndex = row.text.indexOf(marker);
      const body = (
        markerIndex >= 0 ? row.text.slice(markerIndex + marker.length) : row.text
      ).trim();
      const sourceUrl = /^- \*\*url\*\*:\s*(https?:\/\/\S+)/m.exec(row.text)?.[1];
      const source =
        sourceUrl !== undefined && !body.includes(sourceUrl) ? `Source: ${sourceUrl}\n` : '';
      return `[${metadata.toolName}] ${(source + body).slice(0, 1200)}`;
    });
    noCacheHeaders(res);
    res.json({ results });
  })
);

export default router;
