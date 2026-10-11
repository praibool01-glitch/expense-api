export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 500;

export class HttpError extends Error {
  constructor(
    public status: HttpStatus,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}
