import * as repo from './repo';
import { CONTACT_LIMIT } from './config';
import { normalizedEmail, TeamError } from './types';
import { requireUser } from './serviceIdentity';
export async function contacts(userId: string, q: string) {
  await requireUser(userId);
  const query = q.trim().toLowerCase();
  if (query.length > 254) throw new TeamError(400, 'Query is too long');
  const rows = await repo.contactRows(userId, query);
  const candidates = new Map<string, { name: string | null; email: string }>();
  for (const row of rows) {
    const emails: unknown[] = [
      row.email,
      ...(Array.isArray(row.emailAddresses) ? row.emailAddresses : []),
    ];
    for (const value of emails) {
      const raw =
        typeof value === 'object' && value !== null && 'email' in value ? value.email : value;
      try {
        const email = normalizedEmail(raw);
        const name = `${row.firstName} ${row.lastName}`.trim() || null;
        if (!query || email.includes(query) || name?.toLowerCase().includes(query) === true)
          candidates.set(email, { name, email });
      } catch {
        /* Contact records may have missing/malformed email fields. */
      }
    }
  }
  try {
    const email = normalizedEmail(query);
    candidates.set(email, candidates.get(email) ?? { name: null, email });
  } catch {
    /* Partial queries only search the caller's contacts. */
  }
  const selected = [...candidates.values()].slice(0, CONTACT_LIMIT);
  const users = selected.length ? await repo.usersForEmails(selected.map((row) => row.email)) : [];
  return {
    contacts: selected.map((row) => {
      const matches = users.filter((user) => user.email?.trim().toLowerCase() === row.email);
      return {
        ...row,
        onRose: matches.length === 1,
        userId: matches.length === 1 ? matches[0].userId : null,
      };
    }),
  };
}
