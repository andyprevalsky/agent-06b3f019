/**
 * Shared team fixture for the teams-capabilities-* black-box domains: a teammate's
 * agent using the owner's shared GitHub repo, compute subscription and CLI.
 *
 *   team "lead" (OWNER) ── owner (MEMBER, shares) ── reader (MEMBER, uses)
 *                       └─ invited (INVITED only)      outsider: no team
 *
 * Teams state changes go through the real /api/teams HTTP routes. Provider
 * functions called in this process see the same grants: the teams resolver is
 * registered here exactly as server.ts registers it at boot.
 */
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  publicEncrypt,
  constants,
} from 'node:crypto';
import { prisma } from '../../providers/database';
import { registerTeamAccess, resolveTeamDataAccess } from '../../providers/teamAccess';
import * as teamsService from '../../domains/teams/service';
import { join, request, team, user, type User } from './teams-harness';

registerTeamAccess(teamsService);

export interface TeamFixture {
  lead: User;
  owner: User;
  reader: User;
  invited: User;
  outsider: User;
  teamId: string;
}

/** A fresh team where `owner` and `reader` are accepted members and `invited` is only invited. */
export async function teamFixture(label: string): Promise<TeamFixture> {
  const [lead, owner, reader, invited, outsider] = await Promise.all([
    user(`${label} lead`),
    user(`${label} owner`),
    user(`${label} reader`),
    user(`${label} invited`),
    user(`${label} outsider`),
  ]);
  const teamId = String((await team(lead, `${label} team`)).id);
  await join(lead, owner, teamId);
  await join(lead, reader, teamId);
  await request(lead, `/${teamId}/invites`, 'POST', { email: invited.email }, 201);
  return { lead, owner, reader, invited, outsider, teamId };
}

export async function share(f: TeamFixture, integrationId: string): Promise<void> {
  await request(f.owner, `/${f.teamId}/integrations/${integrationId}`, 'PUT', {});
}

export async function unshare(f: TeamFixture, integrationId: string): Promise<void> {
  await request(f.owner, `/${f.teamId}/integrations/${integrationId}`, 'DELETE', undefined, 204);
}

/** The owner leaves the team themself (their shares are removed with the membership). */
export async function ownerLeaves(f: TeamFixture): Promise<void> {
  const detail = await request(f.owner, `/${f.teamId}`);
  const member = (detail.members as Array<{ id: string; userId: string | null }>).find(
    (row) => row.userId === f.owner.userId
  );
  if (member === undefined) throw new Error('owner membership missing');
  await request(f.owner, `/${f.teamId}/members/${member.id}`, 'DELETE', undefined, 204);
}

/** The owner rejoins (a fresh membership never restores an earlier share). */
export async function ownerRejoins(f: TeamFixture): Promise<void> {
  await join(f.lead, f.owner, f.teamId);
}

export async function grantCount(userId: string, provider: string): Promise<number> {
  return (await resolveTeamDataAccess(userId)).filter((grant) => grant.provider === provider)
    .length;
}

/** A credential envelope decryptCredentialEnvelope() opens (CLAUDE_CREDENTIAL_DECRYPTION_KEY). */
export function encryptComputeEnvelope(plaintext: string): string {
  const keyB64 = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY ?? '';
  if (keyB64 === '') throw new Error('CLAUDE_CREDENTIAL_DECRYPTION_KEY is required');
  const publicPem = createPublicKey(createPrivateKey(Buffer.from(keyB64, 'base64').toString()))
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const body = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const encryptedKey = publicEncrypt(
    { key: publicPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey
  );
  return Buffer.from(
    JSON.stringify({
      version: 1,
      encrypted_aes_key: encryptedKey.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: body.toString('base64'),
    })
  ).toString('base64');
}

/** A connected compute account (accountId set, so it is individually shareable). */
export async function seedCompute(
  userId: string,
  name: 'claude_code' | 'gpt_code',
  accessToken = `${name === 'claude_code' ? 'sk-ant-oat' : 'gpt'}-teamcap-${randomUUID()}`
) {
  const accountId = `teamcap-acct-${randomUUID()}`;
  const plaintext =
    name === 'claude_code'
      ? { claudeAiOauth: { accessToken, refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } }
      : { auth_mode: 'chatgpt', tokens: { access_token: accessToken, account_id: accountId } };
  const row = await prisma.integration.create({
    data: {
      userId,
      name,
      accountId,
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
      poolingEnabled: false,
      config: { encryptedCredentials: encryptComputeEnvelope(JSON.stringify(plaintext)) },
    },
  });
  return { id: row.id, accessToken, accountId };
}

export { randomUUID };
