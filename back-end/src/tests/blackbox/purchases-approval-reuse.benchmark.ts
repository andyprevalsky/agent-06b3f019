import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createApprovedPurchaseSelector } from '../../domains/purchases/approvalReuse';
import type { MintPurchaseInput, PurchaseSpend } from '../../domains/purchases/types';
import { createStreamingCompletion } from '../../providers/rose/client';
import { assert } from './purchases.testkit';

interface ApprovalExample {
  id: string;
  batch: number;
  reason: string;
  expectedPurchaseId: string | null;
  requested: MintPurchaseInput;
  approved: Array<{ id: string; merchant: string; receipt: MintPurchaseInput }>;
}

function examples(): ApprovalExample[] {
  return JSON.parse(
    readFileSync(new URL('../fixtures/approval-reuse-adversarial.json', import.meta.url), 'utf8')
  );
}

function decisionOutcome(actual: string | null, expected: string | null): string {
  if (actual === expected) return expected === null ? 'TN' : 'TP';
  return actual === null ? 'FN' : 'FP';
}

/** Verify grading itself with deliberate false approvals and false rejections. No live calls. */
export function testApprovalBenchmarkGrading(): void {
  assert(decisionOutcome('right', 'right') === 'TP', 'equivalent retry must score TP');
  assert(decisionOutcome(null, null) === 'TN', 'different purchase must score TN');
  assert(decisionOutcome('wrong', null) === 'FP', 'unsafe approval must score FP');
  assert(decisionOutcome(null, 'right') === 'FN', 'redundant approval must score FN');
  assert(decisionOutcome('wrong', 'right') === 'FP', 'wrong candidate is an unsafe approval');
  const cases = examples();
  const batches = new Set(cases.map((example) => example.batch));
  assert(new Set(cases.map((example) => example.id)).size === cases.length, 'unique examples');
  for (const batch of batches) {
    const members = cases.filter((example) => example.batch === batch);
    assert(members.length === 5, 'frozen benchmark batches must contain five examples');
    for (const example of members) {
      assert(example.reason.trim().length > 0, 'expected labels need a predeclared rationale');
      assert(
        example.expectedPurchaseId === null ||
          example.approved.some((approved) => approved.id === example.expectedPurchaseId),
        'expected purchase must belong to the case'
      );
    }
  }
}

function variant(example: ApprovalExample, iteration: number): ApprovalExample {
  if (iteration === 0) return example;
  const copy: ApprovalExample = structuredClone(example);
  copy.approved.reverse();
  copy.requested.lineItems.reverse();
  for (const approved of copy.approved) {
    approved.receipt.lineItems.reverse();
    if (iteration === 2) {
      const opaqueId = createHash('sha256').update(`${example.id}:${approved.id}`).digest('hex');
      if (copy.expectedPurchaseId === approved.id) copy.expectedPurchaseId = opaqueId;
      approved.id = opaqueId;
    }
  }
  return copy;
}

async function evaluate(example: ApprovalExample, iteration: number) {
  const usage: Array<Record<string, unknown>> = [];
  let contextChars = 0;
  const select = createApprovedPurchaseSelector(
    async (options) => {
      contextChars = JSON.stringify(options.messages).length;
      return createStreamingCompletion(options);
    },
    (chunk) => {
      usage.push({ model: chunk.actual_model, ...chunk.usage });
    }
  );
  const candidates = example.approved.map(
    (approved) =>
      ({
        id: approved.id,
        merchant: approved.merchant,
        lineItemsJson: approved.receipt,
      }) as PurchaseSpend
  );
  const requested = {
    ...example.requested,
    userId: 'approval-benchmark',
    agentId: `approval-benchmark-${example.id}`,
    fingerprint: 'benchmark-retry',
  };
  const started = Date.now();
  try {
    const actual = await select(candidates, requested);
    const expected = example.expectedPurchaseId;
    const outcome = decisionOutcome(actual, expected);
    return {
      id: example.id,
      iteration,
      actual,
      expected,
      outcome,
      contextChars,
      elapsedMs: Date.now() - started,
      usage,
    };
  } catch (error) {
    return {
      id: example.id,
      iteration,
      expected: example.expectedPurchaseId,
      outcome: 'ERROR',
      contextChars,
      elapsedMs: Date.now() - started,
      usage,
      error: String(error),
    };
  }
}

/** Opt-in live semantic benchmark; ordinary owning tests remain offline. Five cases per batch. */
export async function runApprovalReuseBenchmark(): Promise<void> {
  const batch = Number(process.env.APPROVAL_REUSE_BENCH_BATCH);
  const cases = examples().filter((example) => example.batch === batch);
  if (cases.length !== 5) throw new Error('Select one frozen batch of exactly five examples');
  const repeat = Number(process.env.APPROVAL_REUSE_BENCH_REPEAT ?? 1);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) throw new Error('Repeat must be 1–3');
  const startedAt = new Date().toISOString();
  const results = [];
  for (let iteration = 0; iteration < repeat; iteration += 1) {
    results.push(
      ...(await Promise.all(
        cases.map((example) => evaluate(variant(example, iteration), iteration))
      ))
    );
  }
  const counts = Object.fromEntries(
    ['TP', 'TN', 'FP', 'FN', 'ERROR'].map((outcome) => [
      outcome,
      results.filter((result) => result.outcome === outcome).length,
    ])
  );
  const source = readFileSync(new URL('../../domains/purchases/approvalReuse.ts', import.meta.url));
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    batch,
    repeat,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    harnessSha256: createHash('sha256')
      .update(readFileSync(new URL(import.meta.url)))
      .digest('hex'),
    casesSha256: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
    counts,
    results,
  };
  const output = process.env.APPROVAL_REUSE_BENCH_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  if (counts.FP + counts.FN + counts.ERROR > 0)
    throw new Error('Approval semantic benchmark failed');
}
