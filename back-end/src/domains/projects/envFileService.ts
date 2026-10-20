/**
 * Project env files: managed dotenv files whose values exist only inside
 * credential envelopes. Add / edit values / remove variables / rename /
 * delete, and search by variable name, file path or description (never by
 * value). Responses carry names and descriptions only.
 */
import {
  applyVariableEdits,
  dotenvVariableNames,
  isDotenvPath,
  mergeVariableMeta,
} from '../../providers/projects/envFile';
import { normalizeProjectPath } from '../../providers/projects/paths';
import {
  decryptProjectSecret,
  encryptProjectSecret,
  projectContentFingerprint,
  ProjectSecretsUnavailableError,
} from '../../providers/projects/secrets';
import { MAX_ENV_FILES } from '../../providers/projects/store';
import { MAX_ENV_FILE_BYTES } from './config';
import * as repo from './repo';
import {
  ProjectError,
  requireProject,
  toEnvFileDto,
  variablesOf,
  type EnvFileDto,
} from './service';
import type { CreateEnvFileBody, UpdateEnvFileBody } from './types';

function managedPath(raw: string): string {
  const path = normalizeProjectPath(raw);
  if (path === null) throw new ProjectError(400, 'Invalid env file path');
  if (!isDotenvPath(path)) {
    throw new ProjectError(
      400,
      'Env file names must be .env, .env.*, *.env, .dev.vars or .flaskenv',
      'invalid_env_file_name'
    );
  }
  return path;
}

function matchesQuery(file: repo.ProjectEnvFileRecord, q: string): EnvFileDto | null {
  const dto = toEnvFileDto(file);
  const needle = q.toLowerCase();
  const matches = dto.variables
    .filter(
      (v) =>
        v.name.toLowerCase().includes(needle) ||
        (v.description ?? '').toLowerCase().includes(needle)
    )
    .map((v) => v.name);
  const fileHit =
    dto.path.toLowerCase().includes(needle) ||
    (dto.description ?? '').toLowerCase().includes(needle);
  if (!fileHit && matches.length === 0) return null;
  return { ...dto, matches };
}

/** List or search (names, paths, descriptions; never values). */
export async function listEnvFiles(
  userId: string,
  projectId: string,
  q?: string
): Promise<{ envFiles: EnvFileDto[]; query: string | null }> {
  const project = await requireProject(userId, projectId);
  const files = await repo.listEnvFiles(project.id);
  const query = q?.trim() ?? '';
  if (query === '') return { envFiles: files.map(toEnvFileDto), query: null };
  return {
    envFiles: files.flatMap((file) => {
      const hit = matchesQuery(file, query);
      return hit ? [hit] : [];
    }),
    query,
  };
}

function encryptContent(salt: string, content: string) {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  if (sizeBytes > MAX_ENV_FILE_BYTES) throw new ProjectError(413, 'Env file is too large');
  try {
    return {
      encryptedContent: encryptProjectSecret(content),
      fingerprint: projectContentFingerprint(salt, content),
      sizeBytes,
    };
  } catch (err) {
    if (err instanceof ProjectSecretsUnavailableError) {
      throw new ProjectError(503, 'Project secrets are not configured on this server');
    }
    throw err;
  }
}

function decryptStored(file: repo.ProjectEnvFileRecord): string {
  if (file.encryptedContent === null) return '';
  const plaintext = decryptProjectSecret(file.encryptedContent);
  if (plaintext === null) throw new ProjectError(500, 'Stored env file could not be decrypted');
  return plaintext;
}

export async function createEnvFile(
  userId: string,
  projectId: string,
  body: CreateEnvFileBody
): Promise<EnvFileDto> {
  const project = await requireProject(userId, projectId);
  const path = managedPath(body.path);
  if (await repo.findEnvFile(project.id, path)) {
    throw new ProjectError(409, 'This env file is already managed');
  }
  if ((await repo.countEnvFiles(project.id)) >= MAX_ENV_FILES) {
    throw new ProjectError(400, `A project can manage at most ${MAX_ENV_FILES} env files`);
  }
  const edits = body.variables ?? [];
  if (body.declared === true) {
    const names = edits.map((edit) => edit.name);
    const file = await repo.upsertEnvFile(project.id, {
      path,
      description: body.description ?? null,
      kind: 'env',
      source: 'declared',
      variables: mergeVariableMeta(names, [], edits),
      encryptedContent: null,
      fingerprint: null,
      sizeBytes: 0,
    });
    return toEnvFileDto(file);
  }
  const content = applyVariableEdits(body.content ?? '', edits);
  const file = await repo.upsertEnvFile(project.id, {
    path,
    description: body.description ?? null,
    kind: 'env',
    source: 'managed',
    variables: mergeVariableMeta(dotenvVariableNames(content), [], edits),
    ...encryptContent(project.syncSalt, content),
  });
  return toEnvFileDto(file);
}

export async function updateEnvFile(
  userId: string,
  projectId: string,
  fileId: string,
  body: UpdateEnvFileBody
): Promise<EnvFileDto> {
  const project = await requireProject(userId, projectId);
  const file = await repo.findEnvFileById(project.id, fileId);
  if (!file) throw new ProjectError(404, 'Env file not found');
  const path = body.path !== undefined ? managedPath(body.path) : file.path;
  if (path !== file.path && (await repo.findEnvFile(project.id, path))) {
    throw new ProjectError(409, 'Another env file already uses this path');
  }
  const edits = body.variables ?? [];
  const base = body.content ?? decryptStored(file);
  const content = applyVariableEdits(base, edits, body.removeVariables ?? []);
  const touchesValues =
    body.content !== undefined ||
    edits.some((e) => e.value !== undefined) ||
    !!body.removeVariables;
  const keepDeclared = file.source === 'declared' && !touchesValues;
  const previous = variablesOf(file);
  const names = keepDeclared
    ? [...new Set([...previous.map((v) => v.name), ...edits.map((e) => e.name)])]
    : dotenvVariableNames(content);
  const write: repo.EnvFileWrite = {
    path,
    description: body.description !== undefined ? body.description : file.description,
    kind: file.kind === 'config' ? 'config' : 'env',
    source: keepDeclared ? 'declared' : 'managed',
    variables: mergeVariableMeta(names, previous, edits),
    linkTarget: file.linkTarget,
    ...(keepDeclared
      ? { encryptedContent: null, fingerprint: null, sizeBytes: 0 }
      : encryptContent(project.syncSalt, content)),
  };
  if (path !== file.path) await repo.deleteEnvFile(file.id);
  return toEnvFileDto(await repo.upsertEnvFile(project.id, write));
}

export async function deleteEnvFile(
  userId: string,
  projectId: string,
  fileId: string
): Promise<void> {
  const project = await requireProject(userId, projectId);
  const file = await repo.findEnvFileById(project.id, fileId);
  if (!file) throw new ProjectError(404, 'Env file not found');
  await repo.deleteEnvFile(file.id);
}
