import { readBoundedJson } from './body.ts';
import { requireSupabaseConfig, type KnuflServerConfig } from './config.ts';
import { ApiError } from './errors.ts';

export interface AuthenticatedUser {
  id: string;
}

export interface AuthContext {
  bearerToken: string;
  user: AuthenticatedUser;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const readBearerToken = (request: Request): string => {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match || match[1].length > 8192) {
    throw new ApiError(401, 'unauthorized', 'A valid sign-in session is required.');
  }
  return match[1];
};

export const authenticateSupabaseUser = async (
  request: Request,
  config: KnuflServerConfig,
  fetcher: typeof fetch = fetch,
): Promise<AuthContext> => {
  requireSupabaseConfig(config);
  const bearerToken = readBearerToken(request);
  let response: Response;
  try {
    response = await fetcher(`${config.supabaseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${bearerToken}`,
      },
    });
  } catch {
    throw new ApiError(503, 'provider_error', 'Sign-in verification is temporarily unavailable.');
  }

  if (!response.ok) {
    throw new ApiError(401, 'unauthorized', 'Your sign-in session is invalid or expired.');
  }

  const user = await readBoundedJson<{ id?: unknown }>(response, 64 * 1024);
  if (typeof user?.id !== 'string' || !UUID_PATTERN.test(user.id)) {
    throw new ApiError(401, 'unauthorized', 'Your sign-in session could not be verified.');
  }
  return {
    bearerToken,
    user: { id: user.id },
  };
};

export const privacyPreservingUserId = async (userId: string): Promise<string> => {
  const data = new TextEncoder().encode(`knufl:${userId}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
};
