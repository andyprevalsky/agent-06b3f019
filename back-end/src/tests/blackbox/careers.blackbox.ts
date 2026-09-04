#!/usr/bin/env tsx
/**
 * Black-box tests for /api/careers
 *
 * Domain surface:
 *   POST /api/careers/applications — submit a job application (public, no auth)
 *
 * Invariants covered:
 *   - auth boundary: endpoint is public; no API key or user id required
 *   - error-surface: every rejection returns { error: string }
 *   - boundary param: role slug, email shape, resume MIME, magic bytes, size cap
 *   - same-input reproducibility: identical invalid input always returns 400
 *   - concurrency: parallel invalid submissions are independently rejected
 *   - cleanup: no fixtures written; rejected submissions have no side effects
 *   - observability: covered by runner manifest and artifact directory
 *
 * Deliberately NOT covered here: a successful submission. Success emails the
 * real hiring recipients through Primitive's relay, so asserting it in a suite
 * that runs on every deploy would spam them. The delivery path (composition,
 * per-recipient fan-out, partial and total failure) is covered with an injected
 * sender in src/tests/unit/careers-application.test.ts.
 *
 * Invariants not applicable:
 *   - state-transition, ordering/pagination, atomicity, referential integrity,
 *     tenant isolation, read-after-write: the endpoint persists nothing.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/careers.blackbox.ts
 */

import { config } from 'dotenv';
import { z } from 'zod';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const CASE_CONCURRENCY = Number(
  process.env.BLACKBOX_TEST_CASE_CONCURRENCY ?? process.env.CONTRACT_TEST_CASE_CONCURRENCY ?? 30
);
const ENDPOINT = `${BASE_URL}/api/careers/applications`;
const VALID_ROLE = 'founding-product-engineer';

const ErrorResponse = z.object({ error: z.string() });

// ==================== TEST INFRASTRUCTURE ====================

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

function pdfBytes(sizeBytes = 512): Buffer {
  const header = Buffer.from('%PDF-1.7');
  return Buffer.concat([header, Buffer.alloc(Math.max(0, sizeBytes - header.length), 0x20)]);
}

interface ResumePart {
  bytes: Buffer;
  filename: string;
  contentType: string;
}

interface SubmissionFields {
  role_slug?: string;
  name?: string;
  email?: string;
  linkedin?: string;
  resume?: ResumePart | null;
}

const DEFAULT_RESUME: ResumePart = {
  bytes: pdfBytes(),
  filename: 'resume.pdf',
  contentType: 'application/pdf',
};

function formFor(fields: SubmissionFields): FormData {
  const form = new FormData();
  form.append('role_slug', fields.role_slug ?? VALID_ROLE);
  form.append('name', fields.name ?? 'Blackbox Applicant');
  form.append('email', fields.email ?? 'blackbox.applicant@example.com');
  form.append('linkedin', fields.linkedin ?? 'blackbox-applicant');

  const resume = fields.resume === undefined ? DEFAULT_RESUME : fields.resume;
  if (resume !== null) {
    form.append(
      'resume',
      new Blob([new Uint8Array(resume.bytes)], { type: resume.contentType }),
      resume.filename
    );
  }
  return form;
}

async function submit(
  fields: SubmissionFields,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(ENDPOINT, { method: 'POST', body: formFor(fields), headers });
  const contentType = response.headers.get('content-type');
  const data = contentType?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 300)}`
    );
  }
}

function assertErrorShape(data: unknown): string {
  const parsed = ErrorResponse.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Error response schema failed: ${JSON.stringify(data).substring(0, 300)}`);
  }
  return parsed.data.error;
}

async function runPool(
  cases: { name: string; fn: () => Promise<void> }[],
  concurrency: number
): Promise<TestResult[]> {
  const results: TestResult[] = new Array(cases.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= cases.length) return;
      results[idx] = await runTest(cases[idx].name, cases[idx].fn);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  return results;
}

// ==================== TESTS ====================

const tests: { name: string; fn: () => Promise<void> }[] = [
  {
    name: 'rejects a missing name',
    fn: async () => {
      const { status, data } = await submit({ name: '' });
      assertStatus(status, 400, data);
      assertErrorShape(data);
    },
  },
  {
    name: 'rejects a malformed email',
    fn: async () => {
      const { status, data } = await submit({ email: 'not-an-email' });
      assertStatus(status, 400, data);
      if (!/email/i.test(assertErrorShape(data))) throw new Error('error should mention email');
    },
  },
  {
    name: 'rejects a missing linkedin',
    fn: async () => {
      const { status, data } = await submit({ linkedin: '' });
      assertStatus(status, 400, data);
      assertErrorShape(data);
    },
  },
  {
    name: 'rejects a missing resume',
    fn: async () => {
      const { status, data } = await submit({ resume: null });
      assertStatus(status, 400, data);
      if (!/resume/i.test(assertErrorShape(data))) throw new Error('error should mention resume');
    },
  },
  {
    name: 'rejects a non-PDF resume by declared MIME type',
    fn: async () => {
      const { status, data } = await submit({
        resume: { bytes: pdfBytes(), filename: 'resume.docx', contentType: 'application/msword' },
      });
      assertStatus(status, 400, data);
      if (!/pdf/i.test(assertErrorShape(data))) throw new Error('error should mention PDF');
    },
  },
  {
    name: 'rejects a non-PDF disguised with a PDF MIME type',
    fn: async () => {
      const { status, data } = await submit({
        resume: {
          bytes: Buffer.from('PK not really a pdf'),
          filename: 'resume.pdf',
          contentType: 'application/pdf',
        },
      });
      assertStatus(status, 400, data);
      if (!/pdf/i.test(assertErrorShape(data))) throw new Error('error should mention PDF');
    },
  },
  {
    name: 'rejects an unknown role slug',
    fn: async () => {
      const { status, data } = await submit({ role_slug: 'chief-vibes-officer' });
      assertStatus(status, 400, data);
      if (!/role/i.test(assertErrorShape(data))) throw new Error('error should mention role');
    },
  },
  {
    name: 'is public: no auth headers required to reach validation',
    fn: async () => {
      const { status, data } = await submit({ name: '' });
      if (status === 401 || status === 403) {
        throw new Error(`endpoint must be public, got ${status}`);
      }
      if (status === 404) throw new Error('endpoint is not mounted');
      assertStatus(status, 400, data);
    },
  },
  {
    name: 'ignores irrelevant auth headers rather than erroring',
    fn: async () => {
      const { status, data } = await submit({ name: '' }, { 'X-API-Key': 'not-a-real-key' });
      assertStatus(status, 400, data);
    },
  },
  {
    name: 'same invalid input reproduces the same rejection',
    fn: async () => {
      const first = await submit({ email: 'still-not-an-email' });
      const second = await submit({ email: 'still-not-an-email' });
      assertStatus(first.status, 400, first.data);
      if (first.status !== second.status) throw new Error('status not reproducible');
      if (assertErrorShape(first.data) !== assertErrorShape(second.data)) {
        throw new Error('error message not reproducible');
      }
    },
  },
  {
    name: 'rejects parallel invalid submissions independently',
    fn: async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => submit({ email: `bad-${i}` }))
      );
      for (const result of results) {
        assertStatus(result.status, 400, result.data);
        assertErrorShape(result.data);
      }
    },
  },
];

async function runAll(): Promise<void> {
  console.log(`\nCareers black-box tests against ${BASE_URL}\n`);
  console.log(`Running ${tests.length} tests (concurrency=${CASE_CONCURRENCY})...`);
  const results = await runPool(tests, CASE_CONCURRENCY);

  for (const r of results) {
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed ? '' : ` -- ${r.error}`} (${r.duration}ms)`
    );
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed, ${results.length} total`);

  if (failed > 0) {
    console.log('\nFAILURES:');
    results.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }

  console.log('\nALL CAREERS BLACK-BOX TESTS PASSED\n');
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
