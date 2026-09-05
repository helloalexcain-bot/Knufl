export type ApiErrorCode =
  | 'bad_request'
  | 'conflict'
  | 'forbidden'
  | 'method_not_allowed'
  | 'not_configured'
  | 'not_found'
  | 'provider_error'
  | 'rate_limited'
  | 'unauthorized'
  | 'validation_error';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const asApiError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error;
  return new ApiError(500, 'provider_error', 'The request could not be completed.');
};
