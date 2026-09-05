import type { ToolName } from './demo-engine.ts';
import { setsFrom } from './client-contract.ts';
import { deterministicUuid } from './stable-id.ts';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const stringValue = (source: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    if (typeof source[key] === 'string' && source[key]) return String(source[key]);
  }
  return undefined;
};

const numberValue = (source: Record<string, unknown>, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    if (typeof source[key] === 'number' && Number.isFinite(source[key])) return Number(source[key]);
  }
  return undefined;
};

/**
 * Mirrors queued mutations into the visible active-session context. This is a
 * pending (never "saved") projection: it keeps dependent offline operations
 * attached to the deterministic IDs the Worker will use when the queue replays.
 */
export async function projectPendingToolOperation(
  accountId: string,
  context: Record<string, unknown>,
  name: ToolName,
  args: Record<string, unknown>,
  operationId: string,
): Promise<Record<string, unknown>> {
  if (name === 'start_workout') {
    const sessionId = await deterministicUuid(accountId, 'workout_session', operationId);
    const session = {
      id: sessionId,
      version: 1,
      status: 'active',
      localDate: args.localDate,
      local_date: args.localDate,
      timezone: args.timezone,
      notes: args.title,
      pending: true,
    };
    const proposed = Array.isArray(args.exercises)
      ? args.exercises.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    const exercises = await Promise.all(proposed.map(async (exercise, position) => {
      const id = await deterministicUuid(accountId, 'exercise_instance', `${operationId}:${position}`);
      return {
        id,
        sessionId,
        session_id: sessionId,
        position,
        name: stringValue(exercise, 'name') ?? `Exercise ${position + 1}`,
        displayName: stringValue(exercise, 'name') ?? `Exercise ${position + 1}`,
        display_name: stringValue(exercise, 'name') ?? `Exercise ${position + 1}`,
        plannedSets: numberValue(exercise, 'sets'),
        planned_sets: numberValue(exercise, 'sets'),
        plannedReps: numberValue(exercise, 'reps'),
        planned_reps: numberValue(exercise, 'reps'),
        plannedLoad: numberValue(exercise, 'load'),
        planned_load: numberValue(exercise, 'load'),
        plannedLoadUnit: stringValue(exercise, 'loadUnit'),
        planned_load_unit: stringValue(exercise, 'loadUnit'),
        plannedLoadMode: stringValue(exercise, 'loadMode'),
        planned_load_mode: stringValue(exercise, 'loadMode'),
        restSeconds: numberValue(exercise, 'restSeconds'),
        rest_seconds: numberValue(exercise, 'restSeconds'),
        pending: true,
      };
    }));
    return {
      ...context,
      session,
      activeSession: session,
      exercise: exercises[0] ?? null,
      exercises,
      sets: [],
      completedSets: [],
      restTimer: null,
      latestRestTimer: null,
    };
  }

  if (name === 'record_set') {
    const id = await deterministicUuid(accountId, 'completed_set', operationId);
    const existing = setsFrom(context).filter((set) => stringValue(set, 'id') !== id);
    const exerciseInstanceId = stringValue(args, 'exerciseInstanceId');
    const order = existing.filter((set) =>
      stringValue(set, 'exerciseInstanceId', 'exercise_instance_id') === exerciseInstanceId).length + 1;
    const set = {
      id,
      sessionId: args.sessionId,
      session_id: args.sessionId,
      exerciseInstanceId,
      exercise_instance_id: exerciseInstanceId,
      setOrder: order,
      set_order: order,
      reps: args.reps,
      load: args.load,
      loadUnit: args.loadUnit,
      load_unit: args.loadUnit,
      loadMode: args.loadMode,
      load_mode: args.loadMode,
      completedAt: args.completedAt,
      completed_at: args.completedAt,
      version: 1,
      pending: true,
    };
    const sets = [...existing, set];
    return { ...context, sets, completedSets: sets };
  }

  if (name === 'correct_set') {
    const setId = stringValue(args, 'setId');
    const sets = setsFrom(context).map((set) => {
      if (stringValue(set, 'id') !== setId) return set;
      const next: Record<string, unknown> = { ...set, pending: true };
      if (args.reps !== undefined) next.reps = args.reps;
      if (args.load !== undefined) next.load = args.load;
      if (args.loadUnit !== undefined) {
        next.loadUnit = args.loadUnit;
        next.load_unit = args.loadUnit;
      }
      if (args.loadMode !== undefined) {
        next.loadMode = args.loadMode;
        next.load_mode = args.loadMode;
      }
      const expectedVersion = typeof args.expectedVersion === 'number' && Number.isFinite(args.expectedVersion)
        ? args.expectedVersion
        : 0;
      next.version = (numberValue(set, 'version') ?? expectedVersion) + 1;
      return next;
    });
    return { ...context, sets, completedSets: sets };
  }

  if (name === 'start_rest_timer') {
    const id = await deterministicUuid(accountId, 'rest_timer', operationId);
    const startedAt = stringValue(args, 'startedAt') ?? new Date().toISOString();
    const durationSeconds = numberValue(args, 'durationSeconds') ?? 0;
    const endsAt = new Date(Date.parse(startedAt) + durationSeconds * 1000).toISOString();
    const timer = { id, status: 'running', startedAt, started_at: startedAt, endsAt, ends_at: endsAt, pending: true };
    return { ...context, restTimer: timer, latestRestTimer: timer };
  }

  if (name === 'finish_workout') {
    return {
      ...context,
      session: null,
      activeSession: null,
      exercise: null,
      exercises: [],
      sets: [],
      completedSets: [],
      restTimer: null,
      latestRestTimer: null,
    };
  }

  return context;
}
