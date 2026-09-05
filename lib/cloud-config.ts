'use client';

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

export interface PublicAppConfig {
  cloudConfigured: boolean;
  supabaseUrl: string;
  supabaseAnonKey: string;
  providers: {
    google: boolean;
    apple: boolean;
    emailOtp: boolean;
  };
  realtimeConfigured: boolean;
  model: string;
}

const unavailableConfig: PublicAppConfig = {
  cloudConfigured: false,
  supabaseUrl: '',
  supabaseAnonKey: '',
  providers: { google: false, apple: false, emailOtp: false },
  realtimeConfigured: false,
  model: 'gpt-realtime-2.1',
};

export const isValidSupabasePublicConfig = (url: string, anonKey: string): boolean => {
  if (anonKey.length < 20 || /\s/.test(anonKey)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      || ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') && parsed.protocol === 'http:');
  } catch {
    return false;
  }
};

const isConfig = (value: unknown): value is PublicAppConfig => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PublicAppConfig>;
  return typeof candidate.cloudConfigured === 'boolean'
    && typeof candidate.supabaseUrl === 'string'
    && typeof candidate.supabaseAnonKey === 'string'
    && typeof candidate.realtimeConfigured === 'boolean'
    && typeof candidate.model === 'string'
    && Boolean(candidate.providers)
    && typeof candidate.providers?.google === 'boolean'
    && typeof candidate.providers?.apple === 'boolean'
    && typeof candidate.providers?.emailOtp === 'boolean'
    && (!candidate.cloudConfigured || isValidSupabasePublicConfig(candidate.supabaseUrl, candidate.supabaseAnonKey));
};

export async function loadPublicAppConfig(): Promise<PublicAppConfig> {
  try {
    const response = await fetch('/api/config', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      return unavailableConfig;
    }
    const value: unknown = await response.json();
    return isConfig(value) ? value : unavailableConfig;
  } catch {
    return unavailableConfig;
  }
}

let browserClient: SupabaseClient | undefined;

export function getSupabaseBrowserClient(config: PublicAppConfig): SupabaseClient | undefined {
  if (!config.cloudConfigured || !isValidSupabasePublicConfig(config.supabaseUrl, config.supabaseAnonKey)) return undefined;
  browserClient ??= createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      storageKey: 'knufl.auth.v1',
      flowType: 'pkce',
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return browserClient;
}

export async function currentSession(client: SupabaseClient): Promise<Session | null> {
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session;
}
