/** Job type shown in the role meta block. */
export type JobType = 'Full-time' | 'Part-time' | 'Contract';

/** Work style shown in the role meta block. */
export type WorkStyle = 'On-site' | 'Hybrid' | 'Remote';

/** A titled block of prose and/or bullets inside a role description. */
export interface RoleSection {
  /** Heading rendered above the block. */
  title: string;
  /** Paragraphs rendered before the bullet list. */
  body?: string[];
  /** Bullet list rendered after the paragraphs. */
  bullets?: string[];
}

/** A single open role, rendered as a card on /careers and a page on /careers/:slug. */
export interface Role {
  /** URL segment under /careers. */
  slug: string;
  /** Full posted title. */
  title: string;
  /** Short discipline label shown on the overview card. */
  discipline: string;
  /** Number of people we are hiring into this role. */
  openings: number;
  /** One-line hook shown on the overview card. */
  summary: string;
  /** "About the Role" paragraphs. */
  about: string[];
  /** Ordered content blocks: what you'll work on, what we're looking for, etc. */
  sections: RoleSection[];
}
