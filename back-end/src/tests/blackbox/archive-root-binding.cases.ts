/**
 * Worker-posted archive artifacts land in the ROOT bundle, never a disjoint
 * sub-agent bundle, and unbound roots are rejected with 400.
 *
 *   POST /api/archive/artifact(s) { rootAgentId: <child id> }
 *        └─► stored under trace-archive/<root id>/…  (nothing under <child id>)
 *   POST { rootAgentId: 'unbound' | '' } ─► 400
 */
import assert from 'node:assert/strict';
import { encryptArtifact, listArchivedObjects } from '../../providers/traceArchive';
import { request } from './archive-blackbox.support';

interface RootBindingSeed {
  rootAgentId: string;
  childAgentId: string;
}

function encrypted(path: string) {
  const artifact = encryptArtifact(
    path,
    Buffer.from(JSON.stringify({ schema_version: 2, record: 'start', path })),
    'application/json'
  );
  assert(artifact, 'trace archive encryption must be configured for blackbox');
  return {
    path,
    ciphertextB64: artifact.ciphertext.toString('base64'),
    metadata: artifact.metadata,
  };
}

export async function assertWorkerArtifactsFiledUnderTrueRoot(
  baseUrl: string,
  apiKey: string,
  seed: RootBindingSeed
): Promise<void> {
  const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };
  const singlePath = `llm/child-single-${seed.childAgentId}.json.gz.enc`;
  const single = await request(`${baseUrl}/api/archive/artifact`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ rootAgentId: seed.childAgentId, ...encrypted(singlePath) }),
  });
  assert.equal(single.status, 200, JSON.stringify(single.data).slice(0, 300));

  const batchPath = `llm-updates/child-batch-${seed.childAgentId}-1-test.json.gz.enc`;
  const batch = await request(`${baseUrl}/api/archive/artifacts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ rootAgentId: seed.childAgentId, artifacts: [encrypted(batchPath)] }),
  });
  assert.equal(batch.status, 200, JSON.stringify(batch.data).slice(0, 300));

  const rootPaths = (await listArchivedObjects(seed.rootAgentId, { throwOnError: true })).map(
    (object) => object.path
  );
  assert(rootPaths.includes(singlePath), `single artifact must land in the root bundle`);
  assert(rootPaths.includes(batchPath), `batch artifact must land in the root bundle`);
  assert.deepEqual(
    await listArchivedObjects(seed.childAgentId, { throwOnError: true }),
    [],
    'no disjoint sub-agent bundle may be created'
  );

  for (const rootAgentId of ['unbound', '', 'None']) {
    const refused = await request(`${baseUrl}/api/archive/artifact`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rootAgentId, ...encrypted('llm/unbound.json.gz.enc') }),
    });
    assert.equal(refused.status, 400, `single ${JSON.stringify(rootAgentId)} must be refused`);
    const refusedBatch = await request(`${baseUrl}/api/archive/artifacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rootAgentId, artifacts: [encrypted('llm/unbound.json.gz.enc')] }),
    });
    assert.equal(refusedBatch.status, 400, `batch ${JSON.stringify(rootAgentId)} must be refused`);
  }
  assert.deepEqual(await listArchivedObjects('unbound', { throwOnError: true }), []);
}
