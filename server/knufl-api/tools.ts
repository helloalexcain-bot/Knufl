import {
  type LoadMode,
  type ParsedToolCall,
  type ToolArguments,
  type ToolName,
} from './contracts.ts';
import type { AuthContext } from './auth.ts';
import type { KnuflServerConfig } from './config.ts';
import { ApiError } from './errors.ts';
import {
  deterministicUuid,
  encodeFilter,
  supabaseRequest,
  type SupabaseClientContext,
} from './supabase.ts';

type DataRow = Record<string, unknown>;

export interface ToolDependencies {
  fetcher?: typeof fetch;
  now?: () => Date;
}

export interface ToolExecutionContext {
  auth: AuthContext;
  config: KnuflServerConfig;
  dependencies?: ToolDependencies;
}

export interface ToolExecutionResult {
  tool: ToolName;
  result: unknown;
}

interface ReceiptRow extends DataRow {
  id: string;
  operation_key: string;
  operation_type: string;
  entity_type?: string;
  entity_id?: string;
  status: 'pending' | 'succeeded' | 'failed';
  result?: unknown;
}

interface ReceiptClaimRow extends DataRow {
  claimed: boolean;
  reason: string;
  receipt_id: string;
  operation_type: string;
  status: 'pending' | 'succeeded' | 'failed';
  claim_token?: string | null;
  lease_expires_at?: string | null;
  result?: unknown;
  entity_type?: string | null;
  entity_id?: string | null;
  error_code?: string | null;
}

interface ReceiptFinishRow extends DataRow {
  finalized: boolean;
  reason: string;
  status: 'pending' | 'succeeded' | 'failed';
  result?: unknown;
}

interface MutationOutcome {
  value: unknown;
  entityType?: string;
  entityId?: string;
}

const duplicateResult = (value: unknown): DataRow => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as DataRow), duplicate: true }
    : { result: value, duplicate: true }
);

const nowFor = (context: ToolExecutionContext): Date =>
  context.dependencies?.now?.() ?? new Date();

const dbFor = (context: ToolExecutionContext): SupabaseClientContext => ({
  config: context.config,
  bearerToken: context.auth.bearerToken,
  fetcher: context.dependencies?.fetcher,
});

const writeDbFor = (context: ToolExecutionContext): SupabaseClientContext => ({
  config: context.config,
  bearerToken: context.config.supabaseServiceRoleKey,
  apiKey: context.config.supabaseServiceRoleKey,
  fetcher: context.dependencies?.fetcher,
});

const rows = (value: unknown): DataRow[] => (Array.isArray(value) ? (value as DataRow[]) : []);
const firstRow = (value: unknown): DataRow | undefined => rows(value)[0];

const positiveVersion = (value: unknown): number | undefined => {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : undefined;
};

const userFilter = (userId: string): string => `user_id=eq.${encodeFilter(userId)}`;
const eqFilter = (field: string, value: string): string => `${field}=eq.${encodeFilter(value)}`;

const exerciseKey = (name: string): string =>
  name
    .trim()
    .toLocaleLowerCase('en')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 160) || 'exercise';

const databaseLoadMode = (mode: LoadMode | undefined): string | null | undefined => {
  switch (mode) {
    case 'per_dumbbell':
    case 'per-dumbbell':
      return 'per-dumbbell';
    case 'barbell_total':
    case 'machine_total':
    case 'total':
      return 'total';
    case 'bodyweight':
      return 'bodyweight';
    case 'assisted':
      return 'assisted';
    case 'not_applicable':
      return null;
    default:
      return undefined;
  }
};

const cleanRecord = (value: DataRow): DataRow => {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
};

const publicRestTimer = (timer: DataRow): DataRow => cleanRecord({
  id: timer.id,
  status: timer.status,
  startedAt: timer.started_at,
  endsAt: timer.ends_at,
  stoppedAt: timer.stopped_at,
});

const insertRows = async (
  context: ToolExecutionContext,
  table: string,
  body: DataRow | DataRow[],
  options: { idempotent?: boolean } = {},
): Promise<DataRow[]> => {
  const suffix = options.idempotent ? '?on_conflict=id' : '';
  return rows(
    await supabaseRequest<unknown>(writeDbFor(context), `/rest/v1/${table}${suffix}`, {
      method: 'POST',
      body,
      prefer: options.idempotent
        ? 'resolution=ignore-duplicates,return=representation'
        : 'return=representation',
    }),
  );
};

const claimReceipt = async (
  context: ToolExecutionContext,
  operationKey: string,
  operationType: ToolName,
  receiptId: string,
): Promise<ReceiptClaimRow> => {
  const payload = await supabaseRequest<unknown>(
    dbFor(context),
    '/rest/v1/rpc/claim_operation_receipt',
    {
      method: 'POST',
      body: {
        p_operation_key: operationKey,
        p_operation_type: operationType,
        p_receipt_id: receiptId,
        p_client_created_at: nowFor(context).toISOString(),
        p_lease_seconds: 90,
      },
    },
  );
  const claim = firstRow(payload) as ReceiptClaimRow | undefined;
  if (
    !claim ||
    typeof claim.claimed !== 'boolean' ||
    typeof claim.receipt_id !== 'string' ||
    typeof claim.operation_type !== 'string' ||
    typeof claim.status !== 'string'
  ) {
    throw new ApiError(503, 'provider_error', 'The action could not be reserved safely.');
  }
  return claim;
};

const finishReceipt = async (
  context: ToolExecutionContext,
  claim: ReceiptClaimRow,
  succeeded: boolean,
  outcome?: MutationOutcome,
  errorCode?: string,
): Promise<ReceiptFinishRow> => {
  const payload = await supabaseRequest<unknown>(
    dbFor(context),
    '/rest/v1/rpc/finish_operation_receipt',
    {
      method: 'POST',
      body: {
        p_receipt_id: claim.receipt_id,
        p_claim_token: claim.claim_token,
        p_succeeded: succeeded,
        p_entity_type: outcome?.entityType ?? null,
        p_entity_id: outcome?.entityId ?? null,
        p_result: outcome?.value ?? null,
        p_error_code: errorCode ?? null,
        p_completed_at: nowFor(context).toISOString(),
      },
    },
  );
  const finish = firstRow(payload) as ReceiptFinishRow | undefined;
  if (
    !finish ||
    typeof finish.finalized !== 'boolean' ||
    typeof finish.reason !== 'string' ||
    typeof finish.status !== 'string'
  ) {
    throw new ApiError(503, 'provider_error', 'The action result could not be committed safely.');
  }
  return finish;
};

const withIdempotency = async (
  context: ToolExecutionContext,
  operationKey: string,
  operationType: ToolName,
  execute: (receiptId: string) => Promise<MutationOutcome>,
): Promise<unknown> => {
  const receiptId = await deterministicUuid(
    context.auth.user.id,
    'operation_receipt',
    operationKey,
  );
  const claim = await claimReceipt(context, operationKey, operationType, receiptId);

  // Type identity is part of an idempotency key. Check it before accepting any
  // cached success so a key can never replay the result of a different tool.
  if (claim.operation_type !== operationType) {
    throw new ApiError(409, 'conflict', 'That operation key was already used for another action.');
  }
  if (claim.status === 'succeeded') return duplicateResult(claim.result);
  if (!claim.claimed) {
    throw new ApiError(
      409,
      'conflict',
      claim.reason === 'in_progress'
        ? 'That action is already being saved. Retry shortly.'
        : 'That action could not be reserved safely.',
      { reason: claim.reason, retryable: claim.reason === 'in_progress' },
    );
  }
  if (typeof claim.claim_token !== 'string' || !claim.claim_token) {
    throw new ApiError(503, 'provider_error', 'The action could not be reserved safely.');
  }

  let outcome: MutationOutcome;
  try {
    outcome = await execute(claim.receipt_id);
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'provider_error';
    await finishReceipt(context, claim, false, undefined, code).catch(() => undefined);
    throw error;
  }

  // Once the mutation succeeds, do not mark the receipt failed merely because
  // acknowledgement was lost. A later retry can reclaim the lease and use the
  // deterministic entity identifiers to recover safely.
  const finish = await finishReceipt(context, claim, true, outcome);
  if (!finish.finalized || finish.status !== 'succeeded') {
    if (finish.status === 'succeeded') {
      return duplicateResult(finish.result ?? outcome.value);
    }
    throw new ApiError(409, 'conflict', 'That action was superseded while it was being saved.', {
      reason: finish.reason,
      retryable: true,
    });
  }
  return finish.result ?? outcome.value;
};

const findSession = async (
  context: ToolExecutionContext,
  sessionId?: string,
): Promise<DataRow | undefined> => {
  const selector = sessionId
    ? `&${eqFilter('id', sessionId)}`
    : '&status=eq.active&order=started_at.desc&limit=1';
  const payload = await supabaseRequest<unknown>(
    dbFor(context),
    `/rest/v1/workout_sessions?select=*&${userFilter(context.auth.user.id)}${selector}`,
  );
  return firstRow(payload);
};

const requireActiveSession = async (
  context: ToolExecutionContext,
  sessionId: string,
): Promise<DataRow> => {
  const session = await findSession(context, sessionId);
  if (!session) throw new ApiError(404, 'not_found', 'That workout session was not found.');
  if (session.status !== 'active') {
    throw new ApiError(409, 'conflict', 'That workout is no longer active.');
  }
  return session;
};

const getSessionContext = async (
  context: ToolExecutionContext,
  args: ToolArguments['get_session_context'],
): Promise<unknown> => {
  const [
    profiles,
    preferencesPayload,
    plansPayload,
    planExercisesPayload,
    occurrencesPayload,
    session,
    recentSessionsPayload,
    memoriesPayload,
    creditsPayload,
    milestonesPayload,
  ] = await Promise.all([
    supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/profiles?select=companion_name,version&${userFilter(context.auth.user.id)}&limit=1`,
    ),
    supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/preferences?select=*&${userFilter(context.auth.user.id)}&limit=1`,
    ),
    supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/workout_plans?select=*&${userFilter(
        context.auth.user.id,
      )}&order=created_at.asc&limit=100`,
    ),
    supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/plan_exercises?select=*&${userFilter(
        context.auth.user.id,
      )}&order=plan_id.asc,position.asc&limit=1000`,
    ),
    supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/workout_occurrences?select=*&${userFilter(
        context.auth.user.id,
      )}&order=scheduled_local_date.asc&limit=1000`,
    ),
    findSession(context, args.sessionId),
    supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/workout_sessions?select=*&${userFilter(
        context.auth.user.id,
      )}&order=started_at.desc&limit=50`,
    ),
    supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/memories?select=*&${userFilter(
        context.auth.user.id,
      )}&deleted_at=is.null&order=created_at.desc&limit=100`,
    ),
    supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/exercise_day_credits?select=*&${userFilter(
        context.auth.user.id,
      )}&order=local_date.asc&limit=1000`,
    ),
    supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/milestone_unlocks?select=*&${userFilter(
        context.auth.user.id,
      )}&order=unlocked_at.asc&limit=1000`,
    ),
  ]);

  const recentSessions = rows(recentSessionsPayload);
  const memories = rows(memoriesPayload);
  const exerciseDayCredits = rows(creditsPayload);
  const milestones = rows(milestonesPayload);
  const sharedContext = {
    companionName: firstRow(profiles)?.companion_name ?? 'Knufl',
    preferences: firstRow(preferencesPayload) ?? null,
    plans: rows(plansPayload),
    planExercises: rows(planExercisesPayload),
    occurrences: rows(occurrencesPayload),
    recentSessions,
    memories,
    exerciseDayCredits,
    credits: exerciseDayCredits,
    milestones,
  };
  if (!session) {
    const timerPayload = await supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/rest_timers?select=*&${userFilter(
        context.auth.user.id,
      )}&order=started_at.desc&limit=1`,
    );
    return {
      ...sharedContext,
      session: null,
      exercises: [],
      completedSets: [],
      latestRestTimer: firstRow(timerPayload) ?? null,
      serverNow: nowFor(context).toISOString(),
    };
  }
  const sessionId = String(session.id);
  const [exercises, sets, timers] = await Promise.all([
    supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/exercise_instances?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
        'session_id',
        sessionId,
      )}&order=position.asc`,
    ),
    supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/completed_sets?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
        'session_id',
        sessionId,
      )}&deleted_at=is.null&order=completed_at.asc`,
    ),
    supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/rest_timers?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
        'session_id',
        sessionId,
      )}&order=started_at.desc&limit=1`,
    ),
  ]);
  return {
    ...sharedContext,
    session,
    exercises: rows(exercises),
    completedSets: rows(sets),
    latestRestTimer: firstRow(timers) ?? null,
    serverNow: nowFor(context).toISOString(),
  };
};

const draftWorkout = (args: ToolArguments['draft_workout']): unknown => ({
  saved: false,
  title: args.title ?? 'Workout',
  exercises: args.exercises,
  confirmationRequired: true,
  note: 'This is planned work. No completed sets have been recorded.',
});

const startWorkout = async (
  context: ToolExecutionContext,
  args: ToolArguments['start_workout'],
): Promise<unknown> =>
  withIdempotency(context, args.operationKey, 'start_workout', async (receiptId) => {
    const sessionId = await deterministicUuid(context.auth.user.id, 'workout_session', args.operationKey);
    const startedAt = nowFor(context).toISOString();
    await insertRows(
      context,
      'workout_sessions',
      cleanRecord({
        id: sessionId,
        user_id: context.auth.user.id,
        occurrence_id: args.plannedOccurrenceId,
        source: args.plannedOccurrenceId ? 'planned' : 'manual',
        status: 'active',
        local_date: args.localDate,
        timezone: args.timezone,
        started_at: startedAt,
        notes: args.title,
      }),
      { idempotent: true },
    );

    const instances = await Promise.all(
      args.exercises.map(async (exercise, position) => ({
        id: await deterministicUuid(
          context.auth.user.id,
          'exercise_instance',
          `${args.operationKey}:${position}`,
        ),
        user_id: context.auth.user.id,
        session_id: sessionId,
        position,
        exercise_key: exerciseKey(exercise.name),
        display_name: exercise.name,
        planned_sets: exercise.sets,
        planned_reps: exercise.reps,
        planned_load: exercise.load,
        planned_load_unit: exercise.loadUnit,
        planned_load_mode: databaseLoadMode(exercise.loadMode),
        rest_seconds: exercise.restSeconds,
      })),
    );
    await insertRows(context, 'exercise_instances', instances.map(cleanRecord), { idempotent: true });

    return {
      entityType: 'workout_session',
      entityId: sessionId,
      value: {
        saved: true,
        session: {
          id: sessionId,
          version: 1,
          status: 'active',
          localDate: args.localDate,
          timezone: args.timezone,
          startedAt,
        },
        exercises: instances.map((exercise) => ({
          id: exercise.id,
          name: exercise.display_name,
          plannedSets: exercise.planned_sets,
          plannedReps: exercise.planned_reps,
          plannedLoad: exercise.planned_load,
          plannedLoadUnit: exercise.planned_load_unit,
          restSeconds: exercise.rest_seconds,
        })),
        completedSetCount: 0,
        operationReceiptId: receiptId,
      },
    };
  });

const recordSet = async (
  context: ToolExecutionContext,
  args: ToolArguments['record_set'],
): Promise<unknown> =>
  withIdempotency(context, args.operationKey, 'record_set', async (receiptId) => {
    await requireActiveSession(context, args.sessionId);
    const exercisePayload = await supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/exercise_instances?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
        'id',
        args.exerciseInstanceId,
      )}&${eqFilter('session_id', args.sessionId)}&limit=1`,
    );
    const exercise = firstRow(exercisePayload);
    if (!exercise) {
      throw new ApiError(404, 'not_found', 'The selected exercise is not part of this workout.');
    }
    const priorPayload = await supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/completed_sets?select=set_order&${userFilter(context.auth.user.id)}&${eqFilter(
        'exercise_instance_id',
        args.exerciseInstanceId,
      )}&deleted_at=is.null&order=set_order.desc&limit=1`,
    );
    const previousOrder = Number(firstRow(priorPayload)?.set_order ?? 0);
    const setId = await deterministicUuid(context.auth.user.id, 'completed_set', args.operationKey);
    const completedAt = args.completedAt ?? nowFor(context).toISOString();
    await insertRows(
      context,
      'completed_sets',
      cleanRecord({
        id: setId,
        user_id: context.auth.user.id,
        session_id: args.sessionId,
        exercise_instance_id: args.exerciseInstanceId,
        set_order: previousOrder + 1,
        reps: args.reps,
        load: args.load,
        load_unit: args.loadUnit,
        load_mode: databaseLoadMode(args.loadMode),
        effort: args.effort,
        feeling: args.feeling,
        completed_at: completedAt,
        last_operation_id: receiptId,
      }),
      { idempotent: true },
    );
    const savedPayload = await supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/completed_sets?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
        'id',
        setId,
      )}&limit=1`,
    );
    const saved = firstRow(savedPayload);
    if (!saved) throw new ApiError(503, 'provider_error', 'The set was not confirmed by cloud storage.');
    return {
      entityType: 'completed_set',
      entityId: setId,
      value: {
        saved: true,
        set: saved,
        exercise: { id: exercise.id, name: exercise.display_name },
        restSeconds: exercise.rest_seconds ?? null,
        workoutCompleted: false,
      },
    };
  });

const recordConflict = async (
  context: ToolExecutionContext,
  operationKey: string,
  entityType: string,
  entityId: string,
  expectedVersion: number,
  actualVersion: number,
  clientPayload: unknown,
): Promise<void> => {
  const conflictId = await deterministicUuid(context.auth.user.id, 'sync_conflict', operationKey);
  await insertRows(
    context,
    'sync_conflicts',
    {
      id: conflictId,
      user_id: context.auth.user.id,
      entity_type: entityType,
      entity_id: entityId,
      expected_version: expectedVersion,
      actual_version: actualVersion,
      client_payload: clientPayload,
      status: 'open',
    },
    { idempotent: true },
  );
};

const correctSet = async (
  context: ToolExecutionContext,
  args: ToolArguments['correct_set'],
): Promise<unknown> =>
  withIdempotency(context, args.operationKey, 'correct_set', async (receiptId) => {
    const existingPayload = await supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/completed_sets?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
        'id',
        args.setId,
      )}&deleted_at=is.null&limit=1`,
    );
    const before = firstRow(existingPayload);
    if (!before) throw new ApiError(404, 'not_found', 'That saved set was not found.');
    const actualVersion = Number(before.version);
    if (before.last_operation_id === receiptId) {
      const revisionPayload = await supabaseRequest<unknown>(
        dbFor(context),
        `/rest/v1/set_revisions?select=before_value&${userFilter(
          context.auth.user.id,
        )}&${eqFilter('set_id', args.setId)}&${eqFilter(
          'operation_id',
          receiptId,
        )}&order=created_at.desc&limit=1`,
      );
      const previousValue = firstRow(revisionPayload)?.before_value;
      return {
        entityType: 'completed_set',
        entityId: args.setId,
        value: {
          saved: true,
          recovered: true,
          set: before,
          ...(previousValue && typeof previousValue === 'object'
            ? { before: previousValue }
            : {}),
        },
      };
    }
    if (actualVersion !== args.expectedVersion) {
      await recordConflict(
        context,
        args.operationKey,
        'completed_set',
        args.setId,
        args.expectedVersion,
        actualVersion,
        args,
      );
      throw new ApiError(409, 'conflict', 'That set changed on another device.', {
        expectedVersion: args.expectedVersion,
        actualVersion,
      });
    }
    const clearsLoad = args.loadMode === 'bodyweight' || args.loadMode === 'not_applicable';
    const effectiveLoad = clearsLoad ? null : args.load ?? before.load;
    const effectiveUnit = clearsLoad ? null : args.loadUnit ?? before.load_unit;
    if (typeof effectiveLoad === 'number' && !effectiveUnit) {
      throw new ApiError(
        400,
        'validation_error',
        'A corrected numeric load needs a known load unit.',
      );
    }
    if (args.loadUnit !== undefined && effectiveLoad === null) {
      throw new ApiError(
        400,
        'validation_error',
        'A load unit cannot be saved without a numeric load.',
      );
    }
    const patch = cleanRecord({
      reps: args.reps,
      load: clearsLoad ? null : args.load,
      load_unit: clearsLoad ? null : args.loadUnit,
      load_mode: databaseLoadMode(args.loadMode),
      effort: args.effort,
      corrected_at: nowFor(context).toISOString(),
      last_operation_id: receiptId,
    });
    const updatedPayload = await supabaseRequest<unknown>(
      writeDbFor(context),
      `/rest/v1/completed_sets?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
        'id',
        args.setId,
      )}&version=eq.${args.expectedVersion}&deleted_at=is.null`,
      { method: 'PATCH', body: patch, prefer: 'return=representation' },
    );
    const updated = firstRow(updatedPayload);
    if (!updated) {
      const freshPayload = await supabaseRequest<unknown>(
        dbFor(context),
        `/rest/v1/completed_sets?select=version&${userFilter(context.auth.user.id)}&${eqFilter(
          'id',
          args.setId,
        )}&limit=1`,
      );
      const freshVersion = Number(firstRow(freshPayload)?.version ?? actualVersion);
      await recordConflict(
        context,
        args.operationKey,
        'completed_set',
        args.setId,
        args.expectedVersion,
        freshVersion,
        args,
      );
      throw new ApiError(409, 'conflict', 'That set changed on another device.', {
        expectedVersion: args.expectedVersion,
        actualVersion: freshVersion,
      });
    }
    return {
      entityType: 'completed_set',
      entityId: args.setId,
      value: { saved: true, set: updated, before },
    };
  });

const startRestTimer = async (
  context: ToolExecutionContext,
  args: ToolArguments['start_rest_timer'],
): Promise<unknown> =>
  withIdempotency(context, args.operationKey, 'start_rest_timer', async (receiptId) => {
    await requireActiveSession(context, args.sessionId);
    const timerId = await deterministicUuid(context.auth.user.id, 'rest_timer', args.operationKey);
    const startedAt = args.startedAt ?? nowFor(context).toISOString();
    const endsAt = new Date(Date.parse(startedAt) + args.durationSeconds * 1000).toISOString();
    const existingTimerPayload = await supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/rest_timers?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
        'id',
        timerId,
      )}&limit=1`,
    );
    const existingTimer = firstRow(existingTimerPayload);
    if (existingTimer) {
      const existingDurationSeconds =
        (Date.parse(String(existingTimer.ends_at)) - Date.parse(String(existingTimer.started_at))) / 1000;
      if (
        existingTimer.session_id !== args.sessionId
        || existingDurationSeconds !== args.durationSeconds
      ) {
        throw new ApiError(
          409,
          'conflict',
          'That operation key was already used for a different rest timer.',
        );
      }
      const existingStatus = String(existingTimer.status);
      const remainingSeconds = existingStatus === 'running'
        ? Math.max(
            0,
            Math.ceil((Date.parse(String(existingTimer.ends_at)) - nowFor(context).getTime()) / 1000),
          )
        : 0;
      return {
        entityType: 'rest_timer',
        entityId: timerId,
        value: {
          saved: true,
          recovered: true,
          timer: publicRestTimer(existingTimer),
          remainingSeconds,
          replacedTimerCount: 0,
        },
      };
    }
    const runningPayload = await supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/rest_timers?select=id,version&${userFilter(
        context.auth.user.id,
      )}&${eqFilter('session_id', args.sessionId)}&status=eq.running&id=neq.${encodeFilter(
        timerId,
      )}`,
    );
    const runningTimers = rows(runningPayload);
    if (runningTimers.length > 1) {
      throw new ApiError(503, 'provider_error', 'The existing rest timer could not be replaced safely.');
    }
    let replacedTimerCount = 0;
    const runningTimer = runningTimers[0];
    if (runningTimer) {
      const timerVersion = positiveVersion(runningTimer.version);
      if (typeof runningTimer.id !== 'string' || timerVersion === undefined) {
        throw new ApiError(503, 'provider_error', 'The existing rest timer could not be replaced safely.');
      }
      const cancelledPayload = await supabaseRequest<unknown>(
        writeDbFor(context),
        `/rest/v1/rest_timers?select=id&${userFilter(
          context.auth.user.id,
        )}&${eqFilter('id', runningTimer.id)}&${eqFilter(
          'session_id',
          args.sessionId,
        )}&status=eq.running&version=eq.${timerVersion}`,
        {
          method: 'PATCH',
          body: {
            status: 'cancelled',
            stopped_at: startedAt,
            last_operation_id: receiptId,
          },
          prefer: 'return=representation',
        },
      );
      const cancellationCount = rows(cancelledPayload).length;
      if (cancellationCount > 1) {
        throw new ApiError(503, 'provider_error', 'The existing rest timer could not be replaced safely.');
      }
      if (cancellationCount === 0) {
        const latestPayload = await supabaseRequest<unknown>(
          dbFor(context),
          `/rest/v1/rest_timers?select=status&${userFilter(
            context.auth.user.id,
          )}&${eqFilter('id', runningTimer.id)}&limit=1`,
        );
        if (firstRow(latestPayload)?.status === 'running') {
          throw new ApiError(
            409,
            'conflict',
            'Another rest timer update won the race. Retry to replace it.',
            { retryable: true },
          );
        }
      } else {
        replacedTimerCount = 1;
      }
    }
    try {
      await insertRows(
        context,
        'rest_timers',
        {
          id: timerId,
          user_id: context.auth.user.id,
          session_id: args.sessionId,
          status: 'running',
          started_at: startedAt,
          ends_at: endsAt,
          last_operation_id: receiptId,
        },
        { idempotent: true },
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === 'conflict') {
        throw new ApiError(
          409,
          'conflict',
          'Another rest timer started at the same time. Retry to replace it.',
          { retryable: true },
        );
      }
      throw error;
    }
    const savedPayload = await supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/rest_timers?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
        'id',
        timerId,
      )}&limit=1`,
    );
    const savedTimer = firstRow(savedPayload);
    const savedDurationSeconds = savedTimer
      ? (Date.parse(String(savedTimer.ends_at)) - Date.parse(String(savedTimer.started_at))) / 1000
      : Number.NaN;
    if (
      !savedTimer
      || savedTimer.session_id !== args.sessionId
      || savedDurationSeconds !== args.durationSeconds
    ) {
      throw new ApiError(503, 'provider_error', 'The new rest timer was not confirmed safely.');
    }
    const savedStatus = String(savedTimer.status);
    const remainingSeconds = savedStatus === 'running'
      ? Math.max(
          0,
          Math.ceil((Date.parse(String(savedTimer.ends_at)) - nowFor(context).getTime()) / 1000),
        )
      : 0;
    return {
      entityType: 'rest_timer',
      entityId: timerId,
      value: {
        saved: true,
        timer: publicRestTimer(savedTimer),
        remainingSeconds,
        replacedTimerCount,
      },
    };
  });

const getRestStatus = async (
  context: ToolExecutionContext,
  args: ToolArguments['get_rest_status'],
): Promise<unknown> => {
  const selector = args.timerId
    ? `&${eqFilter('id', args.timerId)}`
    : '&status=eq.running&order=started_at.desc&limit=1';
  const payload = await supabaseRequest<unknown>(
    dbFor(context),
    `/rest/v1/rest_timers?select=*&${userFilter(context.auth.user.id)}${selector}`,
  );
  let timer = firstRow(payload);
  if (!timer) return { timer: null, remainingSeconds: 0, status: 'none' };
  const now = nowFor(context);
  let remainingSeconds = timer.status === 'running'
    ? Math.max(0, Math.ceil((Date.parse(String(timer.ends_at)) - now.getTime()) / 1000))
    : 0;
  if (timer.status === 'running' && remainingSeconds === 0) {
    const version = positiveVersion(timer.version);
    if (version === undefined) {
      throw new ApiError(503, 'provider_error', 'The rest timer version could not be verified safely.');
    }
    const updated = await supabaseRequest<unknown>(
      writeDbFor(context),
      `/rest/v1/rest_timers?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
        'id',
        String(timer.id),
      )}&status=eq.running&version=eq.${version}`,
      {
        method: 'PATCH',
        body: { status: 'finished', stopped_at: timer.ends_at },
        prefer: 'return=representation',
      },
    );
    const persisted = firstRow(updated);
    if (persisted) {
      timer = persisted;
    } else {
      const refreshedPayload = await supabaseRequest<unknown>(
        dbFor(context),
        `/rest/v1/rest_timers?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
          'id',
          String(timer.id),
        )}&limit=1`,
      );
      timer = firstRow(refreshedPayload) ?? timer;
    }
    remainingSeconds = timer.status === 'running'
      ? Math.max(0, Math.ceil((Date.parse(String(timer.ends_at)) - now.getTime()) / 1000))
      : 0;
  }
  const status = timer.status === 'running'
    ? remainingSeconds > 0 ? 'running' : 'finished'
    : timer.status;
  return { timer, remainingSeconds, status };
};

const finishWorkout = async (
  context: ToolExecutionContext,
  args: ToolArguments['finish_workout'],
): Promise<unknown> =>
  withIdempotency(context, args.operationKey, 'finish_workout', async () => {
    const session = await findSession(context, args.sessionId);
    if (!session) throw new ApiError(404, 'not_found', 'That workout session was not found.');
    if (session.local_date !== args.localDate || session.timezone !== args.timezone) {
      throw new ApiError(409, 'conflict', 'The workout date or timezone changed; refresh before finishing.');
    }
    if (session.status === 'completed') {
      return {
        entityType: 'workout_session',
        entityId: args.sessionId,
        value: { saved: true, alreadyCompleted: true, session },
      };
    }
    const actualVersion = Number(session.version);
    if (actualVersion !== args.expectedVersion) {
      await recordConflict(
        context,
        args.operationKey,
        'workout_session',
        args.sessionId,
        args.expectedVersion,
        actualVersion,
        args,
      );
      throw new ApiError(409, 'conflict', 'That workout changed on another device.', {
        expectedVersion: args.expectedVersion,
        actualVersion,
      });
    }
    const completedAt = nowFor(context).toISOString();
    const updatedPayload = await supabaseRequest<unknown>(
      writeDbFor(context),
      `/rest/v1/workout_sessions?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
        'id',
        args.sessionId,
      )}&version=eq.${args.expectedVersion}&status=eq.active`,
      {
        method: 'PATCH',
        body: cleanRecord({ status: 'completed', completed_at: completedAt, feeling: args.feeling }),
        prefer: 'return=representation',
      },
    );
    const updated = firstRow(updatedPayload);
    if (!updated) throw new ApiError(409, 'conflict', 'That workout changed on another device.');
    // The completed-session database trigger updates a linked occurrence in
    // this same transaction, so a lost Worker acknowledgement cannot split the
    // two completion states or add a second version bump on retry.
    const [creditPayload, milestonePayload] = await Promise.all([
      supabaseRequest<unknown>(
        dbFor(context),
        `/rest/v1/exercise_day_credits?select=*&${userFilter(context.auth.user.id)}&local_date=eq.${args.localDate}&limit=1`,
      ),
      supabaseRequest<unknown>(
        dbFor(context),
        `/rest/v1/milestone_unlocks?select=*&${userFilter(context.auth.user.id)}&order=unlocked_at.asc`,
      ),
    ]);
    return {
      entityType: 'workout_session',
      entityId: args.sessionId,
      value: {
        saved: true,
        alreadyCompleted: false,
        session: updated,
        exerciseDayCredit: firstRow(creditPayload) ?? null,
        milestones: rows(milestonePayload),
      },
    };
  });

const recordCardio = async (
  context: ToolExecutionContext,
  args: ToolArguments['record_cardio'],
): Promise<unknown> =>
  withIdempotency(context, args.operationKey, 'record_cardio', async (receiptId) => {
    const completedAt = args.completedAt ?? nowFor(context).toISOString();
    let sessionId = args.sessionId;
    let standaloneSession = false;
    if (sessionId) {
      const attachedSession = await requireActiveSession(context, sessionId);
      if (
        String(attachedSession.local_date) !== args.localDate
        || String(attachedSession.timezone) !== args.timezone
      ) {
        throw new ApiError(
          409,
          'conflict',
          'The cardio date or timezone does not match this workout session. Refresh before saving it.',
        );
      }
    } else {
      standaloneSession = true;
      sessionId = await deterministicUuid(context.auth.user.id, 'cardio_session', args.operationKey);
      await insertRows(
        context,
        'workout_sessions',
        cleanRecord({
          id: sessionId,
          user_id: context.auth.user.id,
          source: 'manual',
          status: 'active',
          local_date: args.localDate,
          timezone: args.timezone,
          started_at: completedAt,
          feeling: args.feeling,
          notes: args.activity,
        }),
        { idempotent: true },
      );
    }
    const cardioId = await deterministicUuid(context.auth.user.id, 'cardio_record', args.operationKey);
    await insertRows(
      context,
      'cardio_records',
      cleanRecord({
        id: cardioId,
        user_id: context.auth.user.id,
        session_id: sessionId,
        activity_key: exerciseKey(args.activity),
        display_name: args.activity,
        distance: args.distance,
        distance_unit: args.distanceUnit,
        duration_seconds: args.durationSeconds,
        completed_at: completedAt,
        local_date: args.localDate,
        timezone: args.timezone,
        feeling: args.feeling,
        last_operation_id: receiptId,
      }),
      { idempotent: true },
    );
    const savedPayload = await supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/cardio_records?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
        'id',
        cardioId,
      )}&limit=1`,
    );
    const saved = firstRow(savedPayload);
    if (!saved) {
      throw new ApiError(503, 'provider_error', 'The cardio record was not confirmed by cloud storage.');
    }
    let completedSession: DataRow | undefined;
    if (standaloneSession) {
      const completedPayload = await supabaseRequest<unknown>(
        writeDbFor(context),
        `/rest/v1/workout_sessions?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
          'id',
          sessionId,
        )}&status=eq.active`,
        {
          method: 'PATCH',
          body: { status: 'completed', completed_at: completedAt },
          prefer: 'return=representation',
        },
      );
      completedSession = firstRow(completedPayload);
      if (!completedSession) {
        const existingSession = await findSession(context, sessionId);
        if (existingSession?.status !== 'completed') {
          throw new ApiError(503, 'provider_error', 'The cardio session was not completed safely.');
        }
        completedSession = existingSession;
      }
    }
    return {
      entityType: 'cardio_record',
      entityId: cardioId,
      value: {
        saved: true,
        cardio: saved,
        standaloneSession,
        sessionId,
        ...(completedSession ? { session: completedSession } : {}),
      },
    };
  });

const restoreSetCorrection = (before: DataRow): DataRow =>
  cleanRecord({
    reps: before.reps,
    load: before.load,
    load_unit: before.load_unit,
    load_mode: before.load_mode,
    effort: before.effort,
    feeling: before.feeling,
    corrected_at: before.corrected_at,
  });

const conditionalUndoPatch = async (
  context: ToolExecutionContext,
  table: 'completed_sets' | 'cardio_records' | 'rest_timers',
  entityId: string,
  targetReceiptId: string,
  expectedVersion: number,
  eligibilityFilter: string,
  body: DataRow,
): Promise<DataRow> => {
  const payload = await supabaseRequest<unknown>(
    writeDbFor(context),
    `/rest/v1/${table}?select=id,version,last_operation_id&${userFilter(
      context.auth.user.id,
    )}&${eqFilter('id', entityId)}&${eqFilter(
      'last_operation_id',
      targetReceiptId,
    )}&version=eq.${expectedVersion}${eligibilityFilter}`,
    { method: 'PATCH', body, prefer: 'return=representation' },
  );
  const updatedRows = rows(payload);
  if (updatedRows.length === 1) return updatedRows[0];
  if (updatedRows.length > 1) {
    throw new ApiError(503, 'provider_error', 'The undo result could not be verified safely.');
  }
  const latestPayload = await supabaseRequest<unknown>(
    dbFor(context),
    `/rest/v1/${table}?select=*&${userFilter(context.auth.user.id)}&${eqFilter(
      'id',
      entityId,
    )}&limit=1`,
  );
  const latest = firstRow(latestPayload);
  throw new ApiError(409, 'conflict', 'That saved action changed before it could be undone.', {
    expectedVersion,
    actualVersion: positiveVersion(latest?.version) ?? null,
    retryable: false,
  });
};

const undoLastAction = async (
  context: ToolExecutionContext,
  args: ToolArguments['undo_last_action'],
): Promise<unknown> =>
  withIdempotency(context, args.operationKey, 'undo_last_action', async (receiptId) => {
    const keySelector = args.targetOperationKey
      ? `&${eqFilter('operation_key', args.targetOperationKey)}`
      : `&operation_key=neq.${encodeFilter(args.operationKey)}&order=created_at.desc`;
    const targetPayload = await supabaseRequest<unknown>(
      dbFor(context),
      `/rest/v1/operation_receipts?select=id,operation_key,operation_type,entity_type,entity_id,status,result,error_code,client_created_at,attempt_count,created_at,completed_at&${userFilter(
        context.auth.user.id,
      )}&status=eq.succeeded${keySelector}&limit=1`,
    );
    const target = firstRow(targetPayload) as ReceiptRow | undefined;
    if (
      !target
      || typeof target.id !== 'string'
      || typeof target.entity_id !== 'string'
      || typeof target.entity_type !== 'string'
    ) {
      throw new ApiError(404, 'not_found', 'There is no supported saved action to undo.');
    }
    const recoveryTable = target.entity_type === 'completed_set'
      ? 'completed_sets'
      : target.entity_type === 'cardio_record'
        ? 'cardio_records'
        : target.entity_type === 'rest_timer'
          ? 'rest_timers'
          : undefined;
    let currentEntity: DataRow | undefined;
    if (recoveryTable) {
      const currentPayload = await supabaseRequest<unknown>(
        dbFor(context),
        `/rest/v1/${recoveryTable}?select=*&${userFilter(
          context.auth.user.id,
        )}&${eqFilter('id', target.entity_id)}&limit=1`,
      );
      currentEntity = firstRow(currentPayload);
      if (currentEntity?.last_operation_id === receiptId) {
        return {
          entityType: target.entity_type,
          entityId: target.entity_id,
          value: {
            undone: true,
            recovered: true,
            targetOperationKey: target.operation_key,
            targetOperationType: target.operation_type,
            entityType: target.entity_type,
            entityId: target.entity_id,
          },
        };
      }
    }
    const expectedVersion = positiveVersion(currentEntity?.version);
    if (!currentEntity || currentEntity.last_operation_id !== target.id) {
      throw new ApiError(409, 'conflict', 'That saved action is no longer the latest change to this item.');
    }
    if (expectedVersion === undefined) {
      throw new ApiError(503, 'provider_error', 'The saved action version could not be verified safely.');
    }
    const targetResult =
      target.result && typeof target.result === 'object' ? (target.result as DataRow) : {};
    const undoAt = nowFor(context).toISOString();
    if (target.operation_type === 'record_set' && target.entity_type === 'completed_set') {
      if (currentEntity.deleted_at != null) {
        throw new ApiError(409, 'conflict', 'That saved set is already deleted.');
      }
      await conditionalUndoPatch(
        context,
        'completed_sets',
        target.entity_id,
        target.id,
        expectedVersion,
        '&deleted_at=is.null',
        { deleted_at: undoAt, last_operation_id: receiptId },
      );
    } else if (target.operation_type === 'correct_set' && target.entity_type === 'completed_set') {
      const before = targetResult.before;
      if (!before || typeof before !== 'object' || Array.isArray(before)) {
        throw new ApiError(409, 'conflict', 'That correction no longer has enough history to undo safely.');
      }
      if (currentEntity.deleted_at != null) {
        throw new ApiError(409, 'conflict', 'That saved set is already deleted.');
      }
      await conditionalUndoPatch(
        context,
        'completed_sets',
        target.entity_id,
        target.id,
        expectedVersion,
        '&deleted_at=is.null',
        {
          ...restoreSetCorrection(before as DataRow),
          last_operation_id: receiptId,
        },
      );
    } else if (target.operation_type === 'record_cardio' && target.entity_type === 'cardio_record') {
      if (currentEntity.deleted_at != null) {
        throw new ApiError(409, 'conflict', 'That cardio record is already deleted.');
      }
      await conditionalUndoPatch(
        context,
        'cardio_records',
        target.entity_id,
        target.id,
        expectedVersion,
        '&deleted_at=is.null',
        { deleted_at: undoAt, last_operation_id: receiptId },
      );
    } else if (target.operation_type === 'start_rest_timer' && target.entity_type === 'rest_timer') {
      if (currentEntity.status !== 'running') {
        throw new ApiError(409, 'conflict', 'That rest timer is no longer running.');
      }
      await conditionalUndoPatch(
        context,
        'rest_timers',
        target.entity_id,
        target.id,
        expectedVersion,
        '&status=eq.running',
        { status: 'cancelled', stopped_at: undoAt, last_operation_id: receiptId },
      );
    } else {
      throw new ApiError(409, 'conflict', 'That action cannot be undone automatically.');
    }
    return {
      entityType: target.entity_type,
      entityId: target.entity_id,
      value: {
        undone: true,
        targetOperationKey: target.operation_key,
        targetOperationType: target.operation_type,
        entityType: target.entity_type,
        entityId: target.entity_id,
      },
    };
  });

const normalizedName = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLocaleLowerCase('en') : '';

const describeStrengthPoint = (point: DataRow): string => {
  const reps = Number(point.reps);
  if (point.load_mode === 'bodyweight' || typeof point.load !== 'number') {
    return `${reps} reps at bodyweight`;
  }
  const mode = point.load_mode === 'per-dumbbell'
    ? ' per dumbbell'
    : point.load_mode === 'total'
      ? ' total'
      : '';
  return `${reps} reps at ${String(point.load)} ${String(point.load_unit ?? '')}${mode}`.trim();
};

const strengthPoint = (record: DataRow): DataRow =>
  cleanRecord({
    setId: String(record.id),
    completedAt: record.completed_at,
    localDate: (record.session as DataRow | undefined)?.local_date,
    reps: record.reps,
    load: record.load,
    loadUnit: record.load_unit,
    loadMode: record.load_mode,
  });

const strengthProgress = async (
  context: ToolExecutionContext,
  args: ToolArguments['get_progress'],
): Promise<unknown> => {
  const payload = await supabaseRequest<unknown>(
    dbFor(context),
    `/rest/v1/exercise_instances?select=id,exercise_key,display_name,session_id,session:workout_sessions(local_date,timezone)&${userFilter(
      context.auth.user.id,
    )}&order=created_at.desc&limit=250`,
  );
  const needle = normalizedName(args.exercise);
  const candidates = rows(payload).filter((row) => normalizedName(row.display_name).includes(needle));
  const matchingKeys = [...new Set(candidates.map((row) => String(row.exercise_key)))];
  if (matchingKeys.length > 1) {
    const summary = 'More than one saved exercise variant matches. Choose the exact exercise first.';
    return {
      kind: 'strength',
      status: 'needs-context',
      exercise: args.exercise,
      summary,
      points: [],
      records: [],
      clarificationRequired: true,
      matches: [...new Set(candidates.map((row) => String(row.display_name)))].slice(0, 12),
      comparison: {
        comparable: false,
        reason: summary,
      },
    };
  }
  const matching = candidates
    .filter((row) => matchingKeys.length === 0 || String(row.exercise_key) === matchingKeys[0])
    .slice(0, 40);
  const setGroups = await Promise.all(
    matching.map((exercise) =>
      supabaseRequest<unknown>(
        dbFor(context),
        `/rest/v1/completed_sets?select=id,reps,load,load_unit,load_mode,completed_at,version&${userFilter(
          context.auth.user.id,
        )}&${eqFilter('exercise_instance_id', String(exercise.id))}&deleted_at=is.null&order=completed_at.asc`,
      ),
    ),
  );
  const records: DataRow[] = matching
    .flatMap((exercise, index) =>
      rows(setGroups[index]).map((set): DataRow => ({
        ...set,
        exerciseName: exercise.display_name,
        session: exercise.session,
      })),
    )
    .filter((set) => {
      const localDate = (set.session as DataRow | undefined)?.local_date;
      return (!args.fromDate || String(localDate) >= args.fromDate) &&
        (!args.toDate || String(localDate) <= args.toDate);
    })
    .sort((a, b) => String(a.completed_at).localeCompare(String(b.completed_at)));

  const earliest = records[0];
  const latest = records.at(-1);
  const comparable = Boolean(
    earliest && latest && earliest !== latest && records.every((record) => (
      record.load_unit === earliest.load_unit
      && record.load_mode === earliest.load_mode
      && record.reps === earliest.reps
      && typeof record.load === 'number'
    )),
  );
  const activityLabel = String(records[0]?.exerciseName ?? args.exercise ?? 'that exercise');
  const comparisonReason = records.length < 2
    ? 'Not enough matching saved sets.'
    : 'Matching sets differ in reps, load unit, or load mode.';
  const standardizedPoints = comparable || records.length === 1
    ? records.map(strengthPoint)
    : [];
  const summary = records.length === 0
    ? `No completed sets are saved for ${activityLabel}.`
    : comparable
      ? `${records.length} comparable completed sets are saved for ${activityLabel}. First: ${describeStrengthPoint(
          earliest!,
        )}. Latest: ${describeStrengthPoint(latest!)}.`
      : records.length === 1
        ? `1 completed set is saved for ${activityLabel}: ${describeStrengthPoint(earliest!)}. One set is not enough for a comparison.`
        : `${records.length} completed sets are saved for ${activityLabel}, but they differ in reps, load unit, or load mode, so no direct comparison is shown.`;
  return {
    kind: 'strength',
    status: records.length === 0 ? 'no-data' : standardizedPoints.length > 0 ? 'ready' : 'needs-context',
    exercise: args.exercise,
    summary,
    points: standardizedPoints,
    records,
    comparison: comparable
      ? {
          comparable: true,
          basis: 'same reps, load unit, and load mode',
          earliest,
          latest,
          loadDelta: Number(latest?.load) - Number(earliest?.load),
          loadUnit: latest?.load_unit,
        }
      : {
          comparable: false,
          reason: comparisonReason,
        },
  };
};

const distanceInMetres = (distance: number, unit: string): number => {
  if (unit === 'km') return distance * 1000;
  if (unit === 'mi') return distance * 1609.344;
  return distance;
};

const cardioPoint = (record: DataRow): DataRow => ({
  recordId: String(record.id),
  completedAt: record.completed_at,
  localDate: record.local_date,
  distance: record.distance,
  distanceUnit: record.distance_unit,
  durationSeconds: record.duration_seconds,
});

const cardioProgress = async (
  context: ToolExecutionContext,
  args: ToolArguments['get_progress'],
): Promise<unknown> => {
  const payload = await supabaseRequest<unknown>(
    dbFor(context),
    `/rest/v1/cardio_records?select=id,activity_key,display_name,distance,distance_unit,duration_seconds,completed_at,local_date,timezone&${userFilter(
      context.auth.user.id,
    )}&deleted_at=is.null&order=completed_at.asc&limit=500`,
  );
  const activity = normalizedName(args.activity);
  const targetDistanceMetres =
    args.distance && args.distanceUnit ? distanceInMetres(args.distance, args.distanceUnit) : undefined;
  const inWindow = rows(payload).filter((row) => {
    if (args.fromDate && String(row.local_date) < args.fromDate) return false;
    if (args.toDate && String(row.local_date) > args.toDate) return false;
    return true;
  });
  const activityCandidates = activity
    ? inWindow.filter((row) => normalizedName(row.display_name).includes(activity))
    : inWindow;
  const activityKeys = [...new Set(activityCandidates.map((row) => String(row.activity_key)))];
  if (!activity) {
    const summary = 'Choose an activity before comparing cardio efforts.';
    return {
      kind: 'cardio',
      status: 'needs-context',
      activity: null,
      summary,
      points: [],
      records: [],
      clarificationRequired: true,
      matches: [...new Set(activityCandidates.map((row) => String(row.display_name)))].slice(0, 12),
      comparison: {
        comparable: false,
        reason: summary,
      },
    };
  }
  if (activity && activityKeys.length > 1) {
    const summary = 'More than one saved cardio activity matches. Choose the exact activity first.';
    return {
      kind: 'cardio',
      status: 'needs-context',
      activity: args.activity,
      summary,
      points: [],
      records: [],
      clarificationRequired: true,
      matches: [...new Set(activityCandidates.map((row) => String(row.display_name)))].slice(0, 12),
      comparison: {
        comparable: false,
        reason: summary,
      },
    };
  }
  const records = activityCandidates.filter((row) => {
    if (activityKeys.length > 0 && String(row.activity_key) !== activityKeys[0]) return false;
    if (targetDistanceMetres !== undefined) {
      const metres = distanceInMetres(Number(row.distance), String(row.distance_unit));
      if (Math.abs(metres - targetDistanceMetres) > Math.max(5, targetDistanceMetres * 0.005)) return false;
    }
    return true;
  });
  const earliest = records[0];
  const latest = records.at(-1);
  const comparable = Boolean(targetDistanceMetres !== undefined && earliest && latest && earliest !== latest);
  const activityLabel = String(records[0]?.display_name ?? args.activity ?? 'that activity');
  const distanceLabel = args.distance && args.distanceUnit
    ? `${args.distance} ${args.distanceUnit}`
    : null;
  const standardizedPoints = targetDistanceMetres !== undefined
    ? records.map(cardioPoint)
    : [];
  const summary = records.length === 0
    ? distanceLabel
      ? `No completed ${distanceLabel} ${activityLabel} records are saved.`
      : `No completed cardio records are saved for ${activityLabel}.`
    : targetDistanceMetres === undefined
      ? `${records.length} completed ${activityLabel} ${records.length === 1 ? 'record is' : 'records are'} saved. Choose a distance before comparing times.`
      : `${records.length} completed ${distanceLabel} ${activityLabel} ${records.length === 1 ? 'record is' : 'records are'} saved. First: ${String(
          earliest?.duration_seconds,
        )} seconds. Latest: ${String(latest?.duration_seconds)} seconds.`;
  return {
    kind: 'cardio',
    status: records.length === 0 ? 'no-data' : standardizedPoints.length > 0 ? 'ready' : 'needs-distance',
    activity: args.activity ?? null,
    summary,
    points: standardizedPoints,
    distanceFilter: args.distance ? { distance: args.distance, unit: args.distanceUnit } : null,
    records,
    comparison: comparable
      ? {
          comparable: true,
          basis: 'same distance',
          earliest,
          latest,
          durationDeltaSeconds: Number(latest?.duration_seconds) - Number(earliest?.duration_seconds),
        }
      : {
          comparable: false,
          reason: targetDistanceMetres === undefined
            ? 'Choose a distance before comparing times.'
            : 'Not enough saved efforts at that distance.',
        },
  };
};

const localToday = (now: Date, timezone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const completionProgress = async (
  context: ToolExecutionContext,
  args: ToolArguments['get_progress'],
): Promise<unknown> => {
  const query = [
    '/rest/v1/workout_occurrences?select=id,scheduled_local_date,timezone,status',
    userFilter(context.auth.user.id),
    args.fromDate ? `scheduled_local_date=gte.${args.fromDate}` : '',
    args.toDate ? `scheduled_local_date=lte.${args.toDate}` : '',
    'order=scheduled_local_date.asc',
    'limit=1000',
  ].filter(Boolean).join('&');
  const payload = await supabaseRequest<unknown>(dbFor(context), query);
  const now = nowFor(context);
  const eligible = rows(payload).filter((occurrence) => {
    if (occurrence.status === 'cancelled') return false;
    try {
      return String(occurrence.scheduled_local_date) <= localToday(now, String(occurrence.timezone));
    } catch {
      return false;
    }
  });
  const completed = eligible.filter((occurrence) => occurrence.status === 'completed');
  const windowLabel = args.fromDate && args.toDate
    ? `${args.fromDate} to ${args.toDate}`
    : args.fromDate
      ? `from ${args.fromDate}`
      : args.toDate
        ? `through ${args.toDate}`
        : 'the requested period';
  const rate = eligible.length ? completed.length / eligible.length : null;
  return {
    kind: 'completion',
    status: eligible.length ? 'ready' : 'no-data',
    summary: eligible.length
      ? `${completed.length} of ${eligible.length} eligible scheduled workouts were completed (${Math.round(
          (rate ?? 0) * 100,
        )}%) for ${windowLabel}. Future and cancelled occurrences are excluded.`
      : `No eligible scheduled workouts exist for ${windowLabel}. Future and cancelled occurrences are excluded.`,
    points: eligible.map((occurrence) => ({
      occurrenceId: String(occurrence.id),
      scheduledLocalDate: occurrence.scheduled_local_date,
      status: occurrence.status,
      completed: occurrence.status === 'completed',
    })),
    window: { fromDate: args.fromDate ?? null, toDate: args.toDate ?? null },
    completed: completed.length,
    eligible: eligible.length,
    rate,
    noDenominator: eligible.length === 0,
  };
};

const getProgress = async (
  context: ToolExecutionContext,
  args: ToolArguments['get_progress'],
): Promise<unknown> => {
  if (args.kind === 'strength') return strengthProgress(context, args);
  if (args.kind === 'cardio') return cardioProgress(context, args);
  return completionProgress(context, args);
};

const PRIVATE_RESULT_FIELDS = new Set([
  'user_id',
  'openai_call_id',
  'claim_token',
  'lease_expires_at',
]);

const clientSafeResult = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(clientSafeResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as DataRow)
      .filter(([key]) => !PRIVATE_RESULT_FIELDS.has(key))
      .map(([key, entry]) => [key, clientSafeResult(entry)]),
  );
};

export const executeTool = async (
  context: ToolExecutionContext,
  call: ParsedToolCall,
): Promise<ToolExecutionResult> => {
  let result: unknown;
  switch (call.name) {
    case 'get_session_context':
      result = await getSessionContext(context, call.arguments);
      break;
    case 'draft_workout':
      result = draftWorkout(call.arguments);
      break;
    case 'start_workout':
      result = await startWorkout(context, call.arguments);
      break;
    case 'record_set':
      result = await recordSet(context, call.arguments);
      break;
    case 'correct_set':
      result = await correctSet(context, call.arguments);
      break;
    case 'undo_last_action':
      result = await undoLastAction(context, call.arguments);
      break;
    case 'start_rest_timer':
      result = await startRestTimer(context, call.arguments);
      break;
    case 'get_rest_status':
      result = await getRestStatus(context, call.arguments);
      break;
    case 'finish_workout':
      result = await finishWorkout(context, call.arguments);
      break;
    case 'record_cardio':
      result = await recordCardio(context, call.arguments);
      break;
    case 'get_progress':
      result = await getProgress(context, call.arguments);
      break;
    case 'show_panel':
      result = { clientDirective: { type: 'show_panel', panel: call.arguments.panel } };
      break;
    case 'close_panel':
      result = { clientDirective: { type: 'close_panel', panel: call.arguments.panel ?? null } };
      break;
  }
  return { tool: call.name, result: clientSafeResult(result) };
};

export const __test = {
  databaseLoadMode,
  distanceInMetres,
  exerciseKey,
  localToday,
  clientSafeResult,
};
