import assert from 'node:assert/strict';
import {
  skipProvenSteelPersistenceOutage,
  validateSteelPersistenceOutage,
  SteelProfilePersistenceLiveSkipped,
  STEEL_PROFILE_PERSISTENCE_OVERRIDE,
  runSteelAwareParity,
  type SteelPersistenceOutageEvidence,
} from './browser-provider.steel-persistence-outage.support';

function receipt(): SteelPersistenceOutageEvidence {
  return {
    failure: {
      steel_profile_id: 'profile-a',
      source_steel_session_id: 'writer-a',
      profile_not_ready_attempts: 20,
      probe_last_timestamp: '2026-11-02T17:28:29Z',
    },
    native: [
      {
        at: '2026-11-02T17:34:47Z',
        kind: 'profiles',
        id: 'profile-a',
        transport: 'same-installed-node-sdk',
        host: 'api.steel.dev',
        http_status: 200,
        fields: {
          id: 'profile-a',
          status: 'UPLOADING',
          createdAt: '2026-11-02T17:27:39Z',
          updatedAt: '2026-11-02T17:27:39Z',
        },
      },
      {
        at: '2026-11-02T17:34:48Z',
        kind: 'sessions',
        id: 'writer-a',
        transport: 'same-installed-node-sdk',
        host: 'api.steel.dev',
        http_status: 200,
        fields: { id: 'writer-a', status: 'failed', profileId: 'profile-a' },
      },
    ],
  };
}

export const steelPersistenceOutageCases: Array<[string, () => void | Promise<void>]> = [
  [
    'Steel parity reporting distinguishes success, real failure and explicit skip',
    async () => {
      const warn = console.warn;
      const error = console.error;
      console.warn = () => {};
      console.error = () => {};
      try {
        assert.deepEqual(await runSteelAwareParity(async () => {}, false), {
          failed: 0,
          skipped: false,
        });
        assert.deepEqual(
          await runSteelAwareParity(async () => {
            throw new Error('fixture defect');
          }, false),
          { failed: 1, skipped: false }
        );
        assert.deepEqual(
          await runSteelAwareParity(async () => {
            throw new SteelProfilePersistenceLiveSkipped('explicit outage');
          }, false),
          { failed: 0, skipped: true }
        );
      } finally {
        console.warn = warn;
        console.error = error;
      }
    },
  ],
  [
    'Steel persistence live override requires explicit token and retained native evidence',
    () => {
      let loads = 0;
      skipProvenSteelPersistenceOutage({}, () => {
        loads++;
        return '';
      });
      skipProvenSteelPersistenceOutage(
        { DEPLOY_GATE_OVERRIDES: 'browser-provider:tilion-residential-live' },
        () => {
          loads++;
          return '';
        }
      );
      assert.equal(loads, 0);
      assert.throws(
        () =>
          skipProvenSteelPersistenceOutage({
            DEPLOY_GATE_OVERRIDES: STEEL_PROFILE_PERSISTENCE_OVERRIDE,
          }),
        /requires retained exact-resource evidence/
      );
      assert.throws(
        () =>
          skipProvenSteelPersistenceOutage(
            {
              DEPLOY_GATE_OVERRIDES: STEEL_PROFILE_PERSISTENCE_OVERRIDE,
              STEEL_PROFILE_PERSISTENCE_OUTAGE_EVIDENCE: 'retained.json',
            },
            () => JSON.stringify(receipt())
          ),
        (error: unknown) =>
          error instanceof SteelProfilePersistenceLiveSkipped &&
          error.message.includes('NOT a pass')
      );
    },
  ],
  [
    'Steel persistence outage evidence fails closed on healthy, foreign, early, missing or unauthorized observations',
    () => {
      const changes: Array<(data: SteelPersistenceOutageEvidence) => void> = [
        (data) => {
          data.native[0]!.fields.status = 'READY';
        },
        (data) => {
          data.native[1]!.fields.status = 'live';
        },
        (data) => {
          data.native[1]!.fields.status = 'released';
        },
        (data) => {
          data.native[1]!.fields.profileId = 'foreign';
        },
        (data) => {
          data.failure.source_steel_session_id = 'foreign';
        },
        (data) => {
          data.failure.steel_profile_id = 'foreign';
        },
        (data) => {
          data.native[0]!.fields.id = 'foreign';
        },
        (data) => {
          data.native[0]!.http_status = 403;
        },
        (data) => {
          data.native[1]!.http_status = 404;
        },
        (data) => {
          data.native[0]!.transport = 'python';
        },
        (data) => {
          data.native[0]!.host = 'foreign';
        },
        (data) => {
          data.native[0]!.at = data.failure.probe_last_timestamp;
        },
        (data) => {
          data.native[0]!.fields.updatedAt = '2026-11-02T17:35:00Z';
        },
        (data) => {
          data.failure.profile_not_ready_attempts = 0;
        },
        (data) => {
          data.failure.probe_last_timestamp = 'invalid';
        },
        (data) => {
          data.native = [];
        },
      ];
      validateSteelPersistenceOutage(receipt());
      for (const change of changes) {
        const data = receipt();
        change(data);
        assert.throws(() => validateSteelPersistenceOutage(data));
      }
      assert.throws(
        () =>
          skipProvenSteelPersistenceOutage(
            {
              DEPLOY_GATE_OVERRIDES: STEEL_PROFILE_PERSISTENCE_OVERRIDE,
              STEEL_PROFILE_PERSISTENCE_OUTAGE_EVIDENCE: 'retained.json',
            },
            () => 'not JSON'
          ),
        (error: unknown) => !(error instanceof SteelProfilePersistenceLiveSkipped)
      );
    },
  ],
];
