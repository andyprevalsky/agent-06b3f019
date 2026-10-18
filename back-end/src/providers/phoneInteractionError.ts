export class PhoneInteractionError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}
