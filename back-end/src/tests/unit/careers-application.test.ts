#!/usr/bin/env tsx
/**
 * Unit tests for the careers application notification path.
 *
 * The real send is injected, so this covers composition + fan-out semantics
 * without emailing the hiring recipients on every CI run. The HTTP surface is
 * covered by src/tests/blackbox/careers.blackbox.ts.
 */

import assert from 'node:assert/strict';
import {
  NotificationError,
  ValidationError,
  buildNotificationBody,
  normalizeLinkedin,
  resumeFilename,
  submitApplication,
  validateApplication,
} from '../../domains/careers/service';
import type { JobApplicationInput } from '../../domains/careers/types';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);

function application(overrides: Partial<JobApplicationInput> = {}): JobApplicationInput {
  return {
    roleSlug: 'founding-product-engineer',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    linkedin: 'adalovelace',
    resume: { filename: 'resume.pdf', mimeType: 'application/pdf', content: PDF },
    ...overrides,
  };
}

function expectValidationError(input: JobApplicationInput, label: string): void {
  assert.throws(() => validateApplication(input), ValidationError, label);
}

// ── Validation ────────────────────────────────────────────────────────────
expectValidationError(application({ name: '   ' }), 'blank name rejected');
expectValidationError(application({ email: 'not-an-email' }), 'malformed email rejected');
expectValidationError(application({ linkedin: '' }), 'blank linkedin rejected');
expectValidationError(application({ roleSlug: 'ceo' }), 'unknown role rejected');
expectValidationError(
  application({
    resume: { filename: 'r.pdf', mimeType: 'application/pdf', content: Buffer.alloc(0) },
  }),
  'empty resume rejected'
);
expectValidationError(
  application({
    resume: { filename: 'r.docx', mimeType: 'application/msword', content: PDF },
  }),
  'non-PDF mime rejected'
);
// A .docx renamed to .pdf still fails: content is sniffed, not trusted.
expectValidationError(
  application({
    resume: {
      filename: 'r.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('PK\x03\x04zip'),
    },
  }),
  'PDF magic bytes enforced'
);
expectValidationError(
  application({
    resume: {
      filename: 'big.pdf',
      mimeType: 'application/pdf',
      content: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024 + 1)]),
    },
  }),
  'oversized resume rejected'
);

const normalized = validateApplication(application({ email: '  ADA@Example.COM ', name: ' Ada ' }));
assert.equal(normalized.email, 'ada@example.com', 'email lowercased and trimmed');
assert.equal(normalized.name, 'Ada', 'name trimmed');

// ── LinkedIn normalization ────────────────────────────────────────────────
for (const raw of [
  'adalovelace',
  'linkedin.com/in/adalovelace',
  'www.linkedin.com/in/adalovelace',
  'https://linkedin.com/in/adalovelace',
  'https://www.linkedin.com/in/adalovelace/',
]) {
  assert.equal(normalizeLinkedin(raw), 'https://linkedin.com/in/adalovelace', `normalizes ${raw}`);
}

// ── Filename ──────────────────────────────────────────────────────────────
assert.equal(
  resumeFilename('Ada Lovelace', 'founding-product-engineer'),
  'ada-lovelace-founding-product-engineer-resume.pdf'
);
assert.equal(
  resumeFilename('!!!', 'founding-product-engineer'),
  'applicant-founding-product-engineer-resume.pdf',
  'falls back when the name has no usable characters'
);

// ── Notification body carries every submitted field ───────────────────────
const body = buildNotificationBody(application());
assert.match(body.subject, /Ada Lovelace/, 'subject names the applicant');
assert.match(body.subject, /founding-product-engineer/, 'subject names the role');
for (const field of ['Ada Lovelace', 'ada@example.com', 'https://linkedin.com/in/adalovelace']) {
  assert.ok(body.text.includes(field), `plain text includes ${field}`);
  assert.ok(body.html.includes(field), `html includes ${field}`);
}
const injected = buildNotificationBody(application({ name: '<script>x</script>' }));
assert.ok(!injected.html.includes('<script>'), 'html body escapes applicant input');

async function main(): Promise<void> {
  // ── Fan-out: one send per recipient, resume attached to each ──────────────
  process.env.CAREERS_NOTIFICATION_RECIPIENTS = 'a@example.com, b@example.com';

  interface SentCall {
    to: string;
    attachments: { filename: string; contentType: string; bytes: number }[];
    subject: string;
  }
  const calls: SentCall[] = [];
  const okResult = await submitApplication(application(), async (params) => {
    calls.push({
      to: params.to,
      subject: params.subject,
      attachments: (params.attachments ?? []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        bytes: a.content.byteLength,
      })),
    });
    return true;
  });
  assert.equal(calls.length, 2, 'one send per recipient');
  assert.deepEqual(
    calls.map((c) => c.to).sort(),
    ['a@example.com', 'b@example.com'],
    'both configured recipients notified'
  );
  for (const call of calls) {
    assert.equal(call.attachments.length, 1, 'exactly one attachment');
    assert.equal(call.attachments[0].contentType, 'application/pdf', 'attached as PDF');
    assert.equal(call.attachments[0].bytes, PDF.byteLength, 'full resume bytes attached');
  }
  assert.deepEqual(okResult.failed, [], 'no failures when every send succeeds');
  assert.equal(okResult.notified.length, 2);

  // ── Partial failure still succeeds: the application is not lost ───────────
  const partial = await submitApplication(
    application(),
    async (params) => params.to === 'a@example.com'
  );
  assert.deepEqual(partial.notified, ['a@example.com']);
  assert.deepEqual(partial.failed, ['b@example.com']);

  // ── Total failure surfaces to the applicant instead of dropping silently ──
  await assert.rejects(
    submitApplication(application(), async () => false),
    NotificationError,
    'every recipient failing raises NotificationError'
  );

  // ── Validation runs before any send ───────────────────────────────────────
  let sendsDuringInvalid = 0;
  await assert.rejects(
    submitApplication(application({ email: 'nope' }), async () => {
      sendsDuringInvalid += 1;
      return true;
    }),
    ValidationError
  );
  assert.equal(sendsDuringInvalid, 0, 'invalid submissions never reach the relay');

  delete process.env.CAREERS_NOTIFICATION_RECIPIENTS;
}

void main().then(() => {
  console.log('careers-application: all assertions passed');
});
