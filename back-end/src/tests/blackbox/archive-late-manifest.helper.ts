import assert from 'node:assert';
import {
  decryptAndValidateArtifact,
  encryptArtifact,
  readArchivedArtifact,
} from '../../providers/traceArchive';
import { readPlainArchivedArtifact } from '../../providers/traceArchiveStrict';

export async function assertLateArchiveBatchConvergence(params: {
  baseUrl: string;
  headers: Record<string, string>;
  rootAgentId: string;
}): Promise<void> {
  const artifacts = Array.from({ length: 6 }, (_, index) => {
    const artifactPath = `media/browser/batch-test/frame-${index}.txt`;
    const value = Buffer.from(`frame ${index}`);
    const encrypted = encryptArtifact(artifactPath, value, 'text/plain');
    assert(encrypted);
    return {
      path: artifactPath,
      ciphertextB64: encrypted.ciphertext.toString('base64'),
      metadata: encrypted.metadata,
    };
  });
  const submit = (body: unknown, headers = params.headers) =>
    fetch(`${params.baseUrl}/api/archive/artifacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  const batch = { rootAgentId: params.rootAgentId, artifacts };
  assert.strictEqual((await submit(batch, { 'Content-Type': 'application/json' })).status, 401);
  const malformed: unknown[] = [
    null,
    { ...batch, rootAgentId: '../another-root' },
    { ...batch, artifacts: [] },
    { ...batch, artifacts: Array.from({ length: 257 }, () => artifacts[0]) },
    { ...batch, artifacts: [artifacts[0], artifacts[0]] },
    { ...batch, artifacts: [artifacts[0], { ...artifacts[1], rootAgentId: 'another-root' }] },
    { ...batch, artifacts: [artifacts[0], { ...artifacts[1], path: '../unsafe.txt' }] },
    { ...batch, artifacts: [artifacts[0], { ...artifacts[1], ciphertextB64: 'not base64!' }] },
    {
      ...batch,
      artifacts: [
        artifacts[0],
        { ...artifacts[1], metadata: { ...artifacts[1].metadata, aad: 'wrong' } },
      ],
    },
    {
      ...batch,
      artifacts: [
        artifacts[0],
        { ...artifacts[1], metadata: { ...artifacts[1].metadata, extra: 'x'.repeat(8193) } },
      ],
    },
  ];
  for (const body of malformed) {
    assert.strictEqual((await submit(body)).status, 400, 'invalid batch was accepted');
    for (const artifact of artifacts) {
      assert.strictEqual(
        await readArchivedArtifact({ rootAgentId: params.rootAgentId, objectPath: artifact.path }),
        null,
        'whole-batch validation must precede the first write'
      );
    }
  }
  const response = await submit(batch);
  assert.strictEqual(response.status, 200);
  const acknowledgement = (await response.json()) as { artifacts: { path: string; ref: string }[] };
  assert.deepStrictEqual(
    acknowledgement.artifacts.map((item) => item.path),
    artifacts.map((item) => item.path)
  );
  for (const [index, artifact] of artifacts.entries()) {
    const stored = await readArchivedArtifact({
      rootAgentId: params.rootAgentId,
      objectPath: artifact.path,
    });
    assert(stored);
    assert.strictEqual(decryptAndValidateArtifact(stored).toString(), `frame ${index}`);
    assert.deepStrictEqual(stored.metadata, artifact.metadata);
  }
  // Replay an acknowledged batch idempotently, keeping identical individual envelopes.
  assert.strictEqual((await submit(batch)).status, 200);
  const encrypted = await readArchivedArtifact({
    rootAgentId: params.rootAgentId,
    objectPath: 'manifest.json.gz.enc',
  });
  assert(encrypted);
  const publicBody = await readPlainArchivedArtifact({
    rootAgentId: params.rootAgentId,
    objectPath: 'manifest.public.json',
  });
  assert(publicBody);
  for (const body of [decryptAndValidateArtifact(encrypted), publicBody]) {
    const manifest = JSON.parse(body.toString()) as { artifacts: { path: string }[] };
    for (const artifact of artifacts) {
      assert.strictEqual(
        manifest.artifacts.filter((item) => item.path === artifact.path).length,
        1,
        'both finalized manifests must include every batch artifact exactly once'
      );
    }
  }
}

export async function assertLateArchiveManifestConvergence(params: {
  baseUrl: string;
  headers: Record<string, string>;
  rootAgentId: string;
}): Promise<void> {
  const latePath = 'llm/late-after-finalize-planner.json.gz.enc';
  const lateEncrypted = encryptArtifact(latePath, Buffer.from('{"late":true}'), 'application/json');
  assert(lateEncrypted);
  const response = await fetch(`${params.baseUrl}/api/archive/artifact`, {
    method: 'POST',
    headers: params.headers,
    body: JSON.stringify({
      rootAgentId: params.rootAgentId,
      path: latePath,
      ciphertextB64: lateEncrypted.ciphertext.toString('base64'),
      metadata: lateEncrypted.metadata,
    }),
  });
  assert.strictEqual(response.status, 200, (await response.text()).slice(0, 300));

  const encryptedArtifact = await readArchivedArtifact({
    rootAgentId: params.rootAgentId,
    objectPath: 'manifest.json.gz.enc',
  });
  assert(encryptedArtifact);
  const encryptedManifest = JSON.parse(
    decryptAndValidateArtifact(encryptedArtifact).toString('utf8')
  ) as { artifacts: { path: string }[] };
  assert(
    encryptedManifest.artifacts.some((ref) => ref.path === latePath),
    'encrypted manifest did not converge on the late worker artifact'
  );

  const publicBody = await readPlainArchivedArtifact({
    rootAgentId: params.rootAgentId,
    objectPath: 'manifest.public.json',
  });
  assert(publicBody);
  const publicManifest = JSON.parse(publicBody.toString('utf8')) as {
    artifacts: { path: string }[];
  };
  assert(
    publicManifest.artifacts.some((ref) => ref.path === latePath),
    'public manifest did not converge on the late worker artifact'
  );
}
