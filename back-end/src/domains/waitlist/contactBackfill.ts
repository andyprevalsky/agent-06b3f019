import {
  isWaitlistTestContact,
  normalizeWaitlistEmail,
  normalizeWaitlistPhone,
} from '../../providers/waitlistIdentity';

export const WAITLIST_CONTACT_BACKFILL_VARIANT = 'database-contact-backfill';

export interface WaitlistContactSource {
  sourceId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  seenAt: Date;
}

export interface WaitlistBackfillExistingRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  variant: string | null;
  createdAt: Date;
}

export interface WaitlistBackfillCreate {
  name: string;
  email: string | null;
  phone: string | null;
  variant: typeof WAITLIST_CONTACT_BACKFILL_VARIANT;
  createdAt: Date;
}

export interface WaitlistBackfillUpdate {
  id: string;
  data: {
    name?: string;
    email?: string;
    phone?: string;
  };
}

export interface WaitlistContactBackfillPlan {
  sourceEmailCount: number;
  sourcePhoneCount: number;
  missingEmailCount: number;
  missingPhoneCount: number;
  updates: WaitlistBackfillUpdate[];
  creates: WaitlistBackfillCreate[];
}

interface TimedIdentifier {
  value: string;
  seenAt: Date;
}

interface SourceIdentity {
  sourceId: string;
  name: string | null;
  nameSeenAt: Date | null;
  earliestSeenAt: Date;
  emails: Map<string, Date>;
  phones: Map<string, Date>;
}

interface ExistingTarget {
  kind: 'existing';
  row: WaitlistBackfillExistingRow;
}

interface CreateTarget {
  kind: 'create';
  row: WaitlistBackfillCreate;
}

type BackfillTarget = ExistingTarget | CreateTarget;

/**
 * Contact normalization and fixture classification are canonical in
 * providers/waitlistIdentity so domains/admin-health can share them (cross-domain
 * imports are banned). Re-exported here because scripts and suites have long
 * imported them from this module.
 */
export {
  isRealWaitlistPerson,
  isWaitlistTestContact,
  normalizeWaitlistEmail,
  normalizeWaitlistPhone,
  WAITLIST_FIXTURE_EMAIL_DOMAINS,
} from '../../providers/waitlistIdentity';

function normalizeName(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized === '' ? null : normalized;
}

function earlierDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function collectSourceIdentities(sources: WaitlistContactSource[]): SourceIdentity[] {
  const identities = new Map<string, SourceIdentity>();

  for (const source of sources) {
    if (isWaitlistTestContact(source)) continue;
    const email = normalizeWaitlistEmail(source.email);
    const phone = normalizeWaitlistPhone(source.phone);
    if (email === null && phone === null) continue;

    const sourceId = source.sourceId.trim();
    if (sourceId === '') continue;

    let identity = identities.get(sourceId);
    if (identity === undefined) {
      identity = {
        sourceId,
        name: null,
        nameSeenAt: null,
        earliestSeenAt: source.seenAt,
        emails: new Map(),
        phones: new Map(),
      };
      identities.set(sourceId, identity);
    } else {
      identity.earliestSeenAt = earlierDate(identity.earliestSeenAt, source.seenAt);
    }

    const name = normalizeName(source.name);
    if (
      name !== null &&
      (identity.nameSeenAt === null || source.seenAt.getTime() < identity.nameSeenAt.getTime())
    ) {
      identity.name = name;
      identity.nameSeenAt = source.seenAt;
    }

    if (email !== null) {
      const prior = identity.emails.get(email);
      identity.emails.set(
        email,
        prior === undefined ? source.seenAt : earlierDate(prior, source.seenAt)
      );
    }
    if (phone !== null) {
      const prior = identity.phones.get(phone);
      identity.phones.set(
        phone,
        prior === undefined ? source.seenAt : earlierDate(prior, source.seenAt)
      );
    }
  }

  return [...identities.values()].sort(
    (left, right) =>
      left.earliestSeenAt.getTime() - right.earliestSeenAt.getTime() ||
      left.sourceId.localeCompare(right.sourceId)
  );
}

function sortedIdentifiers(values: Map<string, Date>): TimedIdentifier[] {
  return [...values.entries()]
    .map(([value, seenAt]) => ({ value, seenAt }))
    .sort(
      (left, right) =>
        left.seenAt.getTime() - right.seenAt.getTime() || left.value.localeCompare(right.value)
    );
}

function targetName(target: BackfillTarget): string | null {
  return normalizeName(target.row.name);
}

class ContactBackfillPlanner {
  private readonly emailTargets = new Map<string, BackfillTarget>();
  private readonly phoneTargets = new Map<string, BackfillTarget>();
  private readonly updatesById = new Map<string, WaitlistBackfillUpdate>();
  readonly creates: WaitlistBackfillCreate[] = [];

  constructor(existingRows: WaitlistBackfillExistingRow[]) {
    const targets = [...existingRows]
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
      )
      .map<ExistingTarget>((row) => ({ kind: 'existing', row: { ...row } }));

    for (const target of targets) {
      const email = normalizeWaitlistEmail(target.row.email);
      const phone = normalizeWaitlistPhone(target.row.phone);
      if (email !== null && !this.emailTargets.has(email)) this.emailTargets.set(email, target);
      if (phone !== null && !this.phoneTargets.has(phone)) this.phoneTargets.set(phone, target);
    }
  }

  emailCovered(email: string): boolean {
    return this.emailTargets.has(email);
  }

  phoneCovered(phone: string): boolean {
    return this.phoneTargets.has(phone);
  }

  updates(): WaitlistBackfillUpdate[] {
    return [...this.updatesById.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  private patchTarget(
    target: BackfillTarget,
    data: WaitlistBackfillUpdate['data']
  ): BackfillTarget {
    if (target.kind === 'create') {
      Object.assign(target.row, data);
      return target;
    }

    Object.assign(target.row, data);
    const existingUpdate = this.updatesById.get(target.row.id);
    if (existingUpdate === undefined) {
      this.updatesById.set(target.row.id, { id: target.row.id, data: { ...data } });
    } else {
      Object.assign(existingUpdate.data, data);
    }
    return target;
  }

  private createTarget(
    name: string | null,
    email: TimedIdentifier | null,
    phone: TimedIdentifier | null
  ): CreateTarget {
    const fallbackDate = email?.seenAt ?? phone?.seenAt;
    if (fallbackDate === undefined) throw new Error('Backfill create requires a contact');
    const createdAt =
      email === null || phone === null ? fallbackDate : earlierDate(email.seenAt, phone.seenAt);
    const row: WaitlistBackfillCreate = {
      name: name ?? '',
      email: email?.value ?? null,
      phone: phone?.value ?? null,
      variant: WAITLIST_CONTACT_BACKFILL_VARIANT,
      createdAt,
    };
    this.creates.push(row);
    const target: CreateTarget = { kind: 'create', row };
    if (email !== null) this.emailTargets.set(email.value, target);
    if (phone !== null) this.phoneTargets.set(phone.value, target);
    return target;
  }

  private fillName(target: BackfillTarget, name: string | null) {
    if (name !== null && targetName(target) === null) this.patchTarget(target, { name });
  }

  private processPair(
    identity: SourceIdentity,
    email: TimedIdentifier | null,
    phone: TimedIdentifier | null
  ) {
    const emailTarget = email === null ? undefined : this.emailTargets.get(email.value);
    const phoneTarget = phone === null ? undefined : this.phoneTargets.get(phone.value);

    if (emailTarget !== undefined) this.fillName(emailTarget, identity.name);
    if (phoneTarget !== undefined && phoneTarget !== emailTarget) {
      this.fillName(phoneTarget, identity.name);
    }
    const emailCovered = email === null || emailTarget !== undefined;
    const phoneCovered = phone === null || phoneTarget !== undefined;
    if (emailCovered && phoneCovered) return;

    if (emailTarget !== undefined && phone !== null) {
      if (normalizeWaitlistPhone(emailTarget.row.phone) === null) {
        this.patchTarget(emailTarget, { phone: phone.value });
        this.phoneTargets.set(phone.value, emailTarget);
      } else {
        this.createTarget(identity.name, null, phone);
      }
      return;
    }

    if (phoneTarget !== undefined && email !== null) {
      if (normalizeWaitlistEmail(phoneTarget.row.email) === null) {
        this.patchTarget(phoneTarget, { email: email.value });
        this.emailTargets.set(email.value, phoneTarget);
      } else {
        this.createTarget(identity.name, email, null);
      }
      return;
    }

    this.createTarget(identity.name, email, phone);
  }

  processIdentity(identity: SourceIdentity) {
    const emails = sortedIdentifiers(identity.emails);
    const phones = sortedIdentifiers(identity.phones);
    const pairCount = Math.max(emails.length, phones.length);
    for (let index = 0; index < pairCount; index++) {
      this.processPair(identity, emails[index] ?? null, phones[index] ?? null);
    }
  }
}

/**
 * Builds an idempotent mutation plan from customer-owned contact identifiers.
 *
 * Sources with the same account ID are combined before planning so the public
 * User row and Supabase auth.users row become one person. Existing waitlist
 * timestamps are never rewritten; new rows inherit the earliest timestamp at
 * which their source account held either identifier.
 */
export function planWaitlistContactBackfill(
  sources: WaitlistContactSource[],
  existingRows: WaitlistBackfillExistingRow[]
): WaitlistContactBackfillPlan {
  const identities = collectSourceIdentities(sources);
  const sourceEmails = new Set(identities.flatMap((identity) => [...identity.emails.keys()]));
  const sourcePhones = new Set(identities.flatMap((identity) => [...identity.phones.keys()]));
  const planner = new ContactBackfillPlanner(existingRows);
  const missingEmailCount = [...sourceEmails].filter(
    (email) => !planner.emailCovered(email)
  ).length;
  const missingPhoneCount = [...sourcePhones].filter(
    (phone) => !planner.phoneCovered(phone)
  ).length;
  for (const identity of identities) planner.processIdentity(identity);

  return {
    sourceEmailCount: sourceEmails.size,
    sourcePhoneCount: sourcePhones.size,
    missingEmailCount,
    missingPhoneCount,
    updates: planner.updates(),
    creates: planner.creates,
  };
}
