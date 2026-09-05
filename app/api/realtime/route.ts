import { readServerConfig } from '@/server/knufl-api/config.ts';
import { handleRealtimeRequest, preflightResponse } from '@/server/knufl-api/http.ts';

export const POST = (request: Request): Promise<Response> =>
  handleRealtimeRequest(request, readServerConfig(process.env));

export const OPTIONS = (request: Request): Response => preflightResponse(request);
