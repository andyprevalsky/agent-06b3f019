import {
  isRealWaitlistPerson,
  normalizeWaitlistEmail,
  normalizeWaitlistPhone,
} from './contactBackfill';

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

    // Exactly four — a fifth column means the row is shifted or a category got
    // split, and silently dropping it would import the wrong contact details.
    if (columns.length !== 4) {
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
 * A roster identifier resolves either to a persisted row (which yields an
 * update) or to a create planned earlier in this same roster (which must be
 * amended in place). Conflating the two produced an update against the sentinel
 * id "(pending)"; the script applies updates before creates, so that update hit
 * a row that did not exist yet and rolled back the whole import.
 */
type MatchTarget =
  { kind: 'existing'; row: RosterExistingRow } | { kind: 'pending'; create: RosterCreate };

interface IdentifierIndex {
  byEmail: Map<string, MatchTarget>;
  byPhone: Map<string, MatchTarget>;
}

/**
 * Fold a duplicate into the create already planned for the same person, filling
 * only identifiers that create still lacks and that nothing else owns
 * (Waitlist.email and Waitlist.phone are both UNIQUE). Returns the skip reason.
 */
function mergeIntoPendingCreate(
  match: Extract<MatchTarget, { kind: 'pending' }>,
  contact: { email: string | null; phone: string | null },
  index: IdentifierIndex
): string {
  const { create } = match;
  let merged = false;
  if (contact.email !== null && create.email === null && !index.byEmail.has(contact.email)) {
    create.email = contact.email;
    index.byEmail.set(contact.email, match);
    merged = true;
  }
  if (contact.phone !== null && create.phone === null && !index.byPhone.has(contact.phone)) {
    create.phone = contact.phone;
    index.byPhone.set(contact.phone, match);
    merged = true;
  }
  return merged ? 'merged into an earlier row in this roster' : 'duplicate within this roster';
}

/** Contact details a persisted row is still missing and no other row owns. */
function fillableContactDetails(
  row: RosterExistingRow,
  contact: { email: string | null; phone: string | null },
  index: IdentifierIndex
): { email?: string; phone?: string } {
  const data: { email?: string; phone?: string } = {};
  if (
    contact.email !== null &&
    normalizeWaitlistEmail(row.email) === null &&
    !index.byEmail.has(contact.email)
  ) {
    data.email = contact.email;
  }
  if (
    contact.phone !== null &&
    normalizeWaitlistPhone(row.phone) === null &&
    !index.byPhone.has(contact.phone)
  ) {
    data.phone = contact.phone;
  }
  return data;
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
  const byEmail = new Map<string, MatchTarget>();
  const byPhone = new Map<string, MatchTarget>();
  for (const row of existing) {
    const email = normalizeWaitlistEmail(row.email);
    if (email !== null) byEmail.set(email, { kind: 'existing', row });
    const phone = normalizeWaitlistPhone(row.phone);
    if (phone !== null) byPhone.set(phone, { kind: 'existing', row });
  }

  const index: IdentifierIndex = { byEmail, byPhone };
  const plan: RosterImportPlan = { creates: [], updates: [], skipped: [] };

  for (const entry of entries) {
    const email = normalizeWaitlistEmail(entry.email);
    const phone = normalizeWaitlistPhone(entry.phone);
    if (email === null && phone === null) {
      plan.skipped.push({ name: entry.name, reason: 'no email or phone' });
      continue;
    }

    // A roster is hand-assembled, so it can carry a fixture identity by mistake.
    // Refuse it here rather than writing the very rows the canonical identity
    // rule exists to keep out of the waitlist.
    if (!isRealWaitlistPerson({ name: entry.name, email: entry.email, phone: entry.phone })) {
      plan.skipped.push({ name: entry.name, reason: 'reserved test/fixture contact' });
      continue;
    }

    const match =
      (email !== null ? byEmail.get(email) : undefined) ??
      (phone !== null ? byPhone.get(phone) : undefined);

    if (match?.kind === 'pending') {
      const reason = mergeIntoPendingCreate(match, { email, phone }, index);
      plan.skipped.push({ name: entry.name, reason });
      continue;
    }

    if (match !== undefined) {
      const row = match.row;
      const data = fillableContactDetails(row, { email, phone }, index);

      if (Object.keys(data).length === 0) {
        plan.skipped.push({ name: entry.name, reason: `already on waitlist (${row.id})` });
        continue;
      }

      plan.updates.push({ name: entry.name, id: row.id, data });
      if (data.email !== undefined) byEmail.set(data.email, match);
      if (data.phone !== undefined) byPhone.set(data.phone, match);
      continue;
    }

    const create: RosterCreate = {
      name: entry.name,
      email,
      phone,
      variant: variantForCategory(entry.category),
    };
    plan.creates.push(create);

    // Register the create so a duplicate later in the same roster folds into it
    // instead of tripping UNIQUE mid-transaction.
    const pending: MatchTarget = { kind: 'pending', create };
    if (email !== null) byEmail.set(email, pending);
    if (phone !== null) byPhone.set(phone, pending);
  }

  return plan;
}
