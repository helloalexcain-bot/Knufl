import test from 'node:test';
import assert from 'node:assert/strict';
import { privacyPreservingUserId } from '../server/knufl-api/auth.ts';
import { readServerConfig, type KnuflServerConfig } from '../server/knufl-api/config.ts';
import { parseToolCall } from '../server/knufl-api/contracts.ts';
import {
  assertSameOrigin,
  handleRealtimeCloseRequest,
  handleRealtimeRequest,
  handleToolsRequest,
} from '../server/knufl-api/http.ts';
import { deterministicUuid } from '../server/knufl-api/supabase.ts';
import { executeTool } from '../server/knufl-api/tools.ts';
import { GET as getClientConfig } from '../app/api/config/route.ts';

const USER_ID = '4cfe6f29-3d33-4eca-9dd5-cecb7aa6a842';
const VOICE_SESSION_ID = '592d46d6-f49c-4c92-8a69-f2357721384f';
const API_ORIGIN = 'https://knufl.example';

const config: KnuflServerConfig = {
  supabaseUrl: 'https://project.supabase.co',
  supabaseAnonKey: 'public-anon-key',
  supabaseServiceRoleKey: 'server-service-role-key',
  openAiApiKey: 'server-openai-key',
  realtimeModel: 'gpt-realtime-2.1',
  realtimeVoice: 'marin',
  maxActiveRealtimeSessions: 1,
  dailyRealtimeMinutes: 60,
  maxRealtimeSessionMinutes: 30,
};

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const authenticatedRequest = (
  path: string,
  body: BodyInit,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): Request => new Request(`${API_ORIGIN}${path}`, {
  method: 'POST',
  headers: {
    Authorization: 'Bearer user-access-token',
    'Content-Type': contentType,
    Origin: API_ORIGIN,
    ...extraHeaders,
  },
  body,
});

const authResponse = (): Response => json({ id: USER_ID, email: 'member@example.com' });

test('[mocked] tool contracts reject owner injection and invalid load ambiguity', () => {
  assert.throws(
    () => parseToolCall({
      name: 'get_session_context',
      arguments: { owner: 'someone-else' },
    }),
    /Unsupported field: owner/,
  );
  assert.throws(
    () => parseToolCall({
      name: 'record_set',
      arguments: {
        operationKey: 'record-set-001',
        sessionId: '36850458-df29-4462-9a30-a2d57d97e70d',
        exerciseInstanceId: '11fe9f7b-8048-4931-b395-dcf0dcc5048c',
        reps: 8,
        load: 60,
      },
    }),
    /loadUnit is required/,
  );
  assert.throws(
    () => parseToolCall({
      name: 'record_set',
      arguments: {
        operationKey: 'record-set-mode-001',
        sessionId: '36850458-df29-4462-9a30-a2d57d97e70d',
        exerciseInstanceId: '11fe9f7b-8048-4931-b395-dcf0dcc5048c',
        reps: 8,
        load: 60,
        loadUnit: 'kg',
      },
    }),
    /loadMode is required/,
  );
  assert.throws(
    () => parseToolCall({
      name: 'draft_workout',
      arguments: {
        exercises: [{ name: 'Dumbbell curl', sets: 3, reps: 8, load: 20, loadUnit: 'kg' }],
      },
    }),
    /loadMode is required/,
  );
  const replayed = parseToolCall({
    name: 'record_set',
    arguments: {
      operationKey: 'record-set-002',
      sessionId: '36850458-df29-4462-9a30-a2d57d97e70d',
      exerciseInstanceId: '11fe9f7b-8048-4931-b395-dcf0dcc5048c',
      reps: 8,
      load: 20,
      loadUnit: 'kg',
      loadMode: 'per-dumbbell',
    },
  });
  assert.equal(replayed.name, 'record_set');
  assert.equal(replayed.arguments.loadMode, 'per-dumbbell');
  const legacy = parseToolCall({
    name: 'get_session_context',
    arguments: { sessionId: 'legacy-session-1' },
  });
  assert.equal(legacy.name, 'get_session_context');
  if (legacy.name !== 'get_session_context') assert.fail('Expected session context tool.');
  assert.equal(legacy.arguments.sessionId, 'legacy-session-1');
});

test('[mocked] cardio tool contract requires actual distance and duration', () => {
  assert.throws(
    () => parseToolCall({
      name: 'record_cardio',
      arguments: {
        operationKey: 'cardio-record-001',
        activity: 'Walking',
        localDate: '2026-09-05',
        timezone: 'Europe/London',
      },
    }),
    /distance must be a valid number/,
  );
});

test('[mocked] attached cardio rejects a date or timezone that differs from its frozen session', async () => {
  let cardioWrites = 0;
  let failedReceipt = false;
  const claimToken = '02508979-fcd8-4c42-b913-461eb64cc0d2';
  await assert.rejects(
    executeTool(
      {
        auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
        config,
        dependencies: {
          now: () => new Date('2026-09-05T12:00:00.000Z'),
          fetcher: async (input, init) => {
            const url = String(input);
            if (url.endsWith('/rest/v1/rpc/claim_operation_receipt')) {
              const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
              return json([{
                claimed: true,
                reason: 'claimed',
                receipt_id: body.p_receipt_id,
                operation_type: body.p_operation_type,
                status: 'pending',
                claim_token: claimToken,
                lease_expires_at: '2026-09-05T12:01:30.000Z',
              }]);
            }
            if (url.includes('/rest/v1/workout_sessions?select=')) {
              return json([{
                id: 'session-one', status: 'active', version: 1,
                local_date: '2026-09-04', timezone: 'Europe/London',
              }]);
            }
            if (url.endsWith('/rest/v1/rpc/finish_operation_receipt')) {
              const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
              assert.equal(body.p_succeeded, false);
              assert.equal(body.p_error_code, 'conflict');
              failedReceipt = true;
              return json([{
                finalized: true,
                reason: 'finalized',
                status: 'failed',
                result: null,
              }]);
            }
            if (url.includes('/rest/v1/cardio_records')) cardioWrites += 1;
            throw new Error(`Unexpected mocked fetch: ${url}`);
          },
        },
      },
      parseToolCall({
        name: 'record_cardio',
        arguments: {
          operationKey: 'cardio-session-date-001',
          sessionId: 'session-one',
          activity: 'Walking',
          distance: 3,
          distanceUnit: 'km',
          durationSeconds: 1800,
          localDate: '2026-09-05',
          timezone: 'Europe/London',
        },
      }),
    ),
    /does not match this workout session/,
  );
  assert.equal(failedReceipt, true);
  assert.equal(cardioWrites, 0);
});

test('[mocked] same-origin API policy rejects a foreign browser origin', async () => {
  let fetchCount = 0;
  const response = await handleToolsRequest(
    new Request(`${API_ORIGIN}/api/tools`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer user-access-token',
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
      },
      body: JSON.stringify({ name: 'draft_workout', arguments: { exercises: [] } }),
    }),
    config,
    {
      randomUuid: () => 'request-id',
      fetcher: async () => {
        fetchCount += 1;
        return authResponse();
      },
    },
  );

  assert.equal(response.status, 403);
  assert.equal(fetchCount, 0);
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const payload = await response.json() as { error: { code: string } };
  assert.equal(payload.error.code, 'forbidden');
});

test('[mocked] tool endpoint authenticates bearer and keeps a draft unsaved', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return authResponse();
  };
  const response = await handleToolsRequest(
    authenticatedRequest(
      '/api/tools',
      JSON.stringify({
        name: 'draft_workout',
        arguments: {
          title: 'Bench day',
          exercises: [{
            name: 'Bench press',
            sets: 3,
            reps: 8,
            load: 60,
            loadUnit: 'kg',
            loadMode: 'barbell_total',
            restSeconds: 90,
          }],
        },
      }),
      'application/json',
    ),
    config,
    { fetcher, randomUuid: () => 'request-id' },
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${config.supabaseUrl}/auth/v1/user`);
  assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), 'Bearer user-access-token');
  const payload = await response.json() as {
    ok: boolean;
    tool: string;
    result: { saved: boolean; confirmationRequired: boolean };
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.tool, 'draft_workout');
  assert.equal(payload.result.saved, false);
  assert.equal(payload.result.confirmationRequired, true);
});

test('[mocked] tool latency logs include only safe operational metadata', async () => {
  const originalInfo = console.info;
  const logs: string[] = [];
  console.info = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
  try {
    const response = await handleToolsRequest(
      authenticatedRequest(
        '/api/tools',
        JSON.stringify({
          name: 'draft_workout',
          arguments: {
            title: 'PRIVATE rehab detail',
            exercises: [{ name: 'PRIVATE shoulder movement', sets: 1 }],
          },
        }),
        'application/json',
      ),
      config,
      { fetcher: async () => authResponse(), randomUuid: () => 'safe-request-id' },
    );
    assert.equal(response.status, 200);
  } finally {
    console.info = originalInfo;
  }

  assert.equal(logs.length, 1);
  const entry = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>;
  assert.deepEqual(
    { event: entry.event, requestId: entry.requestId, outcome: entry.outcome, tool: entry.tool },
    {
      event: 'knufl_tool_outcome',
      requestId: 'safe-request-id',
      outcome: 'succeeded',
      tool: 'draft_workout',
    },
  );
  assert.equal(typeof entry.durationMs, 'number');
  const serialized = JSON.stringify(entry);
  assert.doesNotMatch(serialized, /PRIVATE|member@example\.com|user-access-token/);
  assert.doesNotMatch(serialized, new RegExp(USER_ID));
});

test('[mocked] mutation forwarding derives every owner and separates receipt auth from privileged writes', async () => {
  const storedBodies: Array<{ url: string; body: unknown }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/auth/v1/user')) return authResponse();
    const headers = new Headers(init?.headers);
    const isReceiptRpc =
      url.endsWith('/rest/v1/rpc/claim_operation_receipt')
      || url.endsWith('/rest/v1/rpc/finish_operation_receipt');
    const isTableMutation = ['POST', 'PATCH', 'DELETE'].includes(method) && !isReceiptRpc;
    assert.equal(
      headers.get('authorization'),
      isTableMutation ? 'Bearer server-service-role-key' : 'Bearer user-access-token',
    );
    assert.equal(
      headers.get('apikey'),
      isTableMutation ? 'server-service-role-key' : 'public-anon-key',
    );
    if (url.endsWith('/rest/v1/rpc/claim_operation_receipt') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      storedBodies.push({ url, body });
      assert.equal('user_id' in body, false);
      assert.equal('owner' in body, false);
      return json([{
        claimed: true,
        reason: 'claimed',
        receipt_id: body.p_receipt_id,
        operation_type: body.p_operation_type,
        status: 'pending',
        claim_token: '0deaf687-2932-40b9-9783-9bfd52451a24',
        lease_expires_at: '2026-09-05T12:01:30.000Z',
      }]);
    }
    if (url.endsWith('/rest/v1/workout_sessions?on_conflict=id') && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      storedBodies.push({ url, body });
      return json([body]);
    }
    if (url.endsWith('/rest/v1/exercise_instances?on_conflict=id') && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      storedBodies.push({ url, body });
      return json(body);
    }
    if (url.endsWith('/rest/v1/rpc/finish_operation_receipt') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      storedBodies.push({ url, body });
      return json([{
        finalized: true,
        reason: 'finalized',
        status: 'succeeded',
        result: body.p_result,
      }]);
    }
    throw new Error(`Unexpected mocked fetch: ${method} ${url}`);
  };

  const response = await handleToolsRequest(
    authenticatedRequest(
      '/api/tools',
      JSON.stringify({
        name: 'start_workout',
        arguments: {
          operationKey: 'start-workout-001',
          localDate: '2026-09-05',
          timezone: 'Europe/London',
          title: 'Bench day',
          exercises: [{ name: 'Bench press', sets: 3, reps: 8 }],
        },
      }),
      'application/json',
    ),
    config,
    { fetcher, randomUuid: () => 'request-id' },
  );

  assert.equal(response.status, 200);
  const payload = await response.json() as {
    result: { saved: boolean; completedSetCount: number };
  };
  assert.equal(payload.result.saved, true);
  assert.equal(payload.result.completedSetCount, 0);
  assert.ok(storedBodies.length >= 4);
  const inserted = storedBodies
    .flatMap(({ body }) => Array.isArray(body) ? body : [body])
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'));
  for (const row of inserted.filter((row) => 'user_id' in row)) {
    assert.equal(row.user_id, USER_ID);
    assert.equal('owner' in row, false);
  }
  assert.ok(storedBodies.some(({ url }) => url.endsWith('/rest/v1/rpc/claim_operation_receipt')));
  assert.ok(storedBodies.some(({ url }) => url.endsWith('/rest/v1/rpc/finish_operation_receipt')));
});

test('[mocked] a succeeded key from another tool is rejected before its result is replayed', async () => {
  let fetchCount = 0;
  const call = parseToolCall({
    name: 'start_workout',
    arguments: {
      operationKey: 'shared-operation-001',
      localDate: '2026-09-05',
      timezone: 'Europe/London',
      exercises: [{ name: 'Bench press', sets: 3 }],
    },
  });

  await assert.rejects(
    executeTool(
      {
        auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
        config,
        dependencies: {
          fetcher: async (input, init) => {
            fetchCount += 1;
            assert.match(String(input), /\/rest\/v1\/rpc\/claim_operation_receipt$/);
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return json([{
              claimed: false,
              reason: 'operation_type_conflict',
              receipt_id: body.p_receipt_id,
              operation_type: 'record_set',
              status: 'succeeded',
              claim_token: null,
              result: { saved: true, shouldNeverReplay: true },
            }]);
          },
        },
      },
      call,
    ),
    /already used for another action/,
  );
  assert.equal(fetchCount, 1);
});

test('[mocked] a same-tool replay is marked duplicate without mutating the stored result', async () => {
  const storedResult: Record<string, unknown> = {
    saved: true,
    session: { id: 'existing-session', status: 'active' },
  };
  const call = parseToolCall({
    name: 'start_workout',
    arguments: {
      operationKey: 'same-operation-001',
      localDate: '2026-09-05',
      timezone: 'Europe/London',
      exercises: [{ name: 'Bench press', sets: 3 }],
    },
  });
  const replay = await executeTool(
    {
      auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
      config,
      dependencies: {
        fetcher: async (input, init) => {
          assert.match(String(input), /\/rest\/v1\/rpc\/claim_operation_receipt$/);
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return json([{
            claimed: false,
            reason: 'succeeded',
            receipt_id: body.p_receipt_id,
            operation_type: body.p_operation_type,
            status: 'succeeded',
            claim_token: null,
            result: storedResult,
          }]);
        },
      },
    },
    call,
  );

  assert.equal((replay.result as Record<string, unknown>).duplicate, true);
  assert.equal('duplicate' in storedResult, false);
});

test('[mocked] concurrent retries execute only the holder of the atomic receipt lease', { timeout: 5_000 }, async () => {
  let claimCount = 0;
  let sessionInsertCount = 0;
  let exerciseInsertCount = 0;
  let finishCount = 0;
  let releaseSessionInsert: (() => void) | undefined;
  let signalSessionInsert: (() => void) | undefined;
  const sessionInsertReleased = new Promise<void>((resolve) => { releaseSessionInsert = resolve; });
  const sessionInsertStarted = new Promise<void>((resolve) => { signalSessionInsert = resolve; });
  const claimToken = '9db50686-e78a-47f9-a60f-3722473bbf4c';

  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/rest/v1/rpc/claim_operation_receipt') && method === 'POST') {
      claimCount += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (claimCount === 1) {
        return json([{
          claimed: true,
          reason: 'claimed',
          receipt_id: body.p_receipt_id,
          operation_type: body.p_operation_type,
          status: 'pending',
          claim_token: claimToken,
          lease_expires_at: '2026-09-05T12:01:30.000Z',
        }]);
      }
      return json([{
        claimed: false,
        reason: 'in_progress',
        receipt_id: body.p_receipt_id,
        operation_type: body.p_operation_type,
        status: 'pending',
        claim_token: null,
        lease_expires_at: '2026-09-05T12:01:30.000Z',
      }]);
    }
    if (url.endsWith('/rest/v1/workout_sessions?on_conflict=id') && method === 'POST') {
      sessionInsertCount += 1;
      signalSessionInsert?.();
      await sessionInsertReleased;
      return json([JSON.parse(String(init?.body))]);
    }
    if (url.endsWith('/rest/v1/exercise_instances?on_conflict=id') && method === 'POST') {
      exerciseInsertCount += 1;
      return json(JSON.parse(String(init?.body)));
    }
    if (url.endsWith('/rest/v1/rpc/finish_operation_receipt') && method === 'POST') {
      finishCount += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.p_claim_token, claimToken);
      return json([{
        finalized: true,
        reason: 'finalized',
        status: 'succeeded',
        result: body.p_result,
      }]);
    }
    throw new Error(`Unexpected mocked fetch: ${method} ${url}`);
  };
  const context = {
    auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
    config,
    dependencies: { fetcher, now: () => new Date('2026-09-05T12:00:00.000Z') },
  };
  const call = parseToolCall({
    name: 'start_workout',
    arguments: {
      operationKey: 'concurrent-start-001',
      localDate: '2026-09-05',
      timezone: 'Europe/London',
      exercises: [{ name: 'Bench press', sets: 3, reps: 8 }],
    },
  });

  const first = executeTool(context, call);
  await sessionInsertStarted;
  try {
    await assert.rejects(executeTool(context, call), /already being saved/);
  } finally {
    releaseSessionInsert?.();
  }
  const firstResult = await first;

  assert.equal((firstResult.result as { saved: boolean }).saved, true);
  assert.equal(claimCount, 2);
  assert.equal(sessionInsertCount, 1);
  assert.equal(exerciseInsertCount, 1);
  assert.equal(finishCount, 1);
});

test('[mocked] a reclaimed correction recognizes its prior versioned write', async () => {
  let receiptId = '';
  let setPatches = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/rest/v1/rpc/claim_operation_receipt')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      receiptId = String(body.p_receipt_id);
      return json([{
        claimed: true,
        reason: 'claimed',
        receipt_id: receiptId,
        operation_type: body.p_operation_type,
        status: 'pending',
        claim_token: '346b6f16-eb59-4b0a-a457-6b07498f7725',
        lease_expires_at: '2026-09-05T12:01:30.000Z',
      }]);
    }
    if (url.includes('/rest/v1/completed_sets?select=*') && method === 'GET') {
      return json([{
        id: 'set-one', user_id: USER_ID, session_id: 'session-one',
        exercise_instance_id: 'bench-one', reps: 9, load: 60,
        load_unit: 'kg', load_mode: 'total', version: 2,
        last_operation_id: receiptId,
      }]);
    }
    if (url.includes('/rest/v1/set_revisions?select=before_value')) {
      assert.match(url, new RegExp(`operation_id=eq\.${receiptId}`));
      return json([{
        before_value: {
          id: 'set-one', user_id: USER_ID, reps: 8, load: 60,
          load_unit: 'kg', load_mode: 'total', version: 1,
        },
      }]);
    }
    if (url.endsWith('/rest/v1/rpc/finish_operation_receipt')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.p_succeeded, true);
      return json([{
        finalized: true,
        reason: 'finalized',
        status: 'succeeded',
        result: body.p_result,
      }]);
    }
    if (url.includes('/rest/v1/completed_sets') && method === 'PATCH') setPatches += 1;
    throw new Error(`Unexpected mocked fetch: ${method} ${url}`);
  };
  const outcome = await executeTool(
    {
      auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
      config,
      dependencies: { fetcher, now: () => new Date('2026-09-05T12:00:00.000Z') },
    },
    parseToolCall({
      name: 'correct_set',
      arguments: {
        operationKey: 'correct-reclaim-001',
        setId: 'set-one',
        expectedVersion: 1,
        reps: 9,
      },
    }),
  );
  const result = outcome.result as Record<string, unknown>;
  assert.equal(result.saved, true);
  assert.equal(result.recovered, true);
  assert.equal((result.set as Record<string, unknown>).version, 2);
  assert.equal((result.before as Record<string, unknown>).version, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(USER_ID));
  assert.equal(setPatches, 0);
});

test('[mocked] a reclaimed undo does not apply the same reversal twice', async () => {
  let receiptId = '';
  let entityPatches = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/rest/v1/rpc/claim_operation_receipt')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      receiptId = String(body.p_receipt_id);
      return json([{
        claimed: true,
        reason: 'claimed',
        receipt_id: receiptId,
        operation_type: body.p_operation_type,
        status: 'pending',
        claim_token: '85d7d1e1-87af-4701-bdc0-5cf2cb55e045',
        lease_expires_at: '2026-09-05T12:01:30.000Z',
      }]);
    }
    if (url.includes('/rest/v1/operation_receipts?select=')) {
      assert.doesNotMatch(url, /select=\*/);
      return json([{
        id: 'target-receipt', operation_key: 'record-target-001',
        operation_type: 'record_set', entity_type: 'completed_set',
        entity_id: 'set-one', status: 'succeeded', result: { saved: true },
      }]);
    }
    if (url.includes('/rest/v1/completed_sets?select=*')) {
      return json([{ id: 'set-one', version: 2, last_operation_id: receiptId }]);
    }
    if (url.endsWith('/rest/v1/rpc/finish_operation_receipt')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json([{
        finalized: true,
        reason: 'finalized',
        status: 'succeeded',
        result: body.p_result,
      }]);
    }
    if (method === 'PATCH') entityPatches += 1;
    throw new Error(`Unexpected mocked fetch: ${method} ${url}`);
  };
  const outcome = await executeTool(
    {
      auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
      config,
      dependencies: { fetcher, now: () => new Date('2026-09-05T12:00:00.000Z') },
    },
    parseToolCall({
      name: 'undo_last_action',
      arguments: {
        operationKey: 'undo-reclaim-001',
        targetOperationKey: 'record-target-001',
      },
    }),
  );

  assert.equal((outcome.result as Record<string, unknown>).undone, true);
  assert.equal((outcome.result as Record<string, unknown>).recovered, true);
  assert.equal(entityPatches, 0);
});

test('[mocked] undo fails on a concurrent version change instead of reporting false success', async () => {
  const targetReceiptId = 'bf4ebd1c-1910-4bf9-866b-4863ccfe1027';
  let entityReads = 0;
  let patchUrl = '';
  let finishFailed = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/rest/v1/rpc/claim_operation_receipt')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json([{
        claimed: true,
        reason: 'claimed',
        receipt_id: body.p_receipt_id,
        operation_type: body.p_operation_type,
        status: 'pending',
        claim_token: '71ab570b-9c97-4502-9fa4-949d31abb043',
        lease_expires_at: '2026-09-05T12:01:30.000Z',
      }]);
    }
    if (url.includes('/rest/v1/operation_receipts?select=')) {
      return json([{
        id: targetReceiptId,
        operation_key: 'record-target-versioned-001',
        operation_type: 'record_set',
        entity_type: 'completed_set',
        entity_id: 'set-versioned',
        status: 'succeeded',
        result: { saved: true },
      }]);
    }
    if (url.includes('/rest/v1/completed_sets?select=*') && method === 'GET') {
      entityReads += 1;
      return entityReads === 1
        ? json([{
            id: 'set-versioned', version: 2, deleted_at: null,
            last_operation_id: targetReceiptId,
          }])
        : json([{
            id: 'set-versioned', version: 3, deleted_at: null,
            last_operation_id: '8e296617-125f-4ee1-bacd-c6228c8eaef5',
          }]);
    }
    if (url.includes('/rest/v1/completed_sets?select=id,version,last_operation_id') && method === 'PATCH') {
      patchUrl = url;
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer server-service-role-key');
      return json([]);
    }
    if (url.endsWith('/rest/v1/rpc/finish_operation_receipt')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      finishFailed = body.p_succeeded === false;
      return json([{
        finalized: true,
        reason: 'finalized',
        status: 'failed',
        result: null,
      }]);
    }
    throw new Error(`Unexpected mocked fetch: ${method} ${url}`);
  };

  await assert.rejects(
    executeTool(
      {
        auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
        config,
        dependencies: { fetcher, now: () => new Date('2026-09-05T12:00:00.000Z') },
      },
      parseToolCall({
        name: 'undo_last_action',
        arguments: {
          operationKey: 'undo-versioned-001',
          targetOperationKey: 'record-target-versioned-001',
        },
      }),
    ),
    /changed before it could be undone/,
  );

  assert.match(patchUrl, /version=eq\.2/);
  assert.match(patchUrl, new RegExp(`last_operation_id=eq\\.${targetReceiptId}`));
  assert.match(patchUrl, /deleted_at=is\.null/);
  assert.equal(entityReads, 2);
  assert.equal(finishFailed, true);
});

test('[mocked] undo will not revive or recancel a rest timer that already stopped', async () => {
  let timerPatches = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/rest/v1/rpc/claim_operation_receipt')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json([{
        claimed: true,
        reason: 'claimed',
        receipt_id: body.p_receipt_id,
        operation_type: body.p_operation_type,
        status: 'pending',
        claim_token: '54f84313-df9c-4290-9d7d-3baa6812da49',
        lease_expires_at: '2026-09-05T12:01:30.000Z',
      }]);
    }
    if (url.includes('/rest/v1/operation_receipts?select=')) {
      return json([{
        id: '0ec90f76-7eee-441d-9d8d-f05018482461',
        operation_key: 'start-rest-stopped-001',
        operation_type: 'start_rest_timer',
        entity_type: 'rest_timer',
        entity_id: 'stopped-timer',
        status: 'succeeded',
        result: { saved: true },
      }]);
    }
    if (url.includes('/rest/v1/rest_timers?select=*') && method === 'GET') {
      return json([{
        id: 'stopped-timer', version: 2, status: 'cancelled',
        last_operation_id: '0ec90f76-7eee-441d-9d8d-f05018482461',
      }]);
    }
    if (method === 'PATCH' && url.includes('/rest/v1/rest_timers?')) {
      timerPatches += 1;
      return json([]);
    }
    if (url.endsWith('/rest/v1/rpc/finish_operation_receipt')) {
      return json([{ finalized: true, reason: 'finalized', status: 'failed', result: null }]);
    }
    throw new Error(`Unexpected mocked fetch: ${method} ${url}`);
  };

  await assert.rejects(
    executeTool(
      {
        auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
        config,
        dependencies: { fetcher, now: () => new Date('2026-09-05T12:00:00.000Z') },
      },
      parseToolCall({
        name: 'undo_last_action',
        arguments: {
          operationKey: 'undo-stopped-rest-001',
          targetOperationKey: 'start-rest-stopped-001',
        },
      }),
    ),
    /no longer running/,
  );
  assert.equal(timerPatches, 0);
});

test('[mocked] starting rest cancels the prior running timer with owner and version guards', async () => {
  const claimToken = '4e5950bc-649c-4038-a483-51c639070dde';
  let cancelled = false;
  let savedTimer: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/rest/v1/rpc/claim_operation_receipt')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json([{
        claimed: true,
        reason: 'claimed',
        receipt_id: body.p_receipt_id,
        operation_type: body.p_operation_type,
        status: 'pending',
        claim_token: claimToken,
        lease_expires_at: '2026-09-05T12:01:30.000Z',
      }]);
    }
    if (url.includes('/rest/v1/workout_sessions?select=')) {
      return json([{
        id: 'session-one', status: 'active', local_date: '2026-09-05',
        timezone: 'Europe/London', version: 1,
      }]);
    }
    if (url.includes('/rest/v1/rest_timers?select=*') && method === 'GET') {
      return json(savedTimer ? [savedTimer] : []);
    }
    if (url.includes('/rest/v1/rest_timers?select=id,version') && method === 'GET') {
      assert.match(url, new RegExp(`user_id=eq\\.${USER_ID}`));
      assert.match(url, /session_id=eq\.session-one/);
      assert.match(url, /status=eq\.running/);
      assert.match(url, /id=neq\./);
      return json([{ id: 'prior-timer', version: 3 }]);
    }
    if (url.includes('/rest/v1/rest_timers?select=id') && method === 'PATCH') {
      assert.match(url, new RegExp(`user_id=eq\\.${USER_ID}`));
      assert.match(url, /id=eq\.prior-timer/);
      assert.match(url, /session_id=eq\.session-one/);
      assert.match(url, /status=eq\.running/);
      assert.match(url, /version=eq\.3/);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.status, 'cancelled');
      assert.equal(body.stopped_at, '2026-09-05T12:00:00.000Z');
      assert.equal(typeof body.last_operation_id, 'string');
      cancelled = true;
      return json([{ id: 'prior-timer' }]);
    }
    if (url.endsWith('/rest/v1/rest_timers?on_conflict=id') && method === 'POST') {
      assert.equal(cancelled, true);
      savedTimer = {
        ...JSON.parse(String(init?.body)) as Record<string, unknown>,
        version: 1,
      };
      return json([savedTimer]);
    }
    if (url.endsWith('/rest/v1/rpc/finish_operation_receipt')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json([{
        finalized: true,
        reason: 'finalized',
        status: 'succeeded',
        result: body.p_result,
      }]);
    }
    throw new Error(`Unexpected mocked fetch: ${method} ${url}`);
  };
  const outcome = await executeTool(
    {
      auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
      config,
      dependencies: { fetcher, now: () => new Date('2026-09-05T12:00:00.000Z') },
    },
    parseToolCall({
      name: 'start_rest_timer',
      arguments: {
        operationKey: 'replace-rest-001',
        sessionId: 'session-one',
        durationSeconds: 90,
      },
    }),
  );
  assert.equal((outcome.result as Record<string, unknown>).replacedTimerCount, 1);
  assert.equal(
    ((outcome.result as Record<string, unknown>).timer as Record<string, unknown>).status,
    'running',
  );
  assert.doesNotMatch(JSON.stringify(outcome.result), new RegExp(USER_ID));
  assert.equal(cancelled, true);
});

test('[mocked] rest replacement fails closed when the guarded cancellation loses its race', async () => {
  let exactTimerReads = 0;
  let timerInserts = 0;
  let finishFailed = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/rest/v1/rpc/claim_operation_receipt')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json([{
        claimed: true,
        reason: 'claimed',
        receipt_id: body.p_receipt_id,
        operation_type: body.p_operation_type,
        status: 'pending',
        claim_token: 'b3483778-6039-49c6-80d6-f935b0ff246b',
        lease_expires_at: '2026-09-05T12:01:30.000Z',
      }]);
    }
    if (url.includes('/rest/v1/workout_sessions?select=')) {
      return json([{
        id: 'session-one', status: 'active', local_date: '2026-09-05',
        timezone: 'Europe/London', version: 1,
      }]);
    }
    if (url.includes('/rest/v1/rest_timers?select=*') && method === 'GET') {
      exactTimerReads += 1;
      return json([]);
    }
    if (url.includes('/rest/v1/rest_timers?select=id,version') && method === 'GET') {
      return json([{ id: 'prior-timer', version: 3 }]);
    }
    if (url.includes('/rest/v1/rest_timers?select=id') && method === 'PATCH') {
      return json([]);
    }
    if (url.includes('/rest/v1/rest_timers?select=status') && method === 'GET') {
      return json([{ status: 'running' }]);
    }
    if (url.endsWith('/rest/v1/rest_timers?on_conflict=id') && method === 'POST') {
      timerInserts += 1;
      return json([]);
    }
    if (url.endsWith('/rest/v1/rpc/finish_operation_receipt')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      finishFailed = body.p_succeeded === false;
      return json([{ finalized: true, reason: 'finalized', status: 'failed', result: null }]);
    }
    throw new Error(`Unexpected mocked fetch: ${method} ${url}`);
  };

  await assert.rejects(
    executeTool(
      {
        auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
        config,
        dependencies: { fetcher, now: () => new Date('2026-09-05T12:00:00.000Z') },
      },
      parseToolCall({
        name: 'start_rest_timer',
        arguments: {
          operationKey: 'replace-rest-race-001',
          sessionId: 'session-one',
          durationSeconds: 90,
        },
      }),
    ),
    /update won the race/,
  );
  assert.equal(exactTimerReads, 1);
  assert.equal(timerInserts, 0);
  assert.equal(finishFailed, true);
});

test('[mocked] reading an expired rest timer persists its finished transition', async () => {
  let patchBody: Record<string, unknown> | undefined;
  const outcome = await executeTool(
    {
      auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
      config,
      dependencies: {
        now: () => new Date('2026-09-05T12:00:00.000Z'),
        fetcher: async (input, init) => {
          const url = String(input);
          const method = init?.method ?? 'GET';
          assert.match(url, new RegExp(`user_id=eq\\.${USER_ID}`));
          if (method === 'GET') {
            return json([{
              id: 'expired-timer', status: 'running',
              started_at: '2026-09-05T11:58:00.000Z',
              ends_at: '2026-09-05T11:59:30.000Z', version: 1,
            }]);
          }
          if (method === 'PATCH') {
            assert.match(url, /id=eq\.expired-timer/);
            assert.match(url, /status=eq\.running/);
            patchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return json([{
              id: 'expired-timer', status: 'finished',
              started_at: '2026-09-05T11:58:00.000Z',
              ends_at: '2026-09-05T11:59:30.000Z',
              stopped_at: '2026-09-05T11:59:30.000Z', version: 2,
            }]);
          }
          throw new Error(`Unexpected mocked fetch: ${method} ${url}`);
        },
      },
    },
    parseToolCall({ name: 'get_rest_status', arguments: { timerId: 'expired-timer' } }),
  );

  assert.deepEqual(patchBody, {
    status: 'finished',
    stopped_at: '2026-09-05T11:59:30.000Z',
  });
  assert.equal((outcome.result as Record<string, unknown>).remainingSeconds, 0);
  assert.equal((outcome.result as Record<string, unknown>).status, 'finished');
});

test('[mocked] reading a cancelled future timer never reports it as running', async () => {
  let patches = 0;
  const outcome = await executeTool(
    {
      auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
      config,
      dependencies: {
        now: () => new Date('2026-09-05T12:00:00.000Z'),
        fetcher: async (_input, init) => {
          if ((init?.method ?? 'GET') === 'PATCH') patches += 1;
          return json([{
            id: 'cancelled-timer', status: 'cancelled',
            started_at: '2026-09-05T11:59:00.000Z',
            ends_at: '2026-09-05T12:05:00.000Z',
            stopped_at: '2026-09-05T11:59:30.000Z', version: 2,
          }]);
        },
      },
    },
    parseToolCall({ name: 'get_rest_status', arguments: { timerId: 'cancelled-timer' } }),
  );

  assert.equal(patches, 0);
  assert.equal((outcome.result as Record<string, unknown>).remainingSeconds, 0);
  assert.equal((outcome.result as Record<string, unknown>).status, 'cancelled');
});

test('[mocked] invalid bearer never reaches a tool or OpenAI', async () => {
  let calls = 0;
  const response = await handleToolsRequest(
    authenticatedRequest(
      '/api/tools',
      JSON.stringify({ name: 'draft_workout', arguments: { exercises: [{ name: 'Walk', sets: 1 }] } }),
      'application/json',
    ),
    config,
    {
      fetcher: async () => {
        calls += 1;
        return json({ message: 'invalid token' }, 401);
      },
      randomUuid: () => 'request-id',
    },
  );
  assert.equal(response.status, 401);
  assert.equal(calls, 1);
  const payload = await response.json() as { error: { code: string } };
  assert.equal(payload.error.code, 'unauthorized');
});

test('[mocked] tools refuse to run without the server-only write credential', async () => {
  let fetchCount = 0;
  const response = await handleToolsRequest(
    authenticatedRequest(
      '/api/tools',
      JSON.stringify({ name: 'draft_workout', arguments: { exercises: [{ name: 'Walk', sets: 1 }] } }),
      'application/json',
    ),
    { ...config, supabaseServiceRoleKey: '' },
    {
      fetcher: async () => {
        fetchCount += 1;
        return authResponse();
      },
      randomUuid: () => 'request-id',
    },
  );

  assert.equal(response.status, 503);
  assert.equal(fetchCount, 0);
  const payload = await response.json() as { error: { code: string } };
  assert.equal(payload.error.code, 'not_configured');
});

test('[mocked] Realtime SDP exchange is server configured, budgeted, and call-id private', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let realtimeSession: Record<string, unknown> | undefined;
  const expectedSafetyIdentifier = await privacyPreservingUserId(USER_ID);
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/auth/v1/user')) return authResponse();
    if (url.endsWith('/rest/v1/rpc/claim_voice_session_for_user')) {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer server-service-role-key');
      assert.equal(new Headers(init?.headers).get('apikey'), 'server-service-role-key');
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, {
        p_user_id: USER_ID,
        p_session_id: VOICE_SESSION_ID,
        p_daily_minutes: 60,
        p_concurrent_limit: 1,
        p_max_session_minutes: 30,
      });
      return json([{
        allowed: true,
        reason: 'allowed',
        session_id: VOICE_SESSION_ID,
        active_count: 1,
        used_seconds: 0,
        remaining_seconds: 3600,
        expires_at: '2026-09-05T10:30:00.000Z',
      }]);
    }
    if (url.includes('/rest/v1/profiles?')) return json([{ companion_name: 'Mochi' }]);
    if (url === 'https://api.openai.com/v1/realtime/calls') {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer server-openai-key');
      assert.equal(
        new Headers(init?.headers).get('openai-safety-identifier'),
        expectedSafetyIdentifier,
      );
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get('sdp'), 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n');
      realtimeSession = JSON.parse(String(init.body.get('session')));
      return new Response('v=0\r\nm=audio 7 UDP/TLS/RTP/SAVPF 111\r\n', {
        status: 201,
        headers: {
          'Content-Type': 'application/sdp',
          Location: 'https://api.openai.com/v1/realtime/calls/call_server_only',
          'x-request-id': 'openai-request-id',
        },
      });
    }
    if (url.endsWith('/rest/v1/rpc/attach_voice_call_for_user')) {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, {
        p_user_id: USER_ID,
        p_session_id: VOICE_SESSION_ID,
        p_openai_call_id: 'call_server_only',
      });
      return json(true);
    }
    throw new Error(`Unexpected mocked fetch: ${url}`);
  };

  const response = await handleRealtimeRequest(
    authenticatedRequest(
      '/api/realtime',
      'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
      'application/sdp',
    ),
    config,
    { fetcher, randomUuid: () => VOICE_SESSION_ID },
  );

  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-knufl-voice-session'), VOICE_SESSION_ID);
  assert.equal(response.headers.get('x-knufl-voice-expires-at'), '2026-09-05T10:30:00.000Z');
  assert.equal(await response.text(), 'v=0\r\nm=audio 7 UDP/TLS/RTP/SAVPF 111\r\n');
  assert.equal(calls.length, 5);
  assert.equal(realtimeSession?.model, 'gpt-realtime-2.1');
  assert.equal((realtimeSession?.audio as { output?: { voice?: string } }).output?.voice, 'marin');
  assert.match(String(realtimeSession?.instructions), /You are Mochi/);
  assert.match(String(realtimeSession?.instructions), /Never claim an action is saved until its tool result confirms it/);
  assert.ok(Array.isArray(realtimeSession?.tools));
  assert.ok((realtimeSession?.tools as Array<{ name?: string }>).some((tool) => tool.name === 'record_set'));
  assert.ok((realtimeSession?.tools as Array<{ name?: string }>).some((tool) => tool.name === 'get_progress'));
  assert.doesNotMatch(JSON.stringify(realtimeSession), new RegExp(USER_ID));
  assert.doesNotMatch(JSON.stringify(realtimeSession), /member@example\.com/);
  assert.doesNotMatch(JSON.stringify(realtimeSession), /server-openai-key/);
  assert.doesNotMatch(JSON.stringify(realtimeSession), /server-service-role-key/);
});

test('[mocked] denied database usage budget prevents an OpenAI call', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/auth/v1/user')) return authResponse();
    if (url.endsWith('/rest/v1/rpc/claim_voice_session_for_user')) {
      return json([{
        allowed: false,
        reason: 'daily_budget_exhausted',
        session_id: VOICE_SESSION_ID,
        active_count: 0,
        used_seconds: 3600,
        remaining_seconds: 0,
        expires_at: null,
      }]);
    }
    throw new Error(`Unexpected mocked fetch: ${url}`);
  };
  const response = await handleRealtimeRequest(
    authenticatedRequest(
      '/api/realtime',
      'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
      'application/sdp',
    ),
    config,
    { fetcher, randomUuid: () => VOICE_SESSION_ID },
  );
  assert.equal(response.status, 429);
  assert.deepEqual(urls, [
    `${config.supabaseUrl}/auth/v1/user`,
    `${config.supabaseUrl}/rest/v1/rpc/claim_voice_session_for_user`,
  ]);
  const payload = await response.json() as {
    error: { code: string; details: { remainingSeconds: number } };
  };
  assert.equal(payload.error.code, 'rate_limited');
  assert.equal(payload.error.details.remainingSeconds, 0);
});

test('[mocked] Realtime refuses to run without the server-only ledger credential', async () => {
  let fetchCount = 0;
  const response = await handleRealtimeRequest(
    authenticatedRequest(
      '/api/realtime',
      'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
      'application/sdp',
    ),
    { ...config, supabaseServiceRoleKey: '' },
    {
      fetcher: async () => {
        fetchCount += 1;
        return authResponse();
      },
      randomUuid: () => VOICE_SESSION_ID,
    },
  );
  assert.equal(response.status, 503);
  assert.equal(fetchCount, 0);
  const payload = await response.json() as { error: { code: string } };
  assert.equal(payload.error.code, 'not_configured');
});

test('[mocked] progress tools refuse to combine ambiguous exercise or activity variants', async () => {
  let strengthFetches = 0;
  const strength = await executeTool(
    {
      auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
      config,
      dependencies: {
        fetcher: async (input) => {
          strengthFetches += 1;
          assert.match(String(input), /exercise_instances\?select=/);
          return json([
            { id: 'flat', exercise_key: 'bench-press', display_name: 'Bench press' },
            { id: 'incline', exercise_key: 'incline-bench-press', display_name: 'Incline bench press' },
          ]);
        },
      },
    },
    parseToolCall({ name: 'get_progress', arguments: { kind: 'strength', exercise: 'bench' } }),
  );
  const strengthResult = strength.result as Record<string, unknown>;
  assert.equal(strengthFetches, 1);
  assert.equal(strengthResult.clarificationRequired, true);
  assert.deepEqual(strengthResult.matches, ['Bench press', 'Incline bench press']);
  assert.match(String(strengthResult.summary), /exact exercise/);
  assert.deepEqual(strengthResult.points, []);

  const cardio = await executeTool(
    {
      auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
      config,
      dependencies: {
        fetcher: async () => json([
          {
            id: 'walk', activity_key: 'walking', display_name: 'Walking',
            distance: 5, distance_unit: 'km', duration_seconds: 3000,
            local_date: '2026-09-01', completed_at: '2026-09-01T08:00:00.000Z',
          },
          {
            id: 'run', activity_key: 'running', display_name: 'Running',
            distance: 5, distance_unit: 'km', duration_seconds: 1800,
            local_date: '2026-09-02', completed_at: '2026-09-02T08:00:00.000Z',
          },
        ]),
      },
    },
    parseToolCall({
      name: 'get_progress',
      arguments: { kind: 'cardio', distance: 5, distanceUnit: 'km' },
    }),
  );
  const cardioResult = cardio.result as Record<string, unknown>;
  assert.equal(cardioResult.clarificationRequired, true);
  assert.deepEqual(cardioResult.matches, ['Walking', 'Running']);
  assert.match(String(cardioResult.summary), /Choose an activity/);
  assert.deepEqual(cardioResult.points, []);
  assert.equal((cardioResult.comparison as Record<string, unknown>).comparable, false);
});

test('[mocked] progress results expose factual summaries and normalized points while retaining details', async () => {
  const strength = await executeTool(
    {
      auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
      config,
      dependencies: {
        fetcher: async (input) => {
          const url = String(input);
          if (url.includes('/exercise_instances?')) {
            return json([
              {
                id: 'bench-instance-one',
                exercise_key: 'bench-press',
                display_name: 'Bench press',
                session: { local_date: '2026-09-01', timezone: 'Europe/London' },
              },
              {
                id: 'bench-instance-two',
                exercise_key: 'bench-press',
                display_name: 'Bench press',
                session: { local_date: '2026-09-03', timezone: 'Europe/London' },
              },
            ]);
          }
          if (url.includes('/completed_sets?')) {
            return url.includes('exercise_instance_id=eq.bench-instance-one')
              ? json([{
                  id: 'set-one', reps: 8, load: 60, load_unit: 'kg', load_mode: 'total',
                  completed_at: '2026-09-01T08:00:00.000Z', version: 1,
                }])
              : json([{
                  id: 'set-two', reps: 8, load: 62.5, load_unit: 'kg', load_mode: 'total',
                  completed_at: '2026-09-03T08:00:00.000Z', version: 1,
                }]);
          }
          throw new Error(`Unexpected mocked fetch: ${url}`);
        },
      },
    },
    parseToolCall({ name: 'get_progress', arguments: { kind: 'strength', exercise: 'Bench press' } }),
  );
  const strengthResult = strength.result as Record<string, unknown>;
  assert.equal(strengthResult.status, 'ready');
  assert.match(String(strengthResult.summary), /2 comparable completed sets/);
  assert.match(String(strengthResult.summary), /8 reps at 60 kg total/);
  assert.doesNotMatch(String(strengthResult.summary), /target|planned|felt|improved/i);
  assert.equal((strengthResult.records as unknown[]).length, 2);
  assert.deepEqual(strengthResult.points, [
    {
      setId: 'set-one', completedAt: '2026-09-01T08:00:00.000Z',
      localDate: '2026-09-01', reps: 8, load: 60, loadUnit: 'kg', loadMode: 'total',
    },
    {
      setId: 'set-two', completedAt: '2026-09-03T08:00:00.000Z',
      localDate: '2026-09-03', reps: 8, load: 62.5, loadUnit: 'kg', loadMode: 'total',
    },
  ]);

  const cardio = await executeTool(
    {
      auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
      config,
      dependencies: {
        fetcher: async () => json([
          {
            id: 'run-one', activity_key: 'running', display_name: 'Running', distance: 5,
            distance_unit: 'km', duration_seconds: 1500, local_date: '2026-09-01',
            completed_at: '2026-09-01T08:00:00.000Z', timezone: 'Europe/London',
          },
          {
            id: 'run-two', activity_key: 'running', display_name: 'Running', distance: 5,
            distance_unit: 'km', duration_seconds: 1470, local_date: '2026-09-03',
            completed_at: '2026-09-03T08:00:00.000Z', timezone: 'Europe/London',
          },
        ]),
      },
    },
    parseToolCall({
      name: 'get_progress',
      arguments: { kind: 'cardio', activity: 'Running', distance: 5, distanceUnit: 'km' },
    }),
  );
  const cardioResult = cardio.result as Record<string, unknown>;
  assert.equal(cardioResult.status, 'ready');
  assert.match(String(cardioResult.summary), /1500 seconds/);
  assert.match(String(cardioResult.summary), /1470 seconds/);
  assert.equal((cardioResult.records as unknown[]).length, 2);
  assert.deepEqual(cardioResult.points, [
    {
      recordId: 'run-one', completedAt: '2026-09-01T08:00:00.000Z', localDate: '2026-09-01',
      distance: 5, distanceUnit: 'km', durationSeconds: 1500,
    },
    {
      recordId: 'run-two', completedAt: '2026-09-03T08:00:00.000Z', localDate: '2026-09-03',
      distance: 5, distanceUnit: 'km', durationSeconds: 1470,
    },
  ]);

  const completion = await executeTool(
    {
      auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
      config,
      dependencies: {
        now: () => new Date('2026-09-05T12:00:00.000Z'),
        fetcher: async () => json([
          {
            id: 'occurrence-one', scheduled_local_date: '2026-09-01',
            timezone: 'Europe/London', status: 'completed',
          },
          {
            id: 'occurrence-two', scheduled_local_date: '2026-09-03',
            timezone: 'Europe/London', status: 'scheduled',
          },
          {
            id: 'occurrence-cancelled', scheduled_local_date: '2026-09-04',
            timezone: 'Europe/London', status: 'cancelled',
          },
          {
            id: 'occurrence-future', scheduled_local_date: '2026-09-06',
            timezone: 'Europe/London', status: 'scheduled',
          },
        ]),
      },
    },
    parseToolCall({
      name: 'get_progress',
      arguments: { kind: 'completion', fromDate: '2026-09-01', toDate: '2026-09-07' },
    }),
  );
  const completionResult = completion.result as Record<string, unknown>;
  assert.equal(completionResult.completed, 1);
  assert.equal(completionResult.eligible, 2);
  assert.equal(completionResult.rate, 0.5);
  assert.match(String(completionResult.summary), /1 of 2 eligible/);
  assert.match(String(completionResult.summary), /Future and cancelled occurrences are excluded/);
  assert.deepEqual(completionResult.points, [
    {
      occurrenceId: 'occurrence-one', scheduledLocalDate: '2026-09-01',
      status: 'completed', completed: true,
    },
    {
      occurrenceId: 'occurrence-two', scheduledLocalDate: '2026-09-03',
      status: 'scheduled', completed: false,
    },
  ]);
});

test('[mocked] session context returns owner-scoped recovery data without an active workout', async () => {
  const urls: string[] = [];
  const contextResult = await executeTool(
    {
      auth: { bearerToken: 'user-access-token', user: { id: USER_ID } },
      config,
      dependencies: {
        now: () => new Date('2026-09-05T12:00:00.000Z'),
        fetcher: async (input) => {
          const url = String(input);
          urls.push(url);
          assert.match(url, new RegExp(`user_id=eq\\.${USER_ID}`));
          if (url.includes('/profiles?')) return json([{ companion_name: 'Mochi', version: 2 }]);
          if (url.includes('/preferences?')) {
            return json([{
              user_id: USER_ID,
              timezone: 'Europe/London',
              measurement_system: 'metric',
              reduced_motion: false,
            }]);
          }
          if (url.includes('/workout_plans?')) {
            return json([{
              id: 'legacy-plan-1',
              user_id: USER_ID,
              name: 'Three steady days',
              status: 'active',
            }]);
          }
          if (url.includes('/plan_exercises?')) {
            return json([{
              id: 'legacy-plan-exercise-1',
              user_id: USER_ID,
              plan_id: 'legacy-plan-1',
              position: 0,
              display_name: 'Bench press',
            }]);
          }
          if (url.includes('/workout_occurrences?')) {
            return json([{
              id: 'legacy-occurrence-1',
              user_id: USER_ID,
              plan_id: 'legacy-plan-1',
              scheduled_local_date: '2026-09-06',
              status: 'scheduled',
            }]);
          }
          if (url.includes('/workout_sessions?') && url.includes('status=eq.active')) return json([]);
          if (url.includes('/workout_sessions?')) {
            return json([{
              id: 'legacy-session-1',
              user_id: USER_ID,
              status: 'completed',
              local_date: '2026-09-04',
            }]);
          }
          if (url.includes('/memories?')) {
            return json([{ id: 'legacy-memory-1', title: 'Our first session', note: 'We showed up.' }]);
          }
          if (url.includes('/exercise_day_credits?')) {
            return json([{ local_date: '2026-09-04', timezone: 'Europe/London' }]);
          }
          if (url.includes('/milestone_unlocks?')) {
            return json([{ milestone_id: 'first-session' }]);
          }
          if (url.includes('/rest_timers?')) {
            return json([{ id: 'legacy-timer-1', status: 'finished' }]);
          }
          throw new Error(`Unexpected mocked fetch: ${url}`);
        },
      },
    },
    parseToolCall({ name: 'get_session_context', arguments: {} }),
  );
  const recovered = contextResult.result as Record<string, unknown>;
  assert.equal(urls.length, 11);
  assert.equal(recovered.companionName, 'Mochi');
  assert.equal(recovered.session, null);
  assert.deepEqual(recovered.preferences, {
    timezone: 'Europe/London',
    measurement_system: 'metric',
    reduced_motion: false,
  });
  assert.deepEqual(recovered.plans, [
    { id: 'legacy-plan-1', name: 'Three steady days', status: 'active' },
  ]);
  assert.deepEqual(recovered.planExercises, [{
    id: 'legacy-plan-exercise-1',
    plan_id: 'legacy-plan-1',
    position: 0,
    display_name: 'Bench press',
  }]);
  assert.deepEqual(recovered.occurrences, [{
    id: 'legacy-occurrence-1',
    plan_id: 'legacy-plan-1',
    scheduled_local_date: '2026-09-06',
    status: 'scheduled',
  }]);
  assert.deepEqual(recovered.recentSessions, [
    { id: 'legacy-session-1', status: 'completed', local_date: '2026-09-04' },
  ]);
  assert.deepEqual(recovered.memories, [
    { id: 'legacy-memory-1', title: 'Our first session', note: 'We showed up.' },
  ]);
  assert.deepEqual(recovered.exerciseDayCredits, [
    { local_date: '2026-09-04', timezone: 'Europe/London' },
  ]);
  assert.deepEqual(recovered.credits, recovered.exerciseDayCredits);
  assert.deepEqual(recovered.milestones, [{ milestone_id: 'first-session' }]);
  assert.deepEqual(recovered.latestRestTimer, { id: 'legacy-timer-1', status: 'finished' });
  assert.doesNotMatch(JSON.stringify(recovered), new RegExp(USER_ID));
});

test('[mocked] oversized SDP is rejected before the voice provider', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/auth/v1/user')) return authResponse();
    throw new Error(`Unexpected mocked fetch: ${url}`);
  };
  const response = await handleRealtimeRequest(
    authenticatedRequest(
      '/api/realtime',
      'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
      'application/sdp',
      { 'Content-Length': String(64 * 1024 + 1) },
    ),
    config,
    { fetcher, randomUuid: () => VOICE_SESSION_ID },
  );
  assert.equal(response.status, 413);
  assert.deepEqual(urls, [`${config.supabaseUrl}/auth/v1/user`]);
});

test('[mocked] closing a voice session uses only its authenticated database record', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/auth/v1/user')) return authResponse();
    if (url.includes('/rest/v1/voice_usage_sessions?')) {
      assert.match(url, new RegExp(`user_id=eq\\.${USER_ID}`));
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer server-service-role-key');
      assert.equal(new Headers(init?.headers).get('apikey'), 'server-service-role-key');
      return json([{
        id: VOICE_SESSION_ID,
        status: 'active',
        openai_call_id: 'call_server_only',
        started_at: '2026-09-05T10:00:00.000Z',
        expires_at: '2026-09-05T10:30:00.000Z',
      }]);
    }
    if (url.endsWith('/realtime/calls/call_server_only/hangup')) {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer server-openai-key');
      return new Response(null, { status: 200 });
    }
    if (url.endsWith('/rest/v1/rpc/close_voice_session_for_user')) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        p_user_id: USER_ID,
        p_session_id: VOICE_SESSION_ID,
        p_openai_call_id: null,
      });
      return json([{
        closed: true,
        session_id: VOICE_SESSION_ID,
        used_seconds: 95,
      }]);
    }
    throw new Error(`Unexpected mocked fetch: ${url}`);
  };
  const response = await handleRealtimeCloseRequest(
    authenticatedRequest(
      '/api/realtime/close',
      JSON.stringify({ sessionId: VOICE_SESSION_ID }),
      'application/json',
    ),
    config,
    { fetcher, randomUuid: () => 'request-id' },
  );
  assert.equal(response.status, 200);
  assert.equal(urls.length, 4);
  const payload = await response.json() as {
    result: { closed: boolean; providerHungUp: boolean };
  };
  assert.equal(payload.result.closed, true);
  assert.equal(payload.result.providerHungUp, true);
  assert.doesNotMatch(JSON.stringify(payload), /call_server_only/);
});

test('[mocked] stable identifiers are pseudonymous and deterministic', async () => {
  const privacyId = await privacyPreservingUserId(USER_ID);
  assert.match(privacyId, /^[a-f0-9]{64}$/);
  assert.notEqual(privacyId, USER_ID);
  assert.equal(privacyId, await privacyPreservingUserId(USER_ID));

  const first = await deterministicUuid(USER_ID, 'completed_set', 'record-set-001');
  const second = await deterministicUuid(USER_ID, 'completed_set', 'record-set-001');
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f-]{36}$/);
});

test('[mocked] configuration defaults are bounded and secrets remain server-only', () => {
  const parsed = readServerConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co/',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service-secret',
    OPENAI_API_KEY: 'secret',
    KNUFL_DAILY_REALTIME_MINUTES: '99999',
    KNUFL_MAX_ACTIVE_REALTIME_SESSIONS: '0',
  });
  assert.equal(parsed.supabaseUrl, 'https://project.supabase.co');
  assert.equal(parsed.realtimeModel, 'gpt-realtime-2.1');
  assert.equal(parsed.dailyRealtimeMinutes, 240);
  assert.equal(parsed.maxActiveRealtimeSessions, 1);
  assert.equal(parsed.openAiApiKey, 'secret');
  assert.equal(parsed.supabaseServiceRoleKey, 'service-secret');
  assert.throws(
    () => assertSameOrigin(new Request(`${API_ORIGIN}/api/tools`, { headers: { Origin: 'null' } })),
    /Cross-origin API requests are not allowed/,
  );
});

test('[mocked] public config enables Realtime only when both server credentials exist', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalSupabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'sb_publishable_abcdefghijklmnopqrstuvwxyz';
    process.env.OPENAI_API_KEY = 'server-openai-key';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const incomplete = await getClientConfig();
    const incompletePayload = await incomplete.json() as Record<string, unknown>;
    assert.equal(incompletePayload.realtimeConfigured, false);
    assert.equal('openAiApiKey' in incompletePayload, false);
    assert.equal('supabaseServiceRoleKey' in incompletePayload, false);

    process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-service-role-key';
    const complete = await getClientConfig();
    const completePayload = await complete.json() as Record<string, unknown>;
    assert.equal(completePayload.realtimeConfigured, true);
    assert.doesNotMatch(JSON.stringify(completePayload), /server-openai-key|server-service-role-key/);
  } finally {
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey;
    if (originalSupabaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
    if (originalSupabaseAnonKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalSupabaseAnonKey;
  }
});
