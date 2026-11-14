export interface TransactionGrepFilters {
  /** Parsed from `filters.path` — addresses an institution/account/transaction subtree. */
  pathInstitution?: string;
  pathAccount?: string;
  pathTransactionId?: string;
  since?: Date;
  until?: Date;
  account?: string;
  minAmount?: number;
  maxAmount?: number;
  status?: 'pending' | 'posted' | 'all';
  includePendingInTotals: boolean;
}

export interface DocumentGrepFilters {
  /** Set when `filters.path` was a path this tool printed. */
  pathDocumentSource?: string;
  pathRest?: string;
  documentSource?: string;
  since?: Date;
  until?: Date;
  path?: string;
  tag?: string;
}
