import { ApiError } from './errors.ts';

export const TOOL_NAMES = [
  'get_session_context',
  'draft_workout',
  'start_workout',
  'select_exercise',
  'record_set',
  'correct_set',
  'undo_last_action',
  'start_rest_timer',
  'get_rest_status',
  'finish_workout',
  'record_cardio',
  'get_progress',
  'show_panel',
  'close_panel',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
export type LoadUnit = 'kg' | 'lb';
export type LoadMode =
  | 'barbell_total'
  | 'machine_total'
  | 'per_dumbbell'
  | 'per-dumbbell'
  | 'total'
  | 'bodyweight'
  | 'assisted'
  | 'not_applicable';
export type DistanceUnit = 'km' | 'mi' | 'm';
export type PanelName = 'set_receipt' | 'rest_timer' | 'progress' | 'clarification';

export interface ExerciseDraft {
  name: string;
  sets: number;
  reps?: number;
  load?: number;
  loadUnit?: LoadUnit;
  loadMode?: LoadMode;
  restSeconds?: number;
}

export interface ToolArguments {
  get_session_context: { sessionId?: string };
  draft_workout: { title?: string; exercises: ExerciseDraft[]; superset?: boolean };
  select_exercise: { operationKey: string; exercise?: string; exerciseInstanceId?: string; clear?: boolean };
  start_workout: {
    operationKey: string;
    localDate: string;
    timezone: string;
    title?: string;
    plannedOccurrenceId?: string;
    superset?: boolean;
    exercises: ExerciseDraft[];
  };
  record_set: {
    operationKey: string;
    sessionId: string;
    exerciseInstanceId: string;
    reps: number;
    load?: number;
    loadUnit?: LoadUnit;
    loadMode?: LoadMode;
    effort?: number;
    feeling?: string;
    completedAt?: string;
  };
  correct_set: {
    operationKey: string;
    setId: string;
    expectedVersion: number;
    reps?: number;
    load?: number;
    loadUnit?: LoadUnit;
    loadMode?: LoadMode;
    effort?: number;
  };
  undo_last_action: { operationKey: string; targetOperationKey?: string };
  start_rest_timer: {
    operationKey: string;
    sessionId: string;
    durationSeconds: number;
    startedAt?: string;
  };
  get_rest_status: { timerId?: string };
  finish_workout: {
    operationKey: string;
    sessionId: string;
    expectedVersion: number;
    localDate: string;
    timezone: string;
    feeling?: string;
  };
  record_cardio: {
    operationKey: string;
    sessionId?: string;
    activity: string;
    distance: number;
    distanceUnit: DistanceUnit;
    durationSeconds: number;
    localDate: string;
    timezone: string;
    completedAt?: string;
    feeling?: string;
  };
  get_progress: {
    kind: 'strength' | 'cardio' | 'completion';
    exercise?: string;
    activity?: string;
    distance?: number;
    distanceUnit?: DistanceUnit;
    fromDate?: string;
    toDate?: string;
  };
  show_panel: { panel: PanelName };
  close_panel: { panel?: PanelName };
}

export type ParsedToolCall = {
  [Name in ToolName]: { name: Name; arguments: ToolArguments[Name] };
}[ToolName];

type JsonSchema = Record<string, unknown>;

const stringSchema = (description: string): JsonSchema => ({ type: 'string', description });
const identifierSchema = (description: string): JsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$',
  description,
});
const operationKeySchema: JsonSchema = {
  type: 'string',
  minLength: 8,
  maxLength: 128,
  description: 'A stable unique key for this user-confirmed action. Reuse it when retrying.',
};
const localDateSchema: JsonSchema = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: 'The workout date in the user session timezone, formatted YYYY-MM-DD.',
};
const timezoneSchema = stringSchema('An IANA timezone such as Europe/London.');
const loadProperties: Record<string, JsonSchema> = {
  load: { type: 'number', minimum: 0, maximum: 100000 },
  loadUnit: { type: 'string', enum: ['kg', 'lb'] },
  loadMode: {
    type: 'string',
    enum: [
      'barbell_total',
      'machine_total',
      'per_dumbbell',
      'total',
      'bodyweight',
      'not_applicable',
    ],
  },
};
const exerciseDraftSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'sets'],
  properties: {
    name: stringSchema('The specific exercise name. Ask if a materially different variant is unclear.'),
    sets: { type: 'integer', minimum: 1, maximum: 100 },
    reps: { type: 'integer', minimum: 1, maximum: 1000 },
    ...loadProperties,
    restSeconds: { type: 'integer', minimum: 5, maximum: 3600 },
  },
};

const tool = (
  name: ToolName,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema => ({
  type: 'function',
  name,
  description,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  },
});

export const REALTIME_TOOL_DEFINITIONS: JsonSchema[] = [
  tool(
    'get_session_context',
    'Read the authenticated user’s active or specified workout and recent confirmed records.',
    { sessionId: identifierSchema('An optional known workout session ID.') },
  ),
  tool(
    'draft_workout',
    'Prepare a proposed workout. This never records sets as completed.',
    {
      title: stringSchema('A short optional workout title.'),
      exercises: { type: 'array', minItems: 1, maxItems: 30, items: exerciseDraftSchema },
      superset: { type: 'boolean', description: 'True only when the user plans alternating/superset exercises; never assume an automatic order.' },
    },
    ['exercises'],
  ),
  tool(
    'start_workout',
    'Start a workout from confirmed planned work. Planned reps and loads remain plans, not completions.',
    {
      operationKey: operationKeySchema,
      localDate: localDateSchema,
      timezone: timezoneSchema,
      title: stringSchema('A short optional workout title.'),
      plannedOccurrenceId: identifierSchema('Optional scheduled occurrence being started.'),
      superset: { type: 'boolean' },
      exercises: { type: 'array', minItems: 1, maxItems: 30, items: exerciseDraftSchema },
    },
    ['operationKey', 'localDate', 'timezone', 'exercises'],
  ),
  tool(
    'record_set',
    'Save an explicit completed-set report immediately. Omit exercise/load/units when the active context supplies them. Never infer completed reps from the plan; sameAgain explicitly repeats the last actual set. Clarify only genuinely missing/ambiguous facts.',
    {
      operationKey: operationKeySchema,
      exercise: stringSchema('The completed exercise name from the user. Omit when trainingContext has an unambiguous activeExercise.'),
      reps: { type: 'integer', minimum: 1, maximum: 1000 },
      sameAgain: { type: 'boolean', description: 'Only true for an explicit completed same-again report. Reuse the last actual set, never planned reps.' },
      ...loadProperties,
      effort: { type: 'number', minimum: 0, maximum: 10 },
      feeling: stringSchema('Optional user-provided feeling. Never invent one.'),
      completedAt: { type: 'string', format: 'date-time' },
    },
    ['operationKey'],
  ),
  tool('select_exercise', 'Set the explicitly named active exercise for subsequent shorthand reports. In a superset select or name the exercise for each completed report; clear removes the cursor.', {
    operationKey: operationKeySchema, exercise: stringSchema('Exact exercise name from the workout.'),
    exerciseInstanceId: identifierSchema('Known exercise ID.'), clear: { type: 'boolean' },
  }, ['operationKey']),
  tool(
    'correct_set',
    'Correct the linked set in place, preserving its identity and revision history.',
    {
      operationKey: operationKeySchema,
      setId: identifierSchema('The exact previously saved set ID.'),
      expectedVersion: { type: 'integer', minimum: 1 },
      reps: { type: 'integer', minimum: 1, maximum: 1000 },
      ...loadProperties,
      effort: { type: 'number', minimum: 0, maximum: 10 },
    },
    ['operationKey', 'setId', 'expectedVersion'],
  ),
  tool(
    'undo_last_action',
    'Undo the latest supported write, or a specific known operation, without guessing.',
    {
      operationKey: operationKeySchema,
      targetOperationKey: operationKeySchema,
    },
    ['operationKey'],
  ),
  tool(
    'start_rest_timer',
    'Start a timestamp-based deterministic rest timer.',
    {
      operationKey: operationKeySchema,
      sessionId: identifierSchema('Current workout session ID.'),
      durationSeconds: { type: 'integer', minimum: 5, maximum: 3600 },
      startedAt: { type: 'string', format: 'date-time' },
    },
    ['operationKey', 'sessionId', 'durationSeconds'],
  ),
  tool(
    'get_rest_status',
    'Read the saved rest timer and calculate remaining time from timestamps.',
    { timerId: identifierSchema('Optional timer ID; otherwise use the most recent active timer.') },
  ),
  tool(
    'finish_workout',
    'Mark a workout session complete after explicit confirmation. This awards at most one day credit.',
    {
      operationKey: operationKeySchema,
      sessionId: identifierSchema('Current workout session ID.'),
      expectedVersion: { type: 'integer', minimum: 1 },
      localDate: localDateSchema,
      timezone: timezoneSchema,
      feeling: stringSchema('Optional user-provided feeling. Never invent one.'),
    },
    ['operationKey', 'sessionId', 'expectedVersion', 'localDate', 'timezone'],
  ),
  tool(
    'record_cardio',
    'Record completed cardio with only the distance, duration, and feeling the user actually supplied.',
    {
      operationKey: operationKeySchema,
      sessionId: identifierSchema('Optional current workout session ID.'),
      activity: stringSchema('Cardio activity such as Walking, Running, or Cycling.'),
      distance: { type: 'number', exclusiveMinimum: 0, maximum: 100000 },
      distanceUnit: { type: 'string', enum: ['km', 'mi', 'm'] },
      durationSeconds: { type: 'integer', minimum: 1, maximum: 604800 },
      localDate: localDateSchema,
      timezone: timezoneSchema,
      completedAt: { type: 'string', format: 'date-time' },
      feeling: stringSchema('Optional user-provided feeling. Never invent one.'),
    },
    [
      'operationKey',
      'activity',
      'distance',
      'distanceUnit',
      'durationSeconds',
      'localDate',
      'timezone',
    ],
  ),
  tool(
    'get_progress',
    'Query saved records and return a grounded comparison. Never compare unlike cardio distances as equivalent.',
    {
      kind: { type: 'string', enum: ['strength', 'cardio', 'completion'] },
      exercise: stringSchema('Required for a strength query.'),
      activity: stringSchema('Optional cardio activity filter.'),
      distance: { type: 'number', exclusiveMinimum: 0 },
      distanceUnit: { type: 'string', enum: ['km', 'mi', 'm'] },
      fromDate: localDateSchema,
      toDate: localDateSchema,
    },
    ['kind'],
  ),
  tool(
    'show_panel',
    'Ask the client to show a compact, accessible context panel.',
    { panel: { type: 'string', enum: ['set_receipt', 'rest_timer', 'progress', 'clarification'] } },
    ['panel'],
  ),
  tool(
    'close_panel',
    'Ask the client to close a context panel.',
    { panel: { type: 'string', enum: ['set_receipt', 'rest_timer', 'progress', 'clarification'] } },
  ),
];

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OPERATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;

const objectValue = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'validation_error', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const rejectUnknown = (value: Record<string, unknown>, allowed: readonly string[]): void => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new ApiError(400, 'validation_error', `Unsupported field: ${unknown[0]}.`);
  }
};

const textValue = (
  value: unknown,
  label: string,
  options: { optional?: boolean; maximum?: number } = {},
): string | undefined => {
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'validation_error', `${label} must be text.`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > (options.maximum ?? 200)) {
    throw new ApiError(400, 'validation_error', `${label} is not valid.`);
  }
  return trimmed;
};

const numberValue = (
  value: unknown,
  label: string,
  options: { optional?: boolean; integer?: boolean; minimum?: number; maximum?: number } = {},
): number | undefined => {
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || (options.integer && !Number.isInteger(value))) {
    throw new ApiError(400, 'validation_error', `${label} must be a valid number.`);
  }
  if (value < (options.minimum ?? -Number.MAX_VALUE) || value > (options.maximum ?? Number.MAX_VALUE)) {
    throw new ApiError(400, 'validation_error', `${label} is outside the allowed range.`);
  }
  return value;
};

const enumValue = <T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
  optional = false,
): T | undefined => {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ApiError(400, 'validation_error', `${label} is not supported.`);
  }
  return value as T;
};

const identifierValue = (value: unknown, label: string, optional = false): string | undefined => {
  if (value === undefined && optional) return undefined;
  const parsed = textValue(value, label, { maximum: 200 });
  if (!parsed || !IDENTIFIER_PATTERN.test(parsed)) {
    throw new ApiError(400, 'validation_error', `${label} is not a valid record ID.`);
  }
  return parsed;
};

const operationKeyValue = (value: unknown): string => {
  const parsed = textValue(value, 'operationKey', { maximum: 128 });
  if (!parsed || !OPERATION_KEY_PATTERN.test(parsed)) {
    throw new ApiError(400, 'validation_error', 'operationKey is not valid.');
  }
  return parsed;
};

const localDateValue = (value: unknown, label: string): string => {
  const parsed = textValue(value, label, { maximum: 10 });
  if (!parsed || !LOCAL_DATE_PATTERN.test(parsed) || Number.isNaN(Date.parse(`${parsed}T00:00:00Z`))) {
    throw new ApiError(400, 'validation_error', `${label} must be YYYY-MM-DD.`);
  }
  return parsed;
};

const timestampValue = (value: unknown, label: string, optional = false): string | undefined => {
  if (value === undefined && optional) return undefined;
  const parsed = textValue(value, label, { maximum: 64 });
  if (!parsed || Number.isNaN(Date.parse(parsed))) {
    throw new ApiError(400, 'validation_error', `${label} must be an ISO timestamp.`);
  }
  return new Date(parsed).toISOString();
};

const timezoneValue = (value: unknown): string => {
  const parsed = textValue(value, 'timezone', { maximum: 100 }) as string;
  try {
    new Intl.DateTimeFormat('en', { timeZone: parsed }).format(new Date(0));
  } catch {
    throw new ApiError(400, 'validation_error', 'timezone must be a valid IANA timezone.');
  }
  return parsed;
};

const loadFields = (source: Record<string, unknown>) => ({
  load: numberValue(source.load, 'load', { optional: true, minimum: 0, maximum: 100000 }),
  loadUnit: enumValue(source.loadUnit, 'loadUnit', ['kg', 'lb'] as const, true),
  loadMode: enumValue(
    source.loadMode,
    'loadMode',
    [
      'barbell_total',
      'machine_total',
      'per_dumbbell',
      'per-dumbbell',
      'total',
      'bodyweight',
      'assisted',
      'not_applicable',
    ] as const,
    true,
  ),
});

const validateRecordedLoad = (
  fields: ReturnType<typeof loadFields>,
  label: string,
): void => {
  if (fields.load !== undefined && fields.loadMode !== 'bodyweight' && fields.loadUnit === undefined) {
    throw new ApiError(
      400,
      'validation_error',
      `${label}.loadUnit is required when a numeric load is recorded.`,
    );
  }
  if (fields.load !== undefined && fields.loadMode === undefined) {
    throw new ApiError(
      400,
      'validation_error',
      `${label}.loadMode is required when a numeric load is recorded; clarify total versus per-dumbbell load.`,
    );
  }
  if (fields.load === undefined && fields.loadUnit !== undefined) {
    throw new ApiError(
      400,
      'validation_error',
      `${label}.loadUnit cannot be recorded without a numeric load.`,
    );
  }
  if (fields.loadMode === 'bodyweight' && fields.load !== undefined) {
    throw new ApiError(
      400,
      'validation_error',
      `${label}.load must be omitted for a bodyweight record.`,
    );
  }
  if (fields.loadMode === 'not_applicable' && fields.load !== undefined) {
    throw new ApiError(
      400,
      'validation_error',
      `${label}.load must be omitted when load is not applicable.`,
    );
  }
};

const cleanOptional = <T extends Record<string, unknown>>(value: T): T => {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
};

const exerciseDrafts = (value: unknown): ExerciseDraft[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) {
    throw new ApiError(400, 'validation_error', 'exercises must contain between 1 and 30 items.');
  }
  return value.map((item, index) => {
    const source = objectValue(item, `exercises[${index}]`);
    rejectUnknown(source, ['name', 'sets', 'reps', 'load', 'loadUnit', 'loadMode', 'restSeconds']);
    const parsedLoad = loadFields(source);
    validateRecordedLoad(parsedLoad, `exercises[${index}]`);
    return cleanOptional({
      name: textValue(source.name, `exercises[${index}].name`, { maximum: 120 }) as string,
      sets: numberValue(source.sets, `exercises[${index}].sets`, {
        integer: true,
        minimum: 1,
        maximum: 100,
      }) as number,
      reps: numberValue(source.reps, `exercises[${index}].reps`, {
        optional: true,
        integer: true,
        minimum: 1,
        maximum: 1000,
      }),
      ...parsedLoad,
      restSeconds: numberValue(source.restSeconds, `exercises[${index}].restSeconds`, {
        optional: true,
        integer: true,
        minimum: 5,
        maximum: 3600,
      }),
    }) as ExerciseDraft;
  });
};

const parseArguments = <Name extends ToolName>(
  name: Name,
  raw: Record<string, unknown>,
): ToolArguments[Name] => {
  switch (name) {
    case 'get_session_context':
      rejectUnknown(raw, ['sessionId']);
      return cleanOptional({ sessionId: identifierValue(raw.sessionId, 'sessionId', true) }) as ToolArguments[Name];
    case 'draft_workout':
      rejectUnknown(raw, ['title', 'exercises', 'superset']);
      if (raw.superset !== undefined && typeof raw.superset !== 'boolean') throw new ApiError(400,'validation_error','superset must be boolean.');
      return cleanOptional({
        title: textValue(raw.title, 'title', { optional: true, maximum: 120 }),
        exercises: exerciseDrafts(raw.exercises),
        superset: raw.superset,
      }) as ToolArguments[Name];
    case 'select_exercise':
      rejectUnknown(raw, ['operationKey', 'exercise', 'exerciseInstanceId', 'clear']);
      if (raw.clear !== undefined && typeof raw.clear !== 'boolean') throw new ApiError(400,'validation_error','clear must be boolean.');
      return cleanOptional({ operationKey: operationKeyValue(raw.operationKey),
        exercise: textValue(raw.exercise,'exercise',{optional:true,maximum:160}),
        exerciseInstanceId: identifierValue(raw.exerciseInstanceId,'exerciseInstanceId',true), clear: raw.clear }) as ToolArguments[Name];
    case 'start_workout':
      if (raw.superset !== undefined && typeof raw.superset !== 'boolean') throw new ApiError(400,'validation_error','superset must be boolean.');
      rejectUnknown(raw, [
        'operationKey',
        'localDate',
        'timezone',
        'title',
        'plannedOccurrenceId',
        'superset',
        'exercises',
      ]);
      return cleanOptional({
        operationKey: operationKeyValue(raw.operationKey),
        localDate: localDateValue(raw.localDate, 'localDate'),
        timezone: timezoneValue(raw.timezone),
        title: textValue(raw.title, 'title', { optional: true, maximum: 120 }),
        plannedOccurrenceId: identifierValue(raw.plannedOccurrenceId, 'plannedOccurrenceId', true),
        superset: raw.superset === true,
        exercises: exerciseDrafts(raw.exercises),
      }) as ToolArguments[Name];
    case 'record_set':
      rejectUnknown(raw, [
        'operationKey', 'sessionId', 'exerciseInstanceId', 'reps', 'load', 'loadUnit',
        'loadMode', 'effort', 'feeling', 'completedAt',
      ]);
      const parsedLoad = loadFields(raw);
      validateRecordedLoad(parsedLoad, 'record_set');
      return cleanOptional({
        operationKey: operationKeyValue(raw.operationKey),
        sessionId: identifierValue(raw.sessionId, 'sessionId') as string,
        exerciseInstanceId: identifierValue(raw.exerciseInstanceId, 'exerciseInstanceId') as string,
        reps: numberValue(raw.reps, 'reps', { integer: true, minimum: 1, maximum: 1000 }) as number,
        ...parsedLoad,
        effort: numberValue(raw.effort, 'effort', { optional: true, minimum: 0, maximum: 10 }),
        feeling: textValue(raw.feeling, 'feeling', { optional: true, maximum: 240 }),
        completedAt: timestampValue(raw.completedAt, 'completedAt', true),
      }) as ToolArguments[Name];
    case 'correct_set': {
      rejectUnknown(raw, ['operationKey', 'setId', 'expectedVersion', 'reps', 'load', 'loadUnit', 'loadMode', 'effort']);
      const corrected = cleanOptional({
        operationKey: operationKeyValue(raw.operationKey),
        setId: identifierValue(raw.setId, 'setId') as string,
        expectedVersion: numberValue(raw.expectedVersion, 'expectedVersion', {
          integer: true,
          minimum: 1,
        }) as number,
        reps: numberValue(raw.reps, 'reps', { optional: true, integer: true, minimum: 1, maximum: 1000 }),
        ...loadFields(raw),
        effort: numberValue(raw.effort, 'effort', { optional: true, minimum: 0, maximum: 10 }),
      });
      if (Object.keys(corrected).every((key) => ['operationKey', 'setId', 'expectedVersion'].includes(key))) {
        throw new ApiError(400, 'validation_error', 'A correction must include at least one changed value.');
      }
      return corrected as ToolArguments[Name];
    }
    case 'undo_last_action':
      rejectUnknown(raw, ['operationKey', 'targetOperationKey']);
      return cleanOptional({
        operationKey: operationKeyValue(raw.operationKey),
        targetOperationKey:
          raw.targetOperationKey === undefined ? undefined : operationKeyValue(raw.targetOperationKey),
      }) as ToolArguments[Name];
    case 'start_rest_timer':
      rejectUnknown(raw, ['operationKey', 'sessionId', 'durationSeconds', 'startedAt']);
      return cleanOptional({
        operationKey: operationKeyValue(raw.operationKey),
        sessionId: identifierValue(raw.sessionId, 'sessionId') as string,
        durationSeconds: numberValue(raw.durationSeconds, 'durationSeconds', {
          integer: true,
          minimum: 5,
          maximum: 3600,
        }) as number,
        startedAt: timestampValue(raw.startedAt, 'startedAt', true),
      }) as ToolArguments[Name];
    case 'get_rest_status':
      rejectUnknown(raw, ['timerId']);
      return cleanOptional({ timerId: identifierValue(raw.timerId, 'timerId', true) }) as ToolArguments[Name];
    case 'finish_workout':
      rejectUnknown(raw, [
        'operationKey', 'sessionId', 'expectedVersion', 'localDate', 'timezone', 'feeling',
      ]);
      return cleanOptional({
        operationKey: operationKeyValue(raw.operationKey),
        sessionId: identifierValue(raw.sessionId, 'sessionId') as string,
        expectedVersion: numberValue(raw.expectedVersion, 'expectedVersion', {
          integer: true,
          minimum: 1,
        }) as number,
        localDate: localDateValue(raw.localDate, 'localDate'),
        timezone: timezoneValue(raw.timezone),
        feeling: textValue(raw.feeling, 'feeling', { optional: true, maximum: 240 }),
      }) as ToolArguments[Name];
    case 'record_cardio': {
      rejectUnknown(raw, [
        'operationKey', 'sessionId', 'activity', 'distance', 'distanceUnit', 'durationSeconds',
        'localDate', 'timezone', 'completedAt', 'feeling',
      ]);
      const parsed = cleanOptional({
        operationKey: operationKeyValue(raw.operationKey),
        sessionId: identifierValue(raw.sessionId, 'sessionId', true),
        activity: textValue(raw.activity, 'activity', { maximum: 120 }) as string,
        distance: numberValue(raw.distance, 'distance', { minimum: Number.MIN_VALUE, maximum: 100000 }) as number,
        distanceUnit: enumValue(raw.distanceUnit, 'distanceUnit', ['km', 'mi', 'm'] as const) as DistanceUnit,
        durationSeconds: numberValue(raw.durationSeconds, 'durationSeconds', {
          integer: true,
          minimum: 1,
          maximum: 604800,
        }) as number,
        localDate: localDateValue(raw.localDate, 'localDate'),
        timezone: timezoneValue(raw.timezone),
        completedAt: timestampValue(raw.completedAt, 'completedAt', true),
        feeling: textValue(raw.feeling, 'feeling', { optional: true, maximum: 240 }),
      });
      return parsed as ToolArguments[Name];
    }
    case 'get_progress': {
      rejectUnknown(raw, ['kind', 'exercise', 'activity', 'distance', 'distanceUnit', 'fromDate', 'toDate']);
      const parsed = cleanOptional({
        kind: enumValue(raw.kind, 'kind', ['strength', 'cardio', 'completion'] as const) as
          | 'strength'
          | 'cardio'
          | 'completion',
        exercise: textValue(raw.exercise, 'exercise', { optional: true, maximum: 120 }),
        activity: textValue(raw.activity, 'activity', { optional: true, maximum: 120 }),
        distance: numberValue(raw.distance, 'distance', { optional: true, minimum: Number.MIN_VALUE }),
        distanceUnit: enumValue(raw.distanceUnit, 'distanceUnit', ['km', 'mi', 'm'] as const, true),
        fromDate: raw.fromDate === undefined ? undefined : localDateValue(raw.fromDate, 'fromDate'),
        toDate: raw.toDate === undefined ? undefined : localDateValue(raw.toDate, 'toDate'),
      });
      if (parsed.kind === 'strength' && !parsed.exercise) {
        throw new ApiError(400, 'validation_error', 'A strength progress query needs an exercise.');
      }
      if ((parsed.distance === undefined) !== (parsed.distanceUnit === undefined)) {
        throw new ApiError(400, 'validation_error', 'distance and distanceUnit must be supplied together.');
      }
      if (parsed.fromDate && parsed.toDate && parsed.fromDate > parsed.toDate) {
        throw new ApiError(400, 'validation_error', 'fromDate must not be after toDate.');
      }
      return parsed as ToolArguments[Name];
    }
    case 'show_panel':
      rejectUnknown(raw, ['panel']);
      return {
        panel: enumValue(
          raw.panel,
          'panel',
          ['set_receipt', 'rest_timer', 'progress', 'clarification'] as const,
        ) as PanelName,
      } as ToolArguments[Name];
    case 'close_panel':
      rejectUnknown(raw, ['panel']);
      return cleanOptional({
        panel: enumValue(
          raw.panel,
          'panel',
          ['set_receipt', 'rest_timer', 'progress', 'clarification'] as const,
          true,
        ),
      }) as ToolArguments[Name];
  }
};

export const parseToolCall = (value: unknown): ParsedToolCall => {
  const source = objectValue(value, 'tool call');
  rejectUnknown(source, ['name', 'arguments']);
  const name = textValue(source.name, 'name', { maximum: 64 });
  if (!name || !TOOL_NAMES.includes(name as ToolName)) {
    throw new ApiError(400, 'validation_error', 'Unknown Knufl tool.');
  }
  const rawArguments = objectValue(source.arguments, 'arguments');
  const typedName = name as ToolName;
  return { name: typedName, arguments: parseArguments(typedName, rawArguments) } as ParsedToolCall;
};
