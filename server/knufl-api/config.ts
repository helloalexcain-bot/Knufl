import { ApiError } from './errors.ts';

export interface KnuflServerConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  openAiApiKey: string;
  realtimeModel: string;
  realtimeVoice: string;
  maxActiveRealtimeSessions: number;
  dailyRealtimeMinutes: number;
  maxRealtimeSessionMinutes: number;
}

const boundedInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

export const readServerConfig = (
  values: Readonly<Record<string, string | undefined>>,
): KnuflServerConfig => ({
  supabaseUrl: values.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, '') ?? '',
  supabaseAnonKey: values.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? '',
  supabaseServiceRoleKey: values.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '',
  openAiApiKey: values.OPENAI_API_KEY?.trim() ?? '',
  realtimeModel: values.KNUFL_REALTIME_MODEL?.trim() || 'gpt-realtime-2.1',
  realtimeVoice: values.KNUFL_REALTIME_VOICE?.trim() || 'marin',
  maxActiveRealtimeSessions: boundedInteger(
    values.KNUFL_MAX_ACTIVE_REALTIME_SESSIONS,
    1,
    1,
    3,
  ),
  dailyRealtimeMinutes: boundedInteger(values.KNUFL_DAILY_REALTIME_MINUTES, 60, 1, 240),
  maxRealtimeSessionMinutes: boundedInteger(
    values.KNUFL_MAX_REALTIME_SESSION_MINUTES,
    30,
    1,
    60,
  ),
});

export const requireSupabaseConfig = (config: KnuflServerConfig): void => {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new ApiError(
      503,
      'not_configured',
      'Cloud persistence is not configured for this preview.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(config.supabaseUrl);
  } catch {
    throw new ApiError(503, 'not_configured', 'The Supabase URL is not valid.');
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new ApiError(503, 'not_configured', 'The Supabase URL must use HTTPS.');
  }
};

export const requireRealtimeConfig = (config: KnuflServerConfig): void => {
  requireSupabaseConfig(config);
  if (!config.openAiApiKey || !config.supabaseServiceRoleKey) {
    throw new ApiError(
      503,
      'not_configured',
      'Live voice and its secure usage ledger are not configured for this preview.',
    );
  }
};

export const requireToolConfig = (config: KnuflServerConfig): void => {
  requireSupabaseConfig(config);
  if (!config.supabaseServiceRoleKey) {
    throw new ApiError(
      503,
      'not_configured',
      'Secure cloud workout writes are not configured for this preview.',
    );
  }
};
