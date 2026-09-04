import assert from 'node:assert';
import {
  decryptAndValidateArtifact,
  encryptArtifact,
  readArchivedArtifact,
} from '../../providers/traceArchive';
import { readPlainArchivedArtifact } from '../../providers/traceArchiveStrict';

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
