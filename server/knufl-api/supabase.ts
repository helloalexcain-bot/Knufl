import { readBoundedJson } from './body.ts';
import { type KnuflServerConfig } from './config.ts';
import { ApiError } from './errors.ts';
import { deterministicUuid } from '../../lib/stable-id.ts';

export { deterministicUuid };

export interface SupabaseClientContext {
  config: KnuflServerConfig;
  bearerToken: string;
  apiKey?: string;
  fetcher?: typeof fetch;
}

export interface SupabaseRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  prefer?: string;
  allowNotFound?: boolean;
}

export const supabaseRequest = async <T>(
  context: SupabaseClientContext,
  path: string,
  options: SupabaseRequestOptions = {},
): Promise<T> => {
  if (!path.startsWith('/rest/v1/')) {
    throw new ApiError(500, 'provider_error', 'Invalid Supabase API path.');
  }
  const fetcher = context.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${context.config.supabaseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        apikey: context.apiKey ?? context.config.supabaseAnonKey,
        Authorization: `Bearer ${context.bearerToken}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.prefer ? { Prefer: options.prefer } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiError(503, 'provider_error', 'Cloud data is temporarily unavailable.');
  }

  if (options.allowNotFound && response.status === 404) return null as T;
  if (!response.ok) {
    // Consume the bounded response but never relay arbitrary PostgREST/Postgres
    // details to the browser; those can contain policy or schema information.
    await readBoundedJson<unknown>(response).catch(() => null);
    if (response.status === 401) {
      throw new ApiError(401, 'unauthorized', 'Your sign-in session is invalid or expired.');
    }
    if (response.status === 403) {
      throw new ApiError(403, 'forbidden', 'This account cannot perform that action.');
    }
    if (response.status === 409) {
      throw new ApiError(409, 'conflict', 'That cloud record changed or already exists.');
    }
    if (response.status === 429) {
      throw new ApiError(429, 'rate_limited', 'Cloud data is busy. Please try again shortly.');
    }
    if (response.status >= 500 || response.status === 404) {
      throw new ApiError(503, 'provider_error', 'Cloud data is temporarily unavailable.');
    }
    throw new ApiError(400, 'bad_request', 'Cloud data rejected the request.');
  }

  if (response.status === 204) return null as T;
  return readBoundedJson<T>(response);
};

export const encodeFilter = (value: string): string => encodeURIComponent(value);
