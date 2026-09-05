import { ApiError } from './errors.ts';

const MAX_JSON_BYTES = 64 * 1024;

const assertBoundedContentLength = (request: Request, maximum: number): void => {
  const header = request.headers.get('content-length');
  if (!header) return;
  const length = Number.parseInt(header, 10);
  if (!Number.isFinite(length) || length < 0 || length > maximum) {
    throw new ApiError(413, 'bad_request', 'The request body is too large.');
  }
};
export const readBoundedText = async (
  request: Request,
  maximumBytes = MAX_JSON_BYTES,
): Promise<string> => {
  assertBoundedContentLength(request, maximumBytes);
  const value = await request.text();
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new ApiError(413, 'bad_request', 'The request body is too large.');
  }
  return value;
};

export const readJsonObject = async (request: Request): Promise<Record<string, unknown>> => {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new ApiError(415, 'bad_request', 'Expected an application/json request body.');
  }
  const raw = await readBoundedText(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'bad_request', 'The request body is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'bad_request', 'Expected a JSON object.');
  }
  return parsed as Record<string, unknown>;
};

export const readBoundedJson = async <T>(response: Response, maximumBytes = 512 * 1024): Promise<T> => {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number.parseInt(contentLength, 10) > maximumBytes) {
    throw new ApiError(502, 'provider_error', 'A provider returned an oversized response.');
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new ApiError(502, 'provider_error', 'A provider returned an oversized response.');
  }
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(502, 'provider_error', 'A provider returned an invalid response.');
  }
};
