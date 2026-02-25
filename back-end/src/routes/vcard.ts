import { Router } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
// @ts-ignore - vcards-js doesn't have type declarations
import vCardsJS from 'vcards-js';
import { prisma } from '../lib/prisma';

const router = Router();

// Pre-load the default Rose contact photo as base64 (256x256, ~35KB)
// This avoids fetching the full-size 556KB image at runtime and keeps vCards under MMS size limits
const DEFAULT_PHOTO_BASE64 = readFileSync(join(__dirname, '../assets/rose-contact-256.png')).toString('base64');

function applyDefaultPhoto(vCard: any) {
  vCard.photo.embedFromString(DEFAULT_PHOTO_BASE64, 'PNG');
}

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
  const vCard = vCardsJS();

  // Name
  vCard.firstName = 'Rose';
  vCard.lastName = '';

  // Contact info
  vCard.cellPhone = '+14154498072';
  vCard.email = 'rose@roselabs.ai';

  // Organization
  vCard.organization = 'Rose Labs';
  // No job title

  // URLs
  vCard.url = 'https://roselabs.ai';

  // Birthday (Jan 1, 2026)
  vCard.birthday = new Date(2026, 0, 1);

  // Photo - embedded base64 (256x256 PNG)
  applyDefaultPhoto(vCard);

  // Set headers for vCard delivery
  res.set('Content-Type', 'text/vcard; name="rose.vcf"');
  res.set('Content-Disposition', 'inline; filename="rose.vcf"');
  res.set('Cache-Control', 'no-cache');

  res.send(vCard.getFormattedString());
});

/**
 * GET /api/vcard/:userId.vcf
 *
 * Returns a personalized contact card for a user.
 * Uses their systemName and profilePicture if set.
 * This endpoint is public (no auth) so Surge MMS can fetch it.
 */
router.get('/:userId.vcf', async (req, res) => {
  try {
    const { userId } = req.params;

    // Fetch user customization
    const user = await prisma.user.findUnique({
      where: { userId },
      select: {
        systemName: true,
        profilePicture: true,
      },
    });

    const vCard = vCardsJS();

    // Name - use customized name or default to Rose
    const systemName = user?.systemName || 'Rose';
    vCard.firstName = systemName;
    vCard.lastName = '';

    // Contact info (always Rose Labs)
    vCard.cellPhone = '+14154498072';
    vCard.email = 'rose@roselabs.ai';

    // Organization
    vCard.organization = 'Rose Labs';
    // No job title

    // URLs
    vCard.url = 'https://roselabs.ai';

    // Birthday (Jan 1, 2026)
    vCard.birthday = new Date(2026, 0, 1);

    // Photo - always use default (custom photos may exceed MMS size limits)
    applyDefaultPhoto(vCard);

    // Set headers for vCard delivery
    const filename = `${systemName.toLowerCase().replace(/\s+/g, '-')}.vcf`;
    res.set('Content-Type', `text/vcard; name="${filename}"`);
    res.set('Content-Disposition', `inline; filename="${filename}"`);
    res.set('Cache-Control', 'no-cache');

    res.send(vCard.getFormattedString());
  } catch (error) {
    console.error('Failed to generate personalized vCard:', error);
    // Fall back to default Rose vCard on error
    const vCard = vCardsJS();
    vCard.firstName = 'Rose';
    vCard.lastName = '';
    vCard.cellPhone = '+14154498072';
    vCard.email = 'rose@roselabs.ai';
    vCard.organization = 'Rose Labs';
    // No job title
    vCard.url = 'https://roselabs.ai';
    vCard.birthday = new Date(2026, 0, 1);
    applyDefaultPhoto(vCard);

    res.set('Content-Type', 'text/vcard; name="rose.vcf"');
    res.set('Content-Disposition', 'inline; filename="rose.vcf"');
    res.set('Cache-Control', 'no-cache');
    res.send(vCard.getFormattedString());
  }
});

export default router;
