import { authenticateSupabaseUser } from './auth.ts';
import { readBoundedText, readJsonObject } from './body.ts';
import { type KnuflServerConfig, requireRealtimeConfig, requireToolConfig } from './config.ts';
import { parseToolCall } from './contracts.ts';
import { ApiError, asApiError } from './errors.ts';
import {
  closeRealtimeCall,
  createRealtimeCall,
  type RealtimeDependencies,
} from './realtime.ts';
import { executeTool, type ToolDependencies } from './tools.ts';
import { AUDITION_VOICES, type AuditionVoice } from '../../lib/voice-audition.ts';

export interface HttpDependencies extends RealtimeDependencies, ToolDependencies {}

const responseHeaders = (contentType = 'application/json; charset=utf-8'): Headers =>
  new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });

export const assertSameOrigin = (request: Request): void => {
  const origin = request.headers.get('origin');
  if (!origin) return;
  const requestOrigin = new URL(request.url).origin;
  if (origin !== requestOrigin) {
    throw new ApiError(403, 'forbidden', 'Cross-origin API requests are not allowed.');
  }
};

const jsonResponse = (value: unknown, init: ResponseInit = {}): Response => {
  const headers = responseHeaders();
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(value), { ...init, headers });
};

const requestIdFor = (dependencies?: HttpDependencies): string =>
  dependencies?.randomUuid?.() ?? crypto.randomUUID();

const elapsedMilliseconds = (startedAt: number): number =>
  Math.max(0, Date.now() - startedAt);

const logOutcome = (
  event: 'knufl_tool_outcome' | 'knufl_realtime_outcome' | 'knufl_realtime_close_outcome',
  requestId: string,
  startedAt: number,
  outcome: 'succeeded' | 'failed',
  details: { tool?: string; code?: string } = {},
): void => {
  // Deliberately exclude bearer/user IDs, tool arguments, transcripts, SDP,
  // provider payloads, and database values from operational logs.
  console.info(JSON.stringify({
    event,
    requestId,
    outcome,
    durationMs: elapsedMilliseconds(startedAt),
    ...details,
  }));
};

const errorResponse = (error: unknown, requestId: string): Response => {
  const apiError = asApiError(error);
  if (apiError.status >= 500) {
    console.error(JSON.stringify({
      event: 'knufl_api_error',
      requestId,
      code: apiError.code,
      status: apiError.status,
    }));
  }
  return jsonResponse(
    {
      ok: false,
      error: {
        code: apiError.code,
        message: apiError.message,
        ...(apiError.details === undefined ? {} : { details: apiError.details }),
      },
      requestId,
    },
    { status: apiError.status },
  );
};

const guarded = async (
  request: Request,
  dependencies: HttpDependencies | undefined,
  action: (requestId: string) => Promise<Response>,
): Promise<Response> => {
  const requestId = requestIdFor(dependencies);
  try {
    assertSameOrigin(request);
    return await action(requestId);
  } catch (error) {
    return errorResponse(error, requestId);
  }
};

export const preflightResponse = (request: Request): Response => {
  try {
    assertSameOrigin(request);
    const headers = responseHeaders();
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Max-Age', '600');
    return new Response(null, { status: 204, headers });
  } catch (error) {
    return errorResponse(error, crypto.randomUUID());
  }
};

export const handleToolsRequest = (
  request: Request,
  config: KnuflServerConfig,
  dependencies?: HttpDependencies,
): Promise<Response> =>
  guarded(request, dependencies, async (requestId) => {
    requireToolConfig(config);
    const auth = await authenticateSupabaseUser(request, config, dependencies?.fetcher);
    const call = parseToolCall(await readJsonObject(request));
    const startedAt = Date.now();
    try {
      const outcome = await executeTool({ auth, config, dependencies }, call);
      logOutcome('knufl_tool_outcome', requestId, startedAt, 'succeeded', { tool: call.name });
      return jsonResponse({ ok: true, ...outcome, requestId });
    } catch (error) {
      logOutcome('knufl_tool_outcome', requestId, startedAt, 'failed', {
        tool: call.name,
        code: asApiError(error).code,
      });
      throw error;
    }
  });

export const handleRealtimeRequest = (
  request: Request,
  config: KnuflServerConfig,
  dependencies?: HttpDependencies,
): Promise<Response> =>
  guarded(request, dependencies, async (requestId) => {
    requireRealtimeConfig(config);
    const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('application/sdp')) {
      throw new ApiError(415, 'bad_request', 'Expected an application/sdp offer.');
    }
    const auth = await authenticateSupabaseUser(request, config, dependencies?.fetcher);
    const offerSdp = await readBoundedText(request, 64 * 1024);
    const audition = new URL(request.url).searchParams.get('audition');
    if (audition && (auth.user.id !== config.previewOwnerId || !AUDITION_VOICES.includes(audition as AuditionVoice))) {
      throw new ApiError(403, 'forbidden', 'Voice auditions are only available to the preview owner.');
    }
    if (!offerSdp.startsWith('v=0') || !offerSdp.includes('\nm=')) {
      throw new ApiError(400, 'validation_error', 'The WebRTC offer is not valid SDP.');
    }
    const startedAt = Date.now();
    try {
      const result = await createRealtimeCall({ auth, config, dependencies, auditionVoice: audition as AuditionVoice | undefined }, offerSdp, requestId);
      logOutcome('knufl_realtime_outcome', requestId, startedAt, 'succeeded');
      const headers = responseHeaders('application/sdp');
      headers.set('X-Knufl-Voice-Session', result.voiceSessionId);
      headers.set('X-Knufl-Voice-Expires-At', result.expiresAt);
      return new Response(result.answerSdp, { status: 201, headers });
    } catch (error) {
      logOutcome('knufl_realtime_outcome', requestId, startedAt, 'failed', {
        code: asApiError(error).code,
      });
      throw error;
    }
  });

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const handleRealtimeCloseRequest = (
  request: Request,
  config: KnuflServerConfig,
  dependencies?: HttpDependencies,
): Promise<Response> =>
  guarded(request, dependencies, async (requestId) => {
    requireRealtimeConfig(config);
    const auth = await authenticateSupabaseUser(request, config, dependencies?.fetcher);
    const body = await readJsonObject(request);
    if (Object.keys(body).some((key) => key !== 'sessionId')) {
      throw new ApiError(400, 'validation_error', 'Unsupported close-session field.');
    }
    if (typeof body.sessionId !== 'string' || !UUID_PATTERN.test(body.sessionId)) {
      throw new ApiError(400, 'validation_error', 'sessionId must be a UUID.');
    }
    const startedAt = Date.now();
    try {
      const result = await closeRealtimeCall(
        { auth, config, dependencies },
        body.sessionId,
        requestId,
      );
      logOutcome('knufl_realtime_close_outcome', requestId, startedAt, 'succeeded');
      return jsonResponse({ ok: true, result, requestId });
    } catch (error) {
      logOutcome('knufl_realtime_close_outcome', requestId, startedAt, 'failed', {
        code: asApiError(error).code,
      });
      throw error;
    }
  });
