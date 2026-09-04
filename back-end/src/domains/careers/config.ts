import multer from 'multer';

/**
 * Who gets notified when an application arrives. Override with
 * CAREERS_NOTIFICATION_RECIPIENTS (comma-separated) without a redeploy.
 */
export function notificationRecipients(): string[] {
  const configured = process.env.CAREERS_NOTIFICATION_RECIPIENTS?.trim();
  if (configured !== undefined && configured !== '') {
    return configured
      .split(',')
      .map((address) => address.trim())
      .filter((address) => address !== '');
  }
  return ['a@roselabs.ai', 'tamara@roselabs.ai'];
}

/** Local part of the From address for application notifications. */
export function senderLocalPart(): string {
  const configured = process.env.CAREERS_NOTIFICATION_SENDER_LOCAL_PART?.trim();
  return configured !== undefined && configured !== '' ? configured : 'careers';
}

/** Full From address override, when the default domain is not wanted. */
export function senderOverride(): string | null {
  const configured = process.env.CAREERS_NOTIFICATION_SENDER?.trim();
  return configured !== undefined && configured !== '' ? configured : null;
}

/** Largest resume we accept, in bytes. Mirrors the careers form's stated limit. */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** The only resume format we accept. */
export const RESUME_MIME_TYPE = 'application/pdf';

/** Roles a submission may reference. Mirrors the front-end careers catalog. */
export const KNOWN_ROLE_SLUGS = [
  'founding-research-engineer-agent-harness',
  'founding-infrastructure-developer-tooling-engineer',
  'founding-product-engineer',
] as const;

/**
 * Resume upload middleware. Configured here because domain config.ts is the
 * sanctioned home for multer setup (see eslint no-restricted-imports).
 * Memory storage: the buffer goes straight out as an email attachment, so the
 * file never touches disk.
 */
export const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESUME_BYTES, files: 1 },
});
