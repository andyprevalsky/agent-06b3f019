import { normalizeWaitlistEmail, normalizeWaitlistPhone } from './contactBackfill';

export const WAITLIST_MANUAL_IMPORT_VARIANT_PREFIX = 'manual-import:';

export interface RosterEntry {
  name: string;
  email: string | null;
  phone: string | null;
  category: string;
}

export interface RosterParseResult {
  entries: RosterEntry[];
  errors: string[];
}

export interface RosterExistingRow {
  id: string;
  email: string | null;
  phone: string | null;
}

export interface RosterCreate {
  name: string;
  email: string | null;
  phone: string | null;
  variant: string;
}

export interface RosterUpdate {
  name: string;
  id: string;
  data: { email?: string; phone?: string };
}

export interface RosterImportPlan {
  creates: RosterCreate[];
  updates: RosterUpdate[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Parse a tab-separated roster: `name <TAB> email <TAB> phone <TAB> category`.
 * Blank lines and `#` comments are ignored. Rows missing a name, a category, or
 * both contact identifiers are reported as errors rather than silently dropped —
 * the Waitlist_contact_present CHECK constraint rejects contactless rows anyway.
 */
export function parseRoster(text: string): RosterParseResult {
  const entries: RosterEntry[] = [];
  const errors: string[] = [];

  text.split(/\r?\n/).forEach((rawLine, index) => {
    if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) return;

    const columns = rawLine.split('\t').map((column) => column.trim());
    const lineNumber = index + 1;

    if (columns.length < 4) {
      errors.push(`line ${lineNumber}: expected 4 tab-separated columns, got ${columns.length}`);
      return;
    }

    const [name, email, phone, category] = columns;
    if (!name) {
      errors.push(`line ${lineNumber}: missing name`);
      return;
    }
    if (!category) {
      errors.push(`line ${lineNumber}: ${name} is missing a category`);
      return;
    }
    if (!email && !phone) {
      errors.push(`line ${lineNumber}: ${name} has neither email nor phone`);
      return;
    }

    entries.push({ name, email: email || null, phone: phone || null, category });
  });

  return { entries, errors };
}

/**
 * Waitlist has no category column, so a roster category rides on the existing
 * free-form `variant` source tag — the column the admin waitlist UI surfaces.
 */
export function variantForCategory(category: string): string {
  return `${WAITLIST_MANUAL_IMPORT_VARIANT_PREFIX}${category.trim().toLowerCase()}`;
}

/**
 * Plan an idempotent roster import.
 *
 * A roster person is matched to an existing waitlist row by normalized email or
 * normalized phone. Matches are only ever *filled in* — an identifier already on
 * file is never overwritten, and an identifier another row already owns is never
 * claimed, because Waitlist.email and Waitlist.phone are both UNIQUE. Unmatched
 * people become creates. Rerunning a fully-imported roster yields an empty plan.
 */
export function planRosterImport(
  entries: RosterEntry[],
  existing: RosterExistingRow[]
): RosterImportPlan {
  const byEmail = new Map<string, RosterExistingRow>();
  const byPhone = new Map<string, RosterExistingRow>();
  for (const row of existing) {
    const email = normalizeWaitlistEmail(row.email);
    if (email !== null) byEmail.set(email, row);
    const phone = normalizeWaitlistPhone(row.phone);
    if (phone !== null) byPhone.set(phone, row);
  }

  const plan: RosterImportPlan = { creates: [], updates: [], skipped: [] };

  for (const entry of entries) {
    const email = normalizeWaitlistEmail(entry.email);
    const phone = normalizeWaitlistPhone(entry.phone);
    if (email === null && phone === null) {
      plan.skipped.push({ name: entry.name, reason: 'no email or phone' });
      continue;
    }

    const match =
      (email !== null ? byEmail.get(email) : undefined) ??
      (phone !== null ? byPhone.get(phone) : undefined);

    if (match !== undefined) {
      const data: { email?: string; phone?: string } = {};
      if (email !== null && normalizeWaitlistEmail(match.email) === null && !byEmail.has(email)) {
        data.email = email;
      }
      if (phone !== null && normalizeWaitlistPhone(match.phone) === null && !byPhone.has(phone)) {
        data.phone = phone;
      }

      if (Object.keys(data).length === 0) {
        plan.skipped.push({ name: entry.name, reason: `already on waitlist (${match.id})` });
        continue;
      }

      plan.updates.push({ name: entry.name, id: match.id, data });
      if (data.email !== undefined) byEmail.set(data.email, match);
      if (data.phone !== undefined) byPhone.set(data.phone, match);
      continue;
    }

    plan.creates.push({
      name: entry.name,
      email,
      phone,
      variant: variantForCategory(entry.category),
    });

    // Register the pending row so a duplicate later in the same roster folds
    // into it instead of tripping UNIQUE mid-transaction.
    const pending: RosterExistingRow = { id: '(pending)', email, phone };
    if (email !== null) byEmail.set(email, pending);
    if (phone !== null) byPhone.set(phone, pending);
  }

  return plan;
}
