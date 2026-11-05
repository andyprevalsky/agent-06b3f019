/** Mock-only rejected proxy request diagnostics; never allocates a live proxy. */
import nodeAssert from 'node:assert/strict';
import { BadRequestError, InternalServerError, type Kernel } from '@onkernel/sdk';
import {
  KERNEL_CREATE_REQUEST_OPTIONS,
  type KernelProxyCandidate,
} from '../../providers/browser/kernelProxy';
import { retryWithBackoff } from '../../providers/retry';
import { assert } from './browser-provider.helpers';

function labelThrowawayCreateFailure(candidate: KernelProxyCandidate, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `stale-proxy leg: Kernel proxies.create(${candidate.type} ${JSON.stringify(
      candidate.config
    )}) rejected: ${detail}`,
    { cause: error }
  );
}

export async function assertStaleProxyCreateFailureIsLabeled(): Promise<void> {
  const kernelBody = {
    code: 'validation_error',
    message:
      'proxy configuration validation failed: failed to validate country: pingproxy: unexpected status 403: You do not have permission to perform this action.',
  };
  const creates: Array<{ type?: string; config?: unknown }> = [];
  const kernel = {
    proxies: {
      create: async (body: { type?: string; config?: unknown }) => {
        creates.push(body);
        throw new BadRequestError(400, kernelBody, kernelBody.message, new Headers());
      },
      delete: async () => {
        throw new Error('proxies.delete must not run when the create failed');
      },
    },
    browsers: {
      retrieve: async () => {
        throw new Error('browsers.retrieve must not run when the create failed');
      },
    },
  } as unknown as Kernel;
  const backendCalls: string[] = [];
  await nodeAssert.rejects(
    retryWithBackoff(
      async () => {
        try {
          await kernel.proxies.create(
            {
              type: 'mobile',
              name: 'mock-only-stale-proxy',
              config: { country: 'US', state: 'IL' },
            },
            KERNEL_CREATE_REQUEST_OPTIONS
          );
        } catch (error) {
          throw labelThrowawayCreateFailure(
            { type: 'mobile', config: { country: 'US', state: 'IL' } } as KernelProxyCandidate,
            error
          );
        }
      },
      {
        maxRetries: 3,
        fixedDelays: [1_000, 2_000],
        isRetryable: (error) => error instanceof InternalServerError,
      }
    ),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      for (const fragment of [
        'stale-proxy leg',
        'proxies.create',
        'mobile {"country":"US","state":"IL"}',
        `400 ${kernelBody.message}`,
      ]) {
        assert(
          message.includes(fragment),
          `labelled failure lacks ${JSON.stringify(fragment)}: ${message}`
        );
      }
      assert(
        error instanceof Error && error.cause instanceof BadRequestError,
        'the original Kernel SDK error must be preserved as cause'
      );
      return true;
    }
  );
  assert(
    creates.length === 1 && creates[0]?.type === 'mobile',
    `a Kernel 4xx must not be retried (creates=${creates.length})`
  );
  assert(
    backendCalls.length === 0,
    `no backend call may precede the throwaway create: ${backendCalls.join(',')}`
  );
}
