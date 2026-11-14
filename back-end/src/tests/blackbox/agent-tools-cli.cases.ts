/** CLI connection auth and validation run through the actual HTTP route stack. */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { encryptProjectSecret, decryptProjectSecret } from '../../providers/projects/secrets';
import { mintAgentToolsToken } from '../../providers/agentTools/token';
import {
  agentB,
  call,
  codeToken,
  expectStatus,
  assert,
  rootA,
  otherA,
  userA,
  userB,
  type BlackboxTest,
} from './agent-tools.support';

export const cliIntegrationCases: BlackboxTest[] = [
  {
    name: 'CLI integration routes reject unauthenticated callers and invalid setup requests',
    fn: async () => {
      expectStatus(
        await call('GET', '/api/integrations/cli', undefined, { noAuth: true }),
        401,
        'list auth'
      );
      expectStatus(
        await call('POST', '/api/integrations/cli', { request: 'YC CLI' }, { apiKeyUser: userA }),
        400,
        'request id required'
      );
      expectStatus(
        await call(
          'POST',
          '/api/integrations/cli',
          { request: 'x'.repeat(2001), request_id: randomUUID() },
          { apiKeyUser: userA }
        ),
        400,
        'request limit'
      );
      expectStatus(
        await call('GET', `/api/agent-tools/${agentB}/cli`, undefined, {
          bearer: codeToken(rootA),
        }),
        403,
        'agent scope'
      );
    },
  },
  {
    name: 'CLI list isolates owners and reports a missing template as failed',
    fn: async () => {
      const row = await prisma.integration.create({
        data: {
          userId: userA,
          name: 'cli',
          accountId: randomUUID(),
          type: 'TOOL_SETUP',
          status: 'CONNECTED',
          isActive: true,
          config: {
            kind: 'cli-template-v1',
            name: 'YC',
            request: 'YC CLI',
            agent_id: rootA,
            code_session_id: randomUUID(),
            command: '/home/user/bin/yc',
          },
        },
      });
      try {
        const own = await call('GET', `/api/agent-tools/${rootA}/cli`, undefined, {
          bearer: codeToken(rootA),
        });
        expectStatus(own, 200, 'owner list');
        const entry = (own.data.integrations as Array<{ id: string; status: string }>).find(
          (item) => item.id === row.id
        );
        assert(entry?.status === 'failed', 'missing template must not appear connected');
        const other = await call('GET', '/api/integrations/cli', undefined, { apiKeyUser: userB });
        expectStatus(other, 200, 'other owner list');
        assert(
          !(other.data.integrations as Array<{ id: string }>).some((item) => item.id === row.id),
          'owner isolation'
        );
        expectStatus(
          await call(
            'POST',
            `/api/agent-tools/${rootA}/cli/${row.id}/publish`,
            { name: 'YC', command: 'yc', verify: ['whoami'] },
            { bearer: codeToken(rootA) }
          ),
          400,
          'absolute command required'
        );
        expectStatus(
          await call(
            'POST',
            `/api/agent-tools/${rootA}/cli/${row.id}/run`,
            { args: ['whoami'] },
            { bearer: codeToken(rootA) }
          ),
          400,
          'execution receipt required'
        );
        const publishBody = {
          name: 'YC',
          command: '/home/user/bin/yc',
          verify: ['me', '--json'],
          install: 'install-yc-fixture',
          install_verify: ['--version'],
          credential_files: ['.yc/credentials.json'],
        };
        for (const [label, body] of [
          ['relative executable', { ...publishBody, command: 'yc' }],
          ['reserved executable', { ...publishBody, command: '/bin/bash' }],
          ['Rose executable', { ...publishBody, command: '/home/user/.rose/bin/yc' }],
          ['credential traversal', { ...publishBody, credential_files: ['../credentials'] }],
          [
            'reserved credential path',
            { ...publishBody, credential_files: ['.claude/settings.json'] },
          ],
          ['missing installation', { ...publishBody, install: undefined }],
          ['missing installation verification', { ...publishBody, install_verify: undefined }],
        ] as const) {
          expectStatus(
            await call('POST', `/api/agent-tools/${rootA}/cli/${row.id}/publish`, body, {
              bearer: codeToken(rootA),
            }),
            400,
            label
          );
        }
      } finally {
        await prisma.integration.delete({ where: { id: row.id } });
      }
    },
  },
  {
    name: 'native CLI credentials enforce exclusive live-session leases and preserve encrypted rotations',
    fn: async () => {
      // A missing encryption key is a test-environment failure, never a security-test skip.
      assert(
        Boolean(process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY),
        'CLAUDE_CREDENTIAL_DECRYPTION_KEY is required for native credential HTTP security tests'
      );
      const taskIds = [randomUUID(), randomUUID()];
      const integrationId = randomUUID();
      const credentialId = randomUUID();
      const originalFiles = [
        {
          path: '.yc/credentials.json',
          data: Buffer.from('initial-refresh-fixture').toString('base64'),
        },
      ];
      const rotatedFiles = [
        {
          path: '.yc/credentials.json',
          data: Buffer.from('rotated-refresh-fixture').toString('base64'),
        },
      ];
      const envelope = encryptProjectSecret(JSON.stringify(originalFiles));
      const auth = (agentId: string, taskId: string, userId = userA) => ({
        bearer: mintAgentToolsToken(userId, agentId, { provider: 'claude', taskId }).token,
      });
      const ownerAuth = auth(rootA, taskIds[0]);
      const otherAuth = auth(otherA, taskIds[1]);
      const endpoint = (agentId: string, operation: string) =>
        `/api/agent-tools/${agentId}/cli/${integrationId}/native/${operation}`;
      try {
        await prisma.claudeCodeSession.createMany({
          data: [rootA, otherA].map((agentId, index) => ({
            id: taskIds[index],
            agentId,
            sandboxId: `native-credential-fixture-${taskIds[index]}`,
            goal: 'native credential HTTP fixture',
            status: 'ACTIVE' as const,
          })),
        });
        await prisma.integration.create({
          data: {
            id: integrationId,
            userId: userA,
            name: 'cli',
            accountId: randomUUID(),
            type: 'TOOL_SETUP',
            status: 'CONNECTED',
            isActive: true,
            config: {
              kind: 'cli-template-v1',
              name: 'YC',
              request: 'YC CLI',
              agent_id: rootA,
              native_template: true,
              command: '/home/user/bin/yc',
              credential_files: ['.yc/credentials.json'],
            },
          },
        });
        await prisma.integration.create({
          data: {
            id: credentialId,
            userId: userA,
            name: 'cli_credentials',
            accountId: integrationId,
            type: 'TOOL_SETUP',
            status: 'CONNECTED',
            config: {
              kind: 'native-cli-credentials-v1',
              envelope,
              paths: ['.yc/credentials.json'],
            },
          },
        });
        expectStatus(
          await call('POST', endpoint(rootA, 'acquire'), {}, auth(rootA, randomUUID())),
          403,
          'missing live task'
        );
        expectStatus(
          await call('POST', endpoint(agentB, 'acquire'), {}, auth(agentB, randomUUID(), userB)),
          404,
          'another owner cannot acquire credentials'
        );
        const race = await Promise.all([
          call('POST', endpoint(rootA, 'acquire'), {}, ownerAuth),
          call('POST', endpoint(rootA, 'acquire'), {}, ownerAuth),
        ]);
        assert(
          race.filter((result) => result.status === 200).length === 1,
          'exactly one concurrent credential acquisition must win'
        );
        assert(
          race.filter((result) => result.status === 409).length === 1,
          'concurrent losing acquisition must report conflict'
        );
        const acquired = race.find((result) => result.status === 200)!;
        const leaseToken = acquired.data.lease_token;
        assert(typeof leaseToken === 'string', 'acquire returns lease token');
        assert(
          JSON.stringify(acquired.data.files) === JSON.stringify(originalFiles),
          'owner receives original files'
        );
        expectStatus(
          await call(
            'POST',
            endpoint(otherA, 'release'),
            { lease_token: leaseToken, files: rotatedFiles },
            otherAuth
          ),
          409,
          'another live caller cannot release the lease'
        );
        expectStatus(
          await call(
            'POST',
            endpoint(rootA, 'release'),
            { lease_token: randomUUID(), files: rotatedFiles },
            ownerAuth
          ),
          409,
          'wrong lease token cannot release'
        );
        for (const path of [
          '../credentials',
          '/tmp/credentials',
          '.rose/token',
          '.yc/../credentials',
        ]) {
          expectStatus(
            await call(
              'POST',
              endpoint(rootA, 'release'),
              {
                lease_token: leaseToken,
                files: [{ path, data: originalFiles[0].data }],
              },
              ownerAuth
            ),
            400,
            `invalid credential path ${path}`
          );
        }
        expectStatus(
          await call('POST', endpoint(rootA, 'heartbeat'), { lease_token: leaseToken }, ownerAuth),
          200,
          'owning session renews lease'
        );
        expectStatus(
          await call(
            'POST',
            endpoint(rootA, 'release'),
            { lease_token: leaseToken, files: rotatedFiles },
            ownerAuth
          ),
          200,
          'owning session releases rotated credentials'
        );
        const stored = await prisma.integration.findUniqueOrThrow({ where: { id: credentialId } });
        const state = stored.config as { envelope: string; paths: string[]; lease?: unknown };
        assert(!state.lease, 'successful release removes the lease');
        assert(state.envelope !== envelope, 'rotated files create a fresh encrypted envelope');
        assert(
          !state.envelope.includes(rotatedFiles[0].data),
          'stored envelope does not expose credential bytes'
        );
        assert(
          decryptProjectSecret(state.envelope) === JSON.stringify(rotatedFiles),
          'encrypted storage contains rotated credentials'
        );
        const next = await call('POST', endpoint(otherA, 'acquire'), {}, otherAuth);
        expectStatus(next, 200, 'next live caller acquires released credentials');
        assert(
          JSON.stringify(next.data.files) === JSON.stringify(rotatedFiles),
          'next acquire receives rotated files'
        );
        const leased = await prisma.integration.findUniqueOrThrow({ where: { id: credentialId } });
        const activeState = leased.config as {
          kind: string;
          envelope: string;
          paths: string[];
          lease: {
            token: string;
            agentId: string;
            taskId: string;
            expiresAt: number;
          };
        };
        await prisma.integration.update({
          where: { id: credentialId },
          data: {
            config: {
              ...activeState,
              lease: { ...activeState.lease, expiresAt: Date.now() - 1000 },
            },
          },
        });
        expectStatus(
          await call('POST', endpoint(rootA, 'acquire'), {}, ownerAuth),
          409,
          'expired lease cannot be stolen'
        );
        expectStatus(
          await call(
            'POST',
            endpoint(otherA, 'heartbeat'),
            { lease_token: next.data.lease_token },
            otherAuth
          ),
          409,
          'expired owner cannot renew'
        );
        expectStatus(
          await call(
            'POST',
            endpoint(otherA, 'release'),
            {
              lease_token: next.data.lease_token,
              files: originalFiles,
            },
            otherAuth
          ),
          409,
          'expired owner cannot overwrite newer credential state'
        );
        await prisma.claudeCodeSession.update({
          where: { id: taskIds[0] },
          data: { status: 'CLOSED' },
        });
        expectStatus(
          await call('POST', endpoint(rootA, 'acquire'), {}, ownerAuth),
          403,
          'closed task cannot acquire'
        );
      } finally {
        await prisma.integration.deleteMany({
          where: { id: { in: [credentialId, integrationId] }, userId: userA },
        });
        await prisma.claudeCodeSession.deleteMany({ where: { id: { in: taskIds } } });
      }
    },
  },
];
