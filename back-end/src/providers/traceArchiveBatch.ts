import {
  type EncryptedArtifactMetadata,
  safeArchivePath,
  validateEncryptedArtifactEnvelope,
} from './traceArchive';
import { isBoundArchiveId } from './llmArchiveRecord';
import { ARCHIVE_MAX_CIPHERTEXT_BYTES, ARCHIVE_MAX_PLAINTEXT_BYTES } from './traceArchiveEnvelope';

export interface StoreEncryptedArtifactRequest {
  rootAgentId: string;
  path: string;
  ciphertextB64: string;
  metadata: EncryptedArtifactMetadata;
}

export const ARCHIVE_BATCH_MAX_RECORDS = 256;
/** One maximal record (72 MiB ciphertext → 96 MiB base64) fits a batch alone, under 100mb JSON. */
export const ARCHIVE_BATCH_MAX_BYTES = 96 * 1024 * 1024 + 64 * 1024;
const ARCHIVE_MAX_CIPHERTEXT_B64_CHARS = Math.ceil(ARCHIVE_MAX_CIPHERTEXT_BYTES / 3) * 4;

export interface StoreEncryptedArtifactsRequest {
  rootAgentId: string;
  artifacts: Omit<StoreEncryptedArtifactRequest, 'rootAgentId'>[];
}

/** Validate the entire request before writing any artifact or finalization fence. */
export function validatedArtifactBatch(input: unknown) {
  if (input === null || typeof input !== 'object') {
    throw new Error('Archive batch must be an object');
  }
  const body = input as StoreEncryptedArtifactsRequest;
  if (
    typeof body.rootAgentId !== 'string' ||
    !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,95}$/.test(body.rootAgentId)
  ) {
    throw new Error('Archive batch requires one canonical rootAgentId');
  }
  if (!isBoundArchiveId(body.rootAgentId)) {
    throw new Error('Archive batch requires a bound rootAgentId');
  }
  if (
    !Array.isArray(body.artifacts) ||
    body.artifacts.length === 0 ||
    body.artifacts.length > ARCHIVE_BATCH_MAX_RECORDS
  ) {
    throw new Error('Archive batch record count exceeds bounds');
  }
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > ARCHIVE_BATCH_MAX_BYTES) {
    throw new Error('Archive batch byte count exceeds bounds');
  }
  const paths = new Set<string>();
  const artifacts = body.artifacts.map((artifact) => {
    if (
      artifact === null ||
      typeof artifact !== 'object' ||
      'rootAgentId' in artifact ||
      typeof artifact.path !== 'string' ||
      artifact.path.length === 0 ||
      artifact.path.length > 4096 ||
      safeArchivePath(artifact.path) !== artifact.path ||
      artifact.path.endsWith('.meta.json') ||
      artifact.path.endsWith('.transaction') ||
      /\.transaction\.\d+(?:\.\d+)?\.tmp$/.test(artifact.path) ||
      paths.has(artifact.path)
    ) {
      throw new Error('Archive batch paths must be canonical and unique within one root');
    }
    paths.add(artifact.path);
    if (
      typeof artifact.ciphertextB64 !== 'string' ||
      artifact.ciphertextB64.length === 0 ||
      artifact.ciphertextB64.length > ARCHIVE_MAX_CIPHERTEXT_B64_CHARS
    ) {
      throw new Error('Archive batch ciphertext must be canonical base64');
    }
    if (
      artifact.metadata === null ||
      typeof artifact.metadata !== 'object' ||
      Buffer.byteLength(JSON.stringify(artifact.metadata), 'utf8') > 8192
    ) {
      throw new Error('Archive batch metadata exceeds bounds');
    }
    const ciphertext = Buffer.from(artifact.ciphertextB64, 'base64');
    if (
      ciphertext.length > ARCHIVE_MAX_CIPHERTEXT_BYTES ||
      ciphertext.toString('base64') !== artifact.ciphertextB64
    ) {
      throw new Error('Archive batch ciphertext exceeds bounds');
    }
    const metadata = validateEncryptedArtifactEnvelope({
      objectPath: artifact.path,
      ciphertext,
      metadata: artifact.metadata,
    });
    if (metadata.plaintext_bytes > ARCHIVE_MAX_PLAINTEXT_BYTES) {
      throw new Error('Archive batch plaintext byte count exceeds bounds');
    }
    return { objectPath: artifact.path, ciphertext, metadata };
  });
  return { rootAgentId: body.rootAgentId, artifacts };
}
