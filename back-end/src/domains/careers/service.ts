import { createLogger } from '../../providers/logger';
import { notificationSender, sendNotification, type NotificationMessage } from './repo';
import {
  KNOWN_ROLE_SLUGS,
  MAX_RESUME_BYTES,
  RESUME_MIME_TYPE,
  notificationRecipients,
} from './config';
import type { JobApplicationInput, JobApplicationResult } from './types';

const log = createLogger('Careers');

export class ValidationError extends Error {}
export class NotificationError extends Error {}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** PDFs start with "%PDF-"; a renamed .docx will not. */
const PDF_MAGIC = Buffer.from('%PDF-');

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(`${field} is too long`);
  }
  return trimmed;
}

/** Normalize whatever the applicant typed into a full LinkedIn URL. */
export function normalizeLinkedin(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '');
  const handle = trimmed.replace(/^linkedin\.com\/in\//i, '').replace(/\/+$/, '');
  return `https://linkedin.com/in/${handle}`;
}

/** Validate a submission, throwing ValidationError with a user-facing message. */
export function validateApplication(input: JobApplicationInput): JobApplicationInput {
  const roleSlug = requireText(input.roleSlug, 'Role', 200);
  if (!(KNOWN_ROLE_SLUGS as readonly string[]).includes(roleSlug)) {
    throw new ValidationError('Unknown role');
  }

  const name = requireText(input.name, 'Name', 200);
  const email = requireText(input.email, 'Email', 320).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new ValidationError('Invalid email format');
  }
  const linkedin = requireText(input.linkedin, 'LinkedIn', 500);

  if (input.resume === undefined || input.resume.content.byteLength === 0) {
    throw new ValidationError('Resume is required');
  }
  if (input.resume.content.byteLength > MAX_RESUME_BYTES) {
    throw new ValidationError('Resume must be under 10MB');
  }
  if (input.resume.mimeType !== RESUME_MIME_TYPE) {
    throw new ValidationError('Resume must be a PDF');
  }
  if (!input.resume.content.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new ValidationError('Resume must be a PDF');
  }

  return { roleSlug, name, email, linkedin, resume: input.resume };
}

/** Filename the recipients see, derived from the applicant so it is scannable. */
export function resumeFilename(name: string, roleSlug: string): string {
  const slug = (part: string) =>
    part
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  return `${slug(name) || 'applicant'}-${slug(roleSlug)}-resume.pdf`;
}

export function buildNotificationBody(input: JobApplicationInput): {
  subject: string;
  text: string;
  html: string;
} {
  const linkedin = normalizeLinkedin(input.linkedin);
  const subject = `New application: ${input.name} (${input.roleSlug})`;
  const text = [
    `New application for ${input.roleSlug}.`,
    '',
    `Name:     ${input.name}`,
    `Email:    ${input.email}`,
    `LinkedIn: ${linkedin}`,
    `Role:     ${input.roleSlug}`,
    `Received: ${new Date().toISOString()}`,
    '',
    'Resume is attached as a PDF.',
  ].join('\n');
  const esc = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = [
    `<p>New application for <strong>${esc(input.roleSlug)}</strong>.</p>`,
    '<table cellpadding="4">',
    `<tr><td><strong>Name</strong></td><td>${esc(input.name)}</td></tr>`,
    `<tr><td><strong>Email</strong></td><td><a href="mailto:${esc(input.email)}">${esc(input.email)}</a></td></tr>`,
    `<tr><td><strong>LinkedIn</strong></td><td><a href="${esc(linkedin)}">${esc(linkedin)}</a></td></tr>`,
    `<tr><td><strong>Role</strong></td><td>${esc(input.roleSlug)}</td></tr>`,
    `<tr><td><strong>Received</strong></td><td>${esc(new Date().toISOString())}</td></tr>`,
    '</table>',
    '<p>Resume is attached as a PDF.</p>',
  ].join('');
  return { subject, text, html };
}

/**
 * Validate an application and notify the hiring recipients, resume attached.
 *
 * Recipients are fanned out one send per address so a single rejected address
 * cannot lose the whole application. Succeeds when at least one notification is
 * accepted; throws NotificationError only when every recipient failed, so the
 * applicant is told to retry rather than silently dropped.
 */
export type SendNotification = (message: NotificationMessage) => Promise<boolean>;

export async function submitApplication(
  input: JobApplicationInput,
  send: SendNotification = sendNotification
): Promise<JobApplicationResult> {
  const application = validateApplication(input);
  const { subject, text, html } = buildNotificationBody(application);
  const from = notificationSender();
  const recipients = notificationRecipients();
  const filename = resumeFilename(application.name, application.roleSlug);

  const outcomes = await Promise.all(
    recipients.map(async (to) => ({
      to,
      ok: await send({
        from,
        to,
        subject,
        bodyText: text,
        bodyHtml: html,
        attachments: [
          {
            filename,
            contentType: RESUME_MIME_TYPE,
            content: application.resume.content,
          },
        ],
      }),
    }))
  );

  const notified = outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.to);
  const failed = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.to);

  if (notified.length === 0) {
    log.error('Application notification failed for every recipient', {
      role: application.roleSlug,
      email: application.email,
      recipients,
    });
    throw new NotificationError('Could not deliver your application. Please try again.');
  }

  if (failed.length > 0) {
    log.warn('Application notification partially delivered', {
      role: application.roleSlug,
      notified,
      failed,
    });
  } else {
    log.info('Application notification delivered', {
      role: application.roleSlug,
      email: application.email,
      notified,
    });
  }

  return { success: true, notified, failed };
}
