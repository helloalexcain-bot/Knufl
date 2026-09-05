import type { ToolName } from './demo-engine';

export type ClientPanelKind =
  | 'set'
  | 'rest'
  | 'progress'
  | 'plan'
  | 'history'
  | 'clarification'
  | null;

export type CloudImportStatus =
  | 'completed'
  | 'already-imported'
  | 'already-restored'
  | 'conflict'
  | 'pending'
  | 'unknown';

export interface CloudImportResponse {
  status: CloudImportStatus;
  conflictCount: number;
  completed: boolean;
}

export interface CloudRestorePreview {
  valid: boolean;
  action: 'importable' | 'duplicate' | 'conflict' | 'unknown';
  companionName: string;
  sessions: number;
  memories: number;
  milestones: number;
  conflicts: number;
}

export interface ClientPlanSummary {
  raw: Record<string, unknown>;
  id?: string;
  title?: string;
  weeklyTarget?: number;
  scheduleDays: string[];
  activity?: string;
  activityDetail?: string;
  nextSessionDate?: string;
  exercises: Record<string, unknown>[];
}

export interface NormalizedClientContext {
  activeSession?: Record<string, unknown>;
  exercises: Record<string, unknown>[];
  completedSets: Record<string, unknown>[];
  latestRestTimer?: Record<string, unknown>;
  plan?: ClientPlanSummary;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const recordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];

const firstRecordAt = (
  value: unknown,
  ...keys: string[]
): Record<string, unknown> | undefined => {
  const source = asRecord(value);
  if (!source) return undefined;
  for (const key of keys) {
    const direct = asRecord(source[key]);
    if (direct) return direct;
    const first = recordArray(source[key])[0];
    if (first) return first;
  }
  return firstRecordAt(source.active, ...keys) ?? firstRecordAt(source.context, ...keys);
};

const arrayAt = (value: unknown, ...keys: string[]): Record<string, unknown>[] => {
  const source = asRecord(value);
  if (!source) return [];
  for (const key of keys) {
    const found = recordArray(source[key]);
    if (found.length) return found;
  }
  const active = arrayAt(source.active, ...keys);
  return active.length ? active : arrayAt(source.context, ...keys);
};

const stringAt = (
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
};

const numberAt = (
  source: Record<string, unknown>,
  ...keys: string[]
): number | undefined => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
};

const stringArrayAt = (source: Record<string, unknown>, ...keys: string[]): string[] => {
  for (const key of keys) {
    if (!Array.isArray(source[key])) continue;
    return source[key].filter((item): item is string => typeof item === 'string');
  }
  return [];
};

const unwrapRpcValue = (value: unknown): Record<string, unknown> => {
  if (Array.isArray(value) && value.length === 1) return asRecord(value[0]) ?? {};
  return asRecord(value) ?? {};
};

const conflictCountIn = (value: unknown): number => {
  const result = unwrapRpcValue(value);
  const preview = asRecord(result.preview) ?? result;
  const profile = asRecord(preview.profile);
  const plan = asRecord(preview.plan);
  const sessions = asRecord(preview.sessions);
  const memories = asRecord(preview.memories);
  const countList = (entry: Record<string, unknown> | undefined): number =>
    Array.isArray(entry?.conflicts) ? entry.conflicts.length : 0;
  const directConflicts = Array.isArray(preview.conflicts) ? preview.conflicts.length : 0;

  return directConflicts
    + (profile?.action === 'conflict' ? 1 : 0)
    + (plan?.action === 'conflict' ? 1 : 0)
    + countList(sessions)
    + countList(memories);
};

export const parseCloudImportResponse = (value: unknown): CloudImportResponse => {
  const result = unwrapRpcValue(value);
  const rawStatus = stringAt(result, 'status');
  const status: CloudImportStatus = rawStatus === 'completed'
    || rawStatus === 'already-imported'
    || rawStatus === 'already-restored'
    || rawStatus === 'conflict'
    || rawStatus === 'pending'
    ? rawStatus
    : 'unknown';
  const conflictCount = conflictCountIn(result);

  return {
    status,
    conflictCount,
    completed: conflictCount === 0 && (
      status === 'completed' || status === 'already-imported' || status === 'already-restored'
    ),
  };
};

export const importConflictCount = (value: unknown): number => conflictCountIn(value);

export const isCloudAccountExport = (value: unknown): value is Record<string, unknown> => {
  const source = asRecord(value);
  return source?.formatVersion === 2;
};

export const parseCloudRestorePreview = (value: unknown): CloudRestorePreview => {
  const result = unwrapRpcValue(value);
  const preview = asRecord(result.preview) ?? result;
  const counts = asRecord(preview.counts) ?? {};
  const rawAction = stringAt(preview, 'action');
  const action: CloudRestorePreview['action'] = rawAction === 'importable'
    || rawAction === 'duplicate'
    || rawAction === 'conflict'
    ? rawAction
    : 'unknown';
  const count = (key: string): number => {
    const raw = counts[key];
    return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
  };

  return {
    valid: preview.valid === true,
    action,
    companionName: stringAt(preview, 'companionName', 'companion_name') ?? 'Knufl',
    sessions: count('sessions'),
    memories: count('memories'),
    milestones: count('milestones'),
    conflicts: Array.isArray(preview.conflicts) ? preview.conflicts.length : 0,
  };
};

export const panelForTool = (tool: ToolName): ClientPanelKind => {
  if (tool === 'record_set' || tool === 'correct_set') return 'set';
  if (tool === 'start_rest_timer' || tool === 'get_rest_status') return 'rest';
  if (tool === 'get_progress') return 'progress';
  if (tool === 'draft_workout') return 'plan';
  return null;
};

export const panelFromContract = (value: unknown): ClientPanelKind => {
  if (value === 'set_receipt') return 'set';
  if (value === 'rest_timer') return 'rest';
  if (value === 'progress') return 'progress';
  if (value === 'clarification') return 'clarification';
  return null;
};

export const planFrom = (context: unknown): ClientPlanSummary | undefined => {
  const planRows = arrayAt(context, 'plans', 'workoutPlans', 'workout_plans');
  const plan = firstRecordAt(
    context,
    'activePlan',
    'active_plan',
    'plan',
    'workoutPlan',
    'workout_plan',
  ) ?? planRows.find((item) => stringAt(item, 'status') === 'active') ?? planRows[0];
  if (!plan) return undefined;

  const id = stringAt(plan, 'id');
  const nestedExercises = arrayAt(plan, 'exercises', 'exerciseTemplates', 'exercise_templates');
  const relatedExercises = arrayAt(context, 'planExercises', 'plan_exercises').filter((exercise) => {
    const exercisePlanId = stringAt(exercise, 'planId', 'plan_id');
    return !id || exercisePlanId === id;
  });

  return {
    raw: plan,
    id,
    title: stringAt(plan, 'title', 'name'),
    weeklyTarget: numberAt(plan, 'weeklyTarget', 'weekly_target'),
    scheduleDays: stringArrayAt(plan, 'scheduleDays', 'schedule_days', 'days'),
    activity: stringAt(plan, 'activity', 'defaultActivityKey', 'default_activity_key'),
    activityDetail: stringAt(plan, 'activityDetail', 'activity_detail'),
    nextSessionDate: stringAt(
      plan,
      'nextSessionDate',
      'next_session_date',
      'nextSessionLocalDate',
      'next_session_local_date',
    ),
    exercises: nestedExercises.length ? nestedExercises : relatedExercises,
  };
};

export const normalizeClientContext = (context: unknown): NormalizedClientContext => {
  const exerciseList = arrayAt(context, 'exercises', 'exerciseInstances', 'exercise_instances');
  const singleExercise = firstRecordAt(context, 'exercise');

  return {
    activeSession: firstRecordAt(context, 'activeSession', 'active_session', 'session'),
    exercises: exerciseList.length ? exerciseList : singleExercise ? [singleExercise] : [],
    completedSets: arrayAt(context, 'sets', 'completedSets', 'completed_sets'),
    latestRestTimer: firstRecordAt(
      context,
      'latestRestTimer',
      'latest_rest_timer',
      'restTimer',
      'rest_timer',
      'timer',
    ),
    plan: planFrom(context),
  };
};

export const activeSessionFrom = (context: unknown): Record<string, unknown> | undefined =>
  normalizeClientContext(context).activeSession;

export const exercisesFrom = (context: unknown): Record<string, unknown>[] =>
  normalizeClientContext(context).exercises;

export const targetSetToActiveContext = (
  arguments_: Record<string, unknown>,
  context: unknown,
): Record<string, unknown> | undefined => {
  const sessionId = stringAt(activeSessionFrom(context) ?? {}, 'id');
  const exercises = exercisesFrom(context);
  const requestedName = typeof arguments_.exercise === 'string'
    ? arguments_.exercise.trim().toLocaleLowerCase()
    : '';
  const requestedId = typeof arguments_.exerciseInstanceId === 'string'
    ? arguments_.exerciseInstanceId
    : '';
  const namesMatch = (exercise: Record<string, unknown>): boolean => {
    const candidate = stringAt(exercise, 'displayName', 'display_name', 'name')
      ?.trim()
      .toLocaleLowerCase();
    return Boolean(candidate && requestedName && (
      candidate === requestedName
      || candidate.includes(requestedName)
      || requestedName.includes(candidate)
    ));
  };
  const namedMatches = requestedName ? exercises.filter(namesMatch) : [];
  const target = namedMatches.length === 1
    ? namedMatches[0]
    : requestedName
      ? undefined
      : exercises.find((exercise) => stringAt(exercise, 'id') === requestedId)
        ?? (exercises.length === 1 ? exercises[0] : undefined);
  const exerciseInstanceId = stringAt(target ?? {}, 'id');

  const resolvedArguments = { ...arguments_ };
  delete resolvedArguments.exercise;

  return sessionId && exerciseInstanceId
    ? { ...resolvedArguments, sessionId, exerciseInstanceId }
    : undefined;
};

export const setsFrom = (context: unknown): Record<string, unknown>[] =>
  normalizeClientContext(context).completedSets;

export const restTimerFrom = (context: unknown): Record<string, unknown> | undefined =>
  normalizeClientContext(context).latestRestTimer;
