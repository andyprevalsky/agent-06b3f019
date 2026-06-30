/** Canonical error for the purchases domain. `statusCode` is surfaced directly by the routes. */
export class PurchaseError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}
