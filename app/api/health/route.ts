export async function GET(): Promise<Response> {
  return Response.json(
    {
      ok: true,
      service: 'knufl-voice-preview',
      cloud: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      realtime: Boolean(process.env.OPENAI_API_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
