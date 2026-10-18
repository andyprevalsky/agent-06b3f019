/** Fake R2 stores wire bytes, and evaluates preconditions at the commit boundary. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export type HubObjectInput = {
  Bucket?: string;
  Key: string;
  Body?: string;
  IfMatch?: string;
  IfNoneMatch?: string;
};
export function objectETag(body: string): string {
  return `"${createHash('md5').update(body).digest('hex')}"`;
}
export function logicalObject(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const value = parsed as Record<string, unknown>;
    if (value.format === 'rose-benchmark-hub-publication-v1') {
      assert.equal(typeof value.publication, 'string');
      assert.equal(typeof value.payload, 'string');
      assert.deepEqual(Object.keys(value).sort(), ['format', 'payload', 'publication']);
      const payload = JSON.parse(value.payload as string) as unknown;
      if (
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        (payload as { format?: string }).format === 'benchmark-hub-overlay-v1'
      ) {
        const catalog = payload as { runs: unknown[]; claims: Record<string, { state: string }> };
        assert.ok(Array.isArray(catalog.runs));
        return JSON.stringify(catalog.runs);
      }
      return value.payload as string;
    }
  }
  return raw;
}
export function commitObject(
  objects: Map<string, string>,
  input: HubObjectInput
): { ETag: string } {
  assert.equal(typeof input.Body, 'string');
  assert.notEqual(
    input.IfMatch === undefined,
    input.IfNoneMatch === undefined,
    'Every write requires exactly one conditional header'
  );
  const current = objects.get(input.Key);
  if (
    (input.IfNoneMatch === '*' && current !== undefined) ||
    (input.IfMatch !== undefined &&
      (current === undefined || objectETag(current) !== input.IfMatch))
  ) {
    throw Object.assign(new Error('fixture precondition failed'), {
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412 },
    });
  }
  objects.set(input.Key, input.Body!);
  return { ETag: objectETag(input.Body!) };
}
