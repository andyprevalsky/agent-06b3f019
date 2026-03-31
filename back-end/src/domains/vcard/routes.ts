import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';

const router = Router();

/**
 * GET /api/vcard/rose.vcf
 *
 * Returns Rose's contact card as a vCard file.
 * This endpoint is public (no auth) so Surge MMS can fetch it.
 *
 * Headers set for optimal iOS/Android compatibility:
 * - Content-Type: text/vcard
 * - Content-Disposition: inline (allows preview)
 * - Cache-Control: no-cache (prevents iOS caching issues)
 */
router.get('/rose.vcf', (req, res) => {
  const content = service.generateRoseVCard();

  res.set('Content-Type', 'text/vcard; name="rose.vcf"');
  res.set('Content-Disposition', 'inline; filename="rose.vcf"');
  res.set('Cache-Control', 'no-cache');

  res.send(content);
});

/**
 * GET /api/vcard/:userId.vcf
 *
 * Returns a personalized contact card for a user.
 * Uses their systemName and profilePicture if set.
 * This endpoint is public (no auth) so Surge MMS can fetch it.
 */
router.get(
  '/:userId.vcf',
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { content, filename } = await service.generatePersonalizedVCard(userId);

    res.set('Content-Type', `text/vcard; name="${filename}"`);
    res.set('Content-Disposition', `inline; filename="${filename}"`);
    res.set('Cache-Control', 'no-cache');

    res.send(content);
  })
);

export default router;
