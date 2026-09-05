const enabled = (value: string | undefined): boolean => value === 'true';

const validPublicSupabaseConfig = (url: string, anonKey: string): boolean => {
  if (anonKey.length < 20 || /\s/.test(anonKey)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      || ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') && parsed.protocol === 'http:');
  } catch {
    return false;
  }
};

export async function GET(): Promise<Response> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? '';
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? '';
  const cloudConfigured = validPublicSupabaseConfig(supabaseUrl, supabaseAnonKey);

  return Response.json(
    {
      cloudConfigured,
      supabaseUrl,
      supabaseAnonKey,
      providers: {
        google: enabled(process.env.KNUFL_AUTH_GOOGLE_ENABLED),
        apple: enabled(process.env.KNUFL_AUTH_APPLE_ENABLED),
        emailOtp: enabled(process.env.KNUFL_AUTH_EMAIL_OTP_ENABLED),
      },
      realtimeConfigured: cloudConfigured && Boolean(
        process.env.OPENAI_API_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY,
      ),
      model: process.env.KNUFL_REALTIME_MODEL || 'gpt-realtime-2.1',
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      },
    },
  );
}
