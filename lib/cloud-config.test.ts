import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidSupabasePublicConfig } from './cloud-config.ts';

test('public Supabase configuration rejects malformed values before client construction', () => {
  assert.equal(isValidSupabasePublicConfig('garbage', 'also-garbage'), false);
  assert.equal(isValidSupabasePublicConfig('https://project.supabase.co', 'short'), false);
  assert.equal(isValidSupabasePublicConfig('http://project.supabase.co', 'sb_publishable_abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(isValidSupabasePublicConfig(
    'https://project.supabase.co',
    'sb_publishable_abcdefghijklmnopqrstuvwxyz',
  ), true);
  assert.equal(isValidSupabasePublicConfig(
    'http://localhost:54321',
    'local-development-anon-key',
  ), true);
});
