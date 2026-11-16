/** Errors for integration requests (status → HTTP status). */
export class IntegrationRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
