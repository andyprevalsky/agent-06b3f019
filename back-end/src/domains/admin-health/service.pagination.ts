export const DEFAULT_PEOPLE_PAGE_SIZE = 50;

export interface PeoplePagination {
  page: number;
  pageSize: number;
}

export class PeoplePaginationError extends Error {
  constructor() {
    super('page must be a positive integer and pageSize must be an integer from 1 to 100');
    this.name = 'PeoplePaginationError';
  }
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Shared page parser for every admin-health people listing (waitlist + user
 * directory). Bounds pageSize so a single admin request can never ask the DB for
 * an unbounded scan.
 */
export function parsePeoplePagination(
  pageValue: unknown,
  pageSizeValue: unknown
): PeoplePagination {
  const page = pageValue === undefined ? 1 : parsePositiveInteger(pageValue);
  const pageSize =
    pageSizeValue === undefined ? DEFAULT_PEOPLE_PAGE_SIZE : parsePositiveInteger(pageSizeValue);
  if (
    page === null ||
    pageSize === null ||
    pageSize > 100 ||
    !Number.isSafeInteger((page - 1) * pageSize)
  ) {
    throw new PeoplePaginationError();
  }
  return { page, pageSize };
}
