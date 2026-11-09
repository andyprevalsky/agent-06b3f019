import assert from 'node:assert/strict';
import { reportBugDiagnosticApi, ReportBugStageError } from './report-bug.diagnostics.support';

export type DiagnosticApi = typeof reportBugDiagnosticApi;
export type DiagnosticCase = readonly [string, () => Promise<void>];

async function rejection(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail('expected operation to reject');
}

/** Pure functions: register these with existing report-bug runTest; no backend import. */
export function createReportBugDiagnosticCases(
  api: DiagnosticApi = reportBugDiagnosticApi
): DiagnosticCase[] {
  return [
    [
      'diagnostics retain stage, original cause, transport code and stack',
      async () => {
        const cause = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
        const error = await rejection(() =>
          api.stage('signed-image-headers', async () => {
            throw cause;
          })
        );
        assert(error instanceof ReportBugStageError);
        assert.equal(error.cause, cause);
        const text = api.format(error);
        assert.match(text, /stage=signed-image-headers/);
        assert.match(text, /cause: TypeError code=ECONNRESET/);
        assert.match(text, /\bat\s/);
      },
    ],
    [
      'diagnostics distinguish body-read failure after successful headers',
      async () => {
        const events: string[] = [];
        const response = await api.stage('signed-image-headers', async () => {
          events.push('headers');
          return {
            status: 200,
            arrayBuffer: async () => {
              events.push('body');
              throw new Error('terminated');
            },
          };
        });
        assert.equal(response.status, 200);
        const error = await rejection(() =>
          api.stage('signed-image-body', () => response.arrayBuffer())
        );
        assert.match(api.format(error), /stage=signed-image-body/);
        assert.deepEqual(events, ['headers', 'body']);
      },
    ],
    [
      'diagnostics preserve simultaneous primary and cleanup failures',
      async () => {
        const primary = Object.assign(new Error('primary'), { code: 'UND_ERR_BODY_TIMEOUT' });
        const cleanup = Object.assign(new Error('cleanup'), { code: 'ECONNREFUSED' });
        let cleanups = 0;
        const error = await rejection(() =>
          api.cleanup(
            async () => {
              throw primary;
            },
            async () => {
              cleanups += 1;
              throw cleanup;
            }
          )
        );
        assert.equal(cleanups, 1);
        assert(error instanceof AggregateError);
        assert.equal(error.cause, primary);
        assert.equal(error.errors[0], primary);
        assert.equal(error.errors[1].cause, cleanup);
        const text = api.format(error);
        assert.match(text, /AggregateError/);
        assert.match(text, /UND_ERR_BODY_TIMEOUT/);
        assert.match(text, /errors\[1\]: ReportBugStageError stage=fixture-cleanup/);
        assert.match(text, /ECONNREFUSED/);
      },
    ],
    [
      'diagnostics fail cleanup-only and retain its cause',
      async () => {
        const cleanup = new Error('cleanup');
        const error = await rejection(() =>
          api.cleanup(
            async () => 42,
            async () => {
              throw cleanup;
            }
          )
        );
        assert(error instanceof ReportBugStageError);
        assert.equal(error.stage, 'fixture-cleanup');
        assert.equal(error.cause, cleanup);
        assert.match(api.format(error), /fixture-cleanup/);
      },
    ],
    [
      'diagnostics redact URL userinfo/query/path and omit response data',
      async () => {
        const url =
          'https://private-user:private-password@storage.invalid/storage/v1/object/sign/attachments/private-object?token=private-query#private-fragment';
        const error = Object.assign(
          new Error(`Expected 201, got 500: {"url":"${url}","data":"raw-body-secret"}`),
          {
            response: { data: 'raw-response-secret' },
            code: 'E_CUSTOM_CAUSE',
          }
        );
        error.stack = `Error: ${url}\n raw-body-secret\n    at fetch (${url})\n    at caller (/local/known-credential.ts:12:3)\n    at auth (Bearer bearer-secret)\n    at auth (api_key=assignment-secret)\n    at escaped (https%3A%2F%2Fstorage.invalid%2Fprivate-encoded%3Ftoken%3Dprivate-encoded-token)\n    at relative (/storage/v1/object/sign/attachments/relative-secret?token=relative-token)`;
        const text = api.format(error, ['known-credential']);
        assert.match(text, /URL REDACTED/);
        assert.match(text, /caller/);
        for (const secret of [
          'private-user',
          'private-password',
          'private-object',
          'private-query',
          'private-fragment',
          'raw-body-secret',
          'raw-response-secret',
          'known-credential',
          'bearer-secret',
          'assignment-secret',
          'private-encoded',
          'relative-secret',
          'relative-token',
        ])
          assert(!text.includes(secret), `leaked ${secret}`);
      },
    ],
    [
      'diagnostics bound cyclic causes and aggregate branches',
      async () => {
        const child = Object.assign(new Error('nested'), { code: 'UND_ERR_SOCKET' });
        const error = new AggregateError([child, child, new Error('second')], 'aggregate');
        Object.defineProperty(child, 'cause', { value: error });
        const text = api.format(error);
        assert.match(text, /UND_ERR_SOCKET/);
        assert.match(text, /errors\[2\]: Error/);
        assert.match(text, /cycle or repeated reference/);
        const wide = api.format(
          new AggregateError(
            Array.from({ length: 1000 }, () => new Error()),
            'wide'
          )
        );
        assert.match(wide, /aggregate branch limit/);
        assert(wide.length <= 16_384);
        let deep: Error = new Error('leaf');
        for (let i = 0; i < 100; i += 1) deep = new Error('wrapper', { cause: deep });
        assert.match(api.format(deep), /traversal limit/);
      },
    ],
    [
      'diagnostics preserve primary-only, success and thrown undefined',
      async () => {
        const primary = new Error('original');
        let cleanups = 0;
        assert.equal(
          await rejection(() =>
            api.cleanup(
              async () => {
                throw primary;
              },
              async () => {
                cleanups += 1;
              }
            )
          ),
          primary
        );
        assert.equal(
          await api.cleanup(
            async () => 42,
            async () => {
              cleanups += 1;
            }
          ),
          42
        );
        let rejected = false;
        try {
          await api.cleanup(
            async () => {
              throw undefined;
            },
            async () => {
              cleanups += 1;
            }
          );
        } catch (error) {
          rejected = true;
          assert.equal(error, undefined);
        }
        assert(rejected);
        assert.equal(cleanups, 3);
      },
    ],
    [
      'diagnostics preserve assertion messages without arbitrary response fields',
      async () => {
        const error = new Error('signed URL served different bytes');
        Object.defineProperty(error, 'response', {
          get: () => {
            assert.fail('response getter read');
          },
        });
        assert.match(api.format(error), /signed URL served different bytes/);
        const payload = {
          toString: () => {
            assert.fail('payload stringified');
          },
        };
        assert.equal(api.format(payload), '[non-Error throw omitted]');
        const status = api.format(
          new Error('Expected 201, got 500: {"data":"raw-response-secret"}')
        );
        assert.match(status, /Expected 201, got 500/);
        assert(!status.includes('raw-response-secret'));
        assert.match(
          api.format(new Error('screenshot-upload schema: expected success boolean')),
          /schema: expected success boolean/
        );
      },
    ],
  ];
}

export const reportBugDiagnosticCases = createReportBugDiagnosticCases();
