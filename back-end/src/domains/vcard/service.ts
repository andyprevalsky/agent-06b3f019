// eslint-disable-next-line no-restricted-imports -- domain-specific vCard library, single consumer
import vCardsJS from 'vcards-js';
import * as repo from './repo';
import { isLinqEnabled } from '../../providers/linq';
import { createLogger } from '../../providers/logger';
import {
  SURGE_PHONE,
  linqFromPhone,
  ROSE_EMAIL,
  ROSE_ORG,
  ROSE_URL,
  ROSE_BIRTHDAY,
  DEFAULT_SYSTEM_NAME,
  DEFAULT_PHOTO_BASE64,
} from './config';

const log = createLogger('VCard');

// vcards-js (2.11+) ships its own types; derive ours from the library's return
// type so field shapes (several are string | string[]) stay in sync rather than
// drifting against a hand-rolled interface.
type VCard = ReturnType<typeof vCardsJS>;

/**
 * Rose's number for this recipient: the Linq number when their texts route via
 * Linq (same rule as smsQueue), else the Surge number. Saving a number that
 * never answers them would strand their replies.
 */
export function rosePhoneFor(recipientPhone?: string | null): string {
  const linqPhone = linqFromPhone();
  if (linqPhone === '') return SURGE_PHONE;
  const routed =
    recipientPhone !== null && recipientPhone !== undefined && recipientPhone !== ''
      ? isLinqEnabled(recipientPhone)
      : isLinqEnabled();
  return routed ? linqPhone : SURGE_PHONE;
}

function applyDefaultPhoto(vCard: VCard) {
  vCard.photo.embedFromString(DEFAULT_PHOTO_BASE64, 'PNG');
}

function buildBaseVCard(name: string, phone: string = rosePhoneFor()): VCard {
  const vCard = vCardsJS();
  vCard.firstName = name;
  vCard.lastName = '';
  vCard.cellPhone = phone;
  vCard.email = ROSE_EMAIL;
  vCard.organization = ROSE_ORG;
  vCard.url = ROSE_URL;
  vCard.birthday = ROSE_BIRTHDAY;
  applyDefaultPhoto(vCard);
  return vCard;
}

/**
 * Generate the default Rose vCard string.
 */
export function generateRoseVCard(): string {
  const vCard = buildBaseVCard(DEFAULT_SYSTEM_NAME);
  return vCard.getFormattedString();
}

/**
 * Generate a personalized vCard for a user.
 * Falls back to default Rose vCard on error.
 */
export async function generatePersonalizedVCard(userId: string): Promise<{
  content: string;
  filename: string;
}> {
  try {
    const user = await repo.findUserCustomization(userId);
    const systemName =
      user?.systemName !== null && user?.systemName !== undefined && user.systemName !== ''
        ? user.systemName
        : DEFAULT_SYSTEM_NAME;
    const vCard = buildBaseVCard(systemName, rosePhoneFor(user?.phone));
    const sanitized = systemName
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/-{2,}/g, '-')
      .slice(0, 64);
    const filename = `${sanitized !== '' ? sanitized : 'rose'}.vcf`;
    return { content: vCard.getFormattedString(), filename };
  } catch (error) {
    log.error('Failed to generate personalized vCard', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Fall back to default Rose vCard on error
    return { content: generateRoseVCard(), filename: 'rose.vcf' };
  }
}
