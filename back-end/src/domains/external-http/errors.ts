export class InvalidExternalHttpRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidExternalHttpRequestError';
  }
}

export class ExternalHttpRequestFailedError extends Error {
  public readonly status: number | null;
  public readonly responseBody: unknown;

  constructor(message: string, status: number | null = null, responseBody: unknown = null) {
    super(message);
    this.name = 'ExternalHttpRequestFailedError';
    this.status = status;
    this.responseBody = responseBody;
  }
}
