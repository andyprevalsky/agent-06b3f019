/**
 * Codebase sync (C9): accept an encrypted snapshot of a local checkout from
 * `scripts/rose-sync` or the Mac app.
 *
 *   client ── GET  /sync-key ──────────► RSA public key (derived from the
 *          │                             backend credential key) + keyId
 *          ├─ GET  /:id/sync ──────────► revision, salt, stored fingerprints
 *          └─ POST /:id/sync ──────────► only changed files carry an envelope;
 *                                         unchanged ones send the fingerprint
 *
 * Content is encrypted on the client, so plaintext never crosses the API.
 * The server opens each new envelope in memory once to verify its fingerprint
 * and derive variable names, then stores the envelope unchanged.
 *
 * 10k-agent behaviour: one push touches one project's rows (≤ MAX_ENV_FILES
 * file rows + one snapshot row); revision claims are per-project.
 */
import {
  dotenvVariableNames,
  isDotenvPath,
  type EnvVariableMeta,
} from '../../providers/projects/envFile';
import { normalizeProjectPath } from '../../providers/projects/paths';
import {
  decryptProjectBinary,
  decryptProjectSecret,
  projectContentFingerprint,
  projectSyncKeyId,
  projectSyncPublicKeyPem,
  ProjectSecretsUnavailableError,
} from '../../providers/projects/secrets';
import type { ProjectSyncManifest } from '../../providers/projects/types';
import {
  MAX_ENV_FILE_BYTES,
  MAX_GIT_BUNDLE_ENVELOPE_CHARS,
  MAX_PATCH_ENVELOPE_CHARS,
} from './config';
import * as repo from './repo';
import { ProjectError, requireProject, sanitizeRepoUrl, projectDto, variablesOf } from './service';
import type { SyncFileBody, SyncPushBody } from './types';

function secretsOrThrow<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ProjectSecretsUnavailableError) {
      throw new ProjectError(503, 'Project secrets are not configured on this server');
    }
    throw err;
  }
}

export function getSyncKey() {
  return secretsOrThrow(() => ({
    keyId: projectSyncKeyId(),
    publicKeyPem: projectSyncPublicKeyPem(),
    algorithm: 'RSA-OAEP-SHA256+AES-256-GCM',
    envelopeVersion: 1,
    binaryEncoding: 'base64-then-envelope',
  }));
}

export async function getSyncState(userId: string, projectId: string) {
  const project = await requireProject(userId, projectId);
  const [files, snapshot] = await Promise.all([
    repo.listEnvFiles(project.id),
    repo.findSyncSnapshot(project.id),
  ]);
  return {
    projectId: project.id,
    revision: project.syncRevision,
    salt: project.syncSalt,
    keyId: secretsOrThrow(projectSyncKeyId),
    files: files.map((file) => ({
      path: file.path,
      kind: file.kind,
      source: file.source,
      fingerprint: file.fingerprint,
      sizeBytes: file.sizeBytes,
    })),
    gitBundleFingerprint: snapshot?.gitBundleFingerprint ?? null,
    patchFingerprint: snapshot?.patchFingerprint ?? null,
    manifest: snapshot?.manifest ?? null,
  };
}

interface PlannedFile {
  write: repo.EnvFileWrite;
  changed: boolean;
}

function planFile(
  salt: string,
  file: SyncFileBody,
  existing: repo.ProjectEnvFileRecord | undefined
): PlannedFile {
  const path = normalizeProjectPath(file.path);
  if (path === null) throw new ProjectError(400, `Invalid file path: ${file.path.slice(0, 200)}`);
  const kind = file.kind === 'env' && isDotenvPath(path) ? 'env' : 'config';
  if (file.encryptedContent === undefined) {
    if (
      !existing ||
      existing.encryptedContent === null ||
      existing.fingerprint !== file.fingerprint
    ) {
      throw new ProjectError(
        409,
        `Stale fingerprint for ${path}; resend its content`,
        'stale_fingerprint'
      );
    }
    return {
      changed: false,
      write: {
        path,
        description: existing.description,
        kind,
        source: 'sync',
        variables: variablesOf(existing),
        encryptedContent: existing.encryptedContent,
        fingerprint: existing.fingerprint,
        linkTarget: file.linkTarget ?? null,
        sizeBytes: existing.sizeBytes,
      },
    };
  }
  const plaintext = secretsOrThrow(() => decryptProjectSecret(file.encryptedContent!));
  if (plaintext === null) throw new ProjectError(400, `Envelope for ${path} could not be opened`);
  const sizeBytes = Buffer.byteLength(plaintext, 'utf8');
  if (sizeBytes > MAX_ENV_FILE_BYTES) throw new ProjectError(413, `${path} is too large`);
  if (projectContentFingerprint(salt, plaintext) !== file.fingerprint) {
    throw new ProjectError(400, `Fingerprint mismatch for ${path}`, 'fingerprint_mismatch');
  }
  const previous = existing ? variablesOf(existing) : [];
  const descriptions = new Map(previous.map((v) => [v.name, v.description]));
  const variables: EnvVariableMeta[] =
    kind === 'env'
      ? dotenvVariableNames(plaintext).map((name) => {
          const description = descriptions.get(name);
          return description !== undefined && description !== '' ? { name, description } : { name };
        })
      : [];
  return {
    changed: true,
    write: {
      path,
      description: existing?.description ?? null,
      kind,
      source: 'sync',
      variables,
      encryptedContent: file.encryptedContent,
      fingerprint: file.fingerprint,
      linkTarget: file.linkTarget ?? null,
      sizeBytes,
    },
  };
}

type Artifact = SyncPushBody['gitBundle'];

function planArtifact(
  label: string,
  artifact: Artifact,
  stored: { envelope: string | null; fingerprint: string | null },
  maxChars: number
): { envelope: string | null; fingerprint: string | null; changed: boolean } {
  if (artifact === undefined) return { ...stored, changed: false };
  if (artifact === null)
    return { envelope: null, fingerprint: null, changed: stored.envelope !== null };
  if (artifact.encrypted === undefined) {
    if (stored.fingerprint !== artifact.fingerprint || stored.envelope === null) {
      throw new ProjectError(409, `Stale ${label} fingerprint; resend it`, 'stale_fingerprint');
    }
    return { ...stored, changed: false };
  }
  if (artifact.encrypted.length > maxChars) throw new ProjectError(413, `${label} is too large`);
  const bytes = secretsOrThrow(() => decryptProjectBinary(artifact.encrypted!));
  if (bytes === null) throw new ProjectError(400, `${label} envelope could not be opened`);
  return { envelope: artifact.encrypted, fingerprint: artifact.fingerprint, changed: true };
}

function artifactStatus(a: { changed: boolean; envelope: string | null }): string {
  if (a.changed) return 'written';
  return a.envelope !== null ? 'unchanged' : 'none';
}

function sanitizeManifest(raw: Record<string, unknown>): ProjectSyncManifest {
  const manifest = { ...raw, version: 1 } as unknown as ProjectSyncManifest;
  if (manifest.git && typeof manifest.git === 'object') {
    manifest.git = { ...manifest.git, remoteUrl: sanitizeRepoUrl(manifest.git.remoteUrl) };
  }
  return manifest;
}

function validatePushPaths(files: SyncFileBody[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    const path = normalizeProjectPath(file.path);
    if (path === null) throw new ProjectError(400, `Invalid file path: ${file.path.slice(0, 200)}`);
    if (seen.has(path)) throw new ProjectError(400, `Duplicate file path: ${path}`);
    seen.add(path);
  }
}

async function planPush(project: repo.ProjectRecord, body: SyncPushBody) {
  validatePushPaths(body.files);
  const [existingFiles, snapshot] = await Promise.all([
    repo.listEnvFiles(project.id),
    repo.findSyncSnapshot(project.id),
  ]);
  const byPath = new Map(existingFiles.map((file) => [file.path, file]));
  const planned = body.files.map((file) =>
    planFile(project.syncSalt, file, byPath.get(normalizeProjectPath(file.path)!))
  );
  const bundle = planArtifact(
    'git bundle',
    body.gitBundle,
    {
      envelope: snapshot?.encryptedGitBundle ?? null,
      fingerprint: snapshot?.gitBundleFingerprint ?? null,
    },
    MAX_GIT_BUNDLE_ENVELOPE_CHARS
  );
  const patch = planArtifact(
    'uncommitted patch',
    body.uncommittedPatch,
    {
      envelope: snapshot?.encryptedUncommittedPatch ?? null,
      fingerprint: snapshot?.patchFingerprint ?? null,
    },
    MAX_PATCH_ENVELOPE_CHARS
  );
  const pushed = new Set(planned.map((p) => p.write.path));
  const pruned =
    body.prune === false
      ? []
      : existingFiles.filter((f) => f.source === 'sync' && !pushed.has(f.path)).map((f) => f.path);
  return { planned, bundle, patch, pruned, manifest: sanitizeManifest(body.manifest) };
}

export async function applySyncPush(userId: string, projectId: string, body: SyncPushBody) {
  const project = await requireProject(userId, projectId);
  if (body.keyId !== secretsOrThrow(projectSyncKeyId)) {
    throw new ProjectError(
      409,
      'Sync key rotated; fetch /api/projects/sync-key again',
      'key_rotated'
    );
  }
  if (body.baseRevision !== project.syncRevision) {
    throw new ProjectError(
      409,
      'Project changed since the last sync; re-read its state',
      'revision_conflict'
    );
  }
  const { planned, bundle, patch, pruned, manifest } = await planPush(project, body);
  const remote = manifest.git?.remoteUrl ?? null;
  const revision = await repo.claimSyncRevision(
    project.id,
    body.baseRevision,
    project.repoUrl === null && remote !== null ? { repoUrl: remote } : {}
  );
  if (revision === null) {
    throw new ProjectError(
      409,
      'Project changed since the last sync; re-read its state',
      'revision_conflict'
    );
  }
  for (const item of planned) await repo.upsertEnvFile(project.id, item.write);
  await repo.deleteEnvFilesByPath(project.id, pruned);
  await repo.writeSyncSnapshot(project.id, revision, {
    manifest,
    encryptedGitBundle: bundle.envelope,
    gitBundleFingerprint: bundle.fingerprint,
    encryptedUncommittedPatch: patch.envelope,
    patchFingerprint: patch.fingerprint,
  });
  const refreshed = await requireProject(userId, project.id);
  return {
    project: await projectDto(userId, refreshed),
    revision,
    written: planned.filter((p) => p.changed).map((p) => p.write.path),
    unchanged: planned.filter((p) => !p.changed).map((p) => p.write.path),
    deleted: pruned,
    gitBundle: artifactStatus(bundle),
    uncommittedPatch: artifactStatus(patch),
  };
}
