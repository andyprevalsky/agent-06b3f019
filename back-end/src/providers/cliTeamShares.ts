/**
 * Team-shared CLI connections (docs/plans/active/share-all-integrations.md).
 *
 *   teammate's code agent ──rose cli list──► own CLIs + CLIs shared with its teams
 *   teammate's code agent ──rose cli run───► the OWNER's template sandbox runs it
 *                                            (legacy proxied path, owner's lease)
 *                                            └► output scrubbed of every value in the
 *                                               owner's credential bundle
 *   native credential lease (acquire) ──────► refused: credential files never leave
 *                                            the owner's environment
 *
 * A native-template CLI keeps its login only in its owner's own code sessions,
 * which cannot run commands for a teammate, so running it returns a clear error
 * instead of leasing credentials. Every call revalidates the grant
 * (resolveTeamDataAccess): unshare, disconnect, an invited-only reader or an
 * owner who left the team ends access at once.
 *
 * 10k agents: one grant query and one indexed read per call; no polling.
 */
import { prisma } from './database';
import { resolveTeamDataAccess } from './teamAccess';
import { CliIntegrationError, cliConfig, cliView } from './cliIntegrations';
import { cliCredentialFileValues } from './cliNativeCredentials';
import type { CliResult } from './cliTemplate';

export interface CliShare {
  team_id: string;
  team_name: string;
  owner_user_id: string;
  owner_name: string | null;
}

/** Why a teammate cannot run a shared native-template CLI (no credential lease instead). */
export const SHARED_NATIVE_CLI_UNAVAILABLE =
  "This shared CLI keeps its login in its owner's environment, which cannot run commands for teammates yet. Ask the owner to run it, or connect the CLI yourself.";
/** A shared CLI whose owner login was never captured: its output cannot be scrubbed. */
export const SHARED_CLI_UNPROTECTED =
  'This shared CLI has no stored login Rose can keep out of its output, so it cannot run for teammates. Ask the owner to connect the CLI again.';
/** Why acquire refuses a teammate: shared credentials are never leased out. */
export const SHARED_CLI_CREDENTIALS_REFUSED =
  "Shared CLI credentials never leave their owner's environment; use rose cli run for a shared CLI.";
const REDACTED = '[redacted]';
/** Shorter fragments are too common to redact without destroying ordinary output. */
const MIN_SECRET_LENGTH = 8;

async function cliGrants(userId: string, integrationId?: string) {
  return (await resolveTeamDataAccess(userId)).filter(
    (grant) =>
      grant.provider === 'cli' &&
      grant.ownerUserId !== userId &&
      (integrationId === undefined || grant.integrationId === integrationId)
  );
}

function shareOf(grant: {
  teamId: string;
  teamName: string;
  ownerUserId: string;
  ownerName: string | null;
}): CliShare {
  return {
    team_id: grant.teamId,
    team_name: grant.teamName,
    owner_user_id: grant.ownerUserId,
    owner_name: grant.ownerName,
  };
}

/** The connection `userId` may run: their own, else one a teammate currently shares. */
export async function usableCliIntegration(userId: string, id: string) {
  const own = await prisma.integration.findFirst({
    where: { id, userId, name: 'cli', type: 'TOOL_SETUP' },
  });
  if (own !== null && cliConfig(own.config) !== null) return { row: own, shared: null };
  const [grant] = await cliGrants(userId, id);
  const row =
    grant === undefined
      ? null
      : await prisma.integration.findFirst({
          where: { id, userId: grant.ownerUserId, name: 'cli', type: 'TOOL_SETUP' },
        });
  if (grant === undefined || row === null || cliConfig(row.config) === null)
    throw new CliIntegrationError(404, 'CLI connection not found');
  return { row, shared: shareOf(grant) };
}

/** True when `integrationId` is a CLI a teammate shares with `userId` (not their own). */
export async function isSharedCliFor(userId: string, integrationId: string): Promise<boolean> {
  return (await cliGrants(userId, integrationId)).length > 0;
}

/** CLIs teammates share with `userId`, as list entries marked `shared`. */
export async function listSharedCliIntegrations(userId: string) {
  const grants = await cliGrants(userId);
  if (grants.length === 0) return [];
  const rows = await prisma.integration.findMany({
    where: { id: { in: grants.map((grant) => grant.integrationId) }, name: 'cli' },
    take: 200,
  });
  const sessionIds = rows.flatMap((row) => {
    const id = cliConfig(row.config)?.code_session_id;
    return typeof id === 'string' ? [id] : [];
  });
  // A connection with no stored bundle has unknown secrets: it never runs for teammates.
  const bundles = await prisma.integration.findMany({
    where: {
      name: 'cli_credentials',
      OR: rows.map((row) => ({ userId: row.userId, accountId: row.id })),
    },
    select: { userId: true, accountId: true },
  });
  const sessions = sessionIds.length
    ? await prisma.codeSession.findMany({
        where: {
          id: { in: sessionIds },
          state: { not: 'RETIRED' },
          sandboxKind: 'e2b',
          sandboxId: { not: null },
        },
        select: { id: true, userId: true },
      })
    : [];
  return grants.flatMap((grant) => {
    const row = rows.find(
      (candidate) => candidate.id === grant.integrationId && candidate.userId === grant.ownerUserId
    );
    const config = row === undefined ? null : cliConfig(row.config);
    if (row === undefined || config === null) return [];
    const view = { ...cliView(row), shared: shareOf(grant) };
    if (config.native_template === true)
      return [{ ...view, status: 'failed', error: SHARED_NATIVE_CLI_UNAVAILABLE }];
    if (!bundles.some((item) => item.userId === row.userId && item.accountId === row.id))
      return [{ ...view, status: 'failed', error: SHARED_CLI_UNPROTECTED }];
    const session = sessions.find((candidate) => candidate.id === config.code_session_id);
    if (session?.userId !== row.userId)
      return [
        {
          ...view,
          status: 'failed',
          error: 'Template unavailable. Ask the owner to connect this CLI again.',
        },
      ];
    return [view];
  });
}

function credentialStrings(text: string): string[] {
  const values = [text.trim()];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    values.push(trimmed);
    const assignment = /^[^=:]+[=:]\s*(.+)$/.exec(trimmed);
    if (assignment) values.push(assignment[1].replace(/^["']|["'],?$/g, '').trim());
  }
  const leaves = (value: unknown): void => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(leaves);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(leaves);
  };
  try {
    leaves(JSON.parse(text) as unknown);
  } catch {
    // Not JSON: whole-file, line and key=value values above cover it.
  }
  return values;
}

/**
 * Every value of the owner's credential bundle for this connection, longest first.
 * Without a bundle the secrets are unknown, so the shared run is refused (fail closed).
 */
export async function sharedCliSecrets(ownerUserId: string, integrationId: string) {
  const texts = await cliCredentialFileValues(ownerUserId, integrationId);
  if (texts === null) throw new CliIntegrationError(409, SHARED_CLI_UNPROTECTED);
  return [
    ...new Set(texts.flatMap(credentialStrings).filter((v) => v.length >= MIN_SECRET_LENGTH)),
  ].sort((a, b) => b.length - a.length);
}

/** Replace every owner secret (longest first) in a shared CLI's output. */
export function scrubCliResult(result: CliResult, secrets: string[]): CliResult {
  const scrub = (text: string) =>
    secrets.reduce((out, secret) => out.split(secret).join(REDACTED), text);
  return {
    exit_code: result.exit_code,
    stdout: scrub(result.stdout),
    stderr: scrub(result.stderr),
  };
}
