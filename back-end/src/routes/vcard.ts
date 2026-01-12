import { Router } from 'express';
// @ts-ignore - vcards-js doesn't have type declarations
import vCardsJS from 'vcards-js';

const router = Router();

/**
 * GET /api/vcard/rose.vcf
 *
 * Returns Rose's contact card as a vCard file.
 * This endpoint is public (no auth) so Twilio MMS can fetch it.
 *
 * Headers set for optimal iOS/Android compatibility:
 * - Content-Type: text/vcard
 * - Content-Disposition: inline (allows preview)
 * - Cache-Control: no-cache (prevents iOS caching issues)
 */
router.get('/rose.vcf', (req, res) => {
  const vCard = vCardsJS();

  // Name
  vCard.firstName = 'Rose';
  vCard.lastName = 'L.';

  // Contact info
  vCard.cellPhone = '+14154498445';
  vCard.email = 'rose@roselabs.ai';

  // Organization
  vCard.organization = 'Rose Labs';
  vCard.title = 'SI';

  // URLs
  vCard.url = 'https://roselabs.ai';

  // Birthday (Jan 1, 2026)
  vCard.birthday = new Date(2026, 0, 1);

  // Photo - hosted on roselabs.ai
  vCard.photo.attachFromUrl('https://roselabs.ai/rose-contact.png', 'PNG');

  // Set headers for vCard delivery
  res.set('Content-Type', 'text/vcard; name="rose.vcf"');
  res.set('Content-Disposition', 'inline; filename="rose.vcf"');
  res.set('Cache-Control', 'no-cache');

  res.send(vCard.getFormattedString());
});

export default router;
