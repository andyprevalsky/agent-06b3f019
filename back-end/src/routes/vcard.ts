import { Router } from 'express';
// @ts-ignore - vcards-js doesn't have type declarations
import vCardsJS from 'vcards-js';
import { prisma } from '../lib/prisma';

const router = Router();

// Default Rose contact photo (same as frontend DEFAULT_PROFILE_PICTURE)
const DEFAULT_CONTACT_PHOTO = 'https://roselabs.ai/rose-contact.png';

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

/**
 * GET /api/vcard/:userId.vcf
 *
 * Returns a personalized contact card for a user.
 * Uses their systemName and profilePicture if set.
 * This endpoint is public (no auth) so Twilio MMS can fetch it.
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
    vCard.lastName = 'L.';

    // Contact info (always Rose Labs)
    vCard.cellPhone = '+14154498445';
    vCard.email = 'rose@roselabs.ai';

    // Organization
    vCard.organization = 'Rose Labs';
    vCard.title = 'SI';

    // URLs
    vCard.url = 'https://roselabs.ai';

    // Birthday (Jan 1, 2026)
    vCard.birthday = new Date(2026, 0, 1);

    // Photo - use user's profile picture or default
    const photoUrl = user?.profilePicture || DEFAULT_CONTACT_PHOTO;
    // Determine format from URL (default to PNG)
    const isJpeg = photoUrl.toLowerCase().includes('.jpg') || photoUrl.toLowerCase().includes('.jpeg');
    vCard.photo.attachFromUrl(photoUrl, isJpeg ? 'JPEG' : 'PNG');

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
    vCard.lastName = 'L.';
    vCard.cellPhone = '+14154498445';
    vCard.email = 'rose@roselabs.ai';
    vCard.organization = 'Rose Labs';
    vCard.title = 'SI';
    vCard.url = 'https://roselabs.ai';
    vCard.birthday = new Date(2026, 0, 1);
    vCard.photo.attachFromUrl(DEFAULT_CONTACT_PHOTO, 'PNG');

    res.set('Content-Type', 'text/vcard; name="rose.vcf"');
    res.set('Content-Disposition', 'inline; filename="rose.vcf"');
    res.set('Cache-Control', 'no-cache');
    res.send(vCard.getFormattedString());
  }
});

export default router;
