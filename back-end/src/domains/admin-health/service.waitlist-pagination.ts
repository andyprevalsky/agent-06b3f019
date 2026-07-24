export const DEFAULT_WAITLIST_PAGE_SIZE = 50;

export interface WaitlistPagination {
  page: number;
  pageSize: number;
}

export class WaitlistPaginationError extends Error {
  constructor() {
    super('page must be a positive integer and pageSize must be an integer from 1 to 100');
    this.name = 'WaitlistPaginationError';
  }
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseWaitlistPagination(
  pageValue: unknown,
  pageSizeValue: unknown
): WaitlistPagination {
  const page = pageValue === undefined ? 1 : parsePositiveInteger(pageValue);
  const pageSize =
    pageSizeValue === undefined ? DEFAULT_WAITLIST_PAGE_SIZE : parsePositiveInteger(pageSizeValue);
  if (
    page === null ||
    pageSize === null ||
    pageSize > 100 ||
    !Number.isSafeInteger((page - 1) * pageSize)
  ) {
    throw new WaitlistPaginationError();
  }
  return { page, pageSize };
}
