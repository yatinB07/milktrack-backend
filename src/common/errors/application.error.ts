export class ApplicationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly retryAfterSeconds?: number,
    public readonly fieldErrors?: Readonly<
      Record<string, readonly string[]>
    >,
  ) {
    super(message);
  }
}
