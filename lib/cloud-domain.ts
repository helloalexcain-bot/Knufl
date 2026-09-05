/**
 * Provider-independent workout domain for the voice companion.
 *
 * The Realtime model may propose one of these commands, but only this layer (or
 * the equivalent database transaction) decides what is persisted. All owner
 * identity is supplied by the authenticated application, never by model input.
 */

export type Identifier = string;
export type IsoTimestamp = string;
export type LocalDate = string;
export type LoadUnit = 'kg' | 'lb';
export type LoadMode = 'total' | 'per-dumbbell' | 'bodyweight' | 'assisted';
export type DistanceUnit = 'm' | 'km' | 'mi';
export type SyncState = 'pending' | 'synced' | 'conflict';

export interface VersionedRecord {
  version: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface WorkoutPlan extends VersionedRecord {
  id: Identifier;
  name: string;
  status: 'draft' | 'active' | 'archived';
  weeklyTarget?: number;
  scheduleDays?: string[];
  defaultActivityKey?: string;
  activityDetail?: string;
  nextSessionLocalDate?: LocalDate;
}

export interface PlanExercise extends VersionedRecord {
  id: Identifier;
  planId: Identifier;
  position: number;
  exerciseKey: string;
  displayName: string;
  targetSets?: number;
  targetReps?: number;
  targetLoad?: number;
  loadUnit?: LoadUnit;
  loadMode?: LoadMode;
  restSeconds?: number;
}

export interface WorkoutOccurrence extends VersionedRecord {
  id: Identifier;
  planId?: Identifier;
  scheduledLocalDate: LocalDate;
  timezone: string;
  status: 'scheduled' | 'completed' | 'cancelled' | 'skipped';
  completedSessionId?: Identifier;
}

export interface WorkoutSession extends VersionedRecord {
  id: Identifier;
  occurrenceId?: Identifier;
  source: 'planned' | 'manual' | 'legacy';
  status: 'active' | 'completed' | 'abandoned';
  localDate: LocalDate;
  timezone: string;
  startedAt: IsoTimestamp;
  completedAt?: IsoTimestamp;
  durationSeconds?: number;
  feeling?: string;
}

export interface ExerciseInstance extends VersionedRecord {
  id: Identifier;
  sessionId: Identifier;
  planExerciseId?: Identifier;
  position: number;
  exerciseKey: string;
  displayName: string;
  plannedSets?: number;
  plannedReps?: number;
  plannedLoad?: number;
  plannedLoadUnit?: LoadUnit;
  plannedLoadMode?: LoadMode;
  restSeconds?: number;
}

export interface CompletedSet extends VersionedRecord {
  id: Identifier;
  sessionId: Identifier;
  exerciseInstanceId: Identifier;
  setOrder: number;
  reps: number;
  load?: number;
  loadUnit?: LoadUnit;
  loadMode?: LoadMode;
  effort?: number;
  feeling?: string;
  completedAt: IsoTimestamp;
  correctedAt?: IsoTimestamp;
  deletedAt?: IsoTimestamp;
  syncState: SyncState;
}

export interface CardioRecord extends VersionedRecord {
  id: Identifier;
  sessionId: Identifier;
  activityKey: string;
  displayName: string;
  distance: number;
  distanceUnit: DistanceUnit;
  durationSeconds: number;
  completedAt: IsoTimestamp;
  localDate: LocalDate;
  timezone: string;
  feeling?: string;
  deletedAt?: IsoTimestamp;
  syncState: SyncState;
}

export interface RestTimer extends VersionedRecord {
  id: Identifier;
  sessionId: Identifier;
  exerciseInstanceId?: Identifier;
  status: 'running' | 'finished' | 'cancelled';
  startedAt: IsoTimestamp;
  endsAt: IsoTimestamp;
  stoppedAt?: IsoTimestamp;
}

export interface ExerciseDayCredit {
  localDate: LocalDate;
  timezone: string;
  firstSessionId: Identifier;
  earnedAt: IsoTimestamp;
}

export interface MilestoneUnlock {
  milestoneId: string;
  associatedSessionId?: Identifier;
  unlockedAt: IsoTimestamp;
}

export interface OperationReceipt {
  operationKey: string;
  operationType: DomainActionKind | 'draft-workout' | 'start-workout' | 'finish-workout';
  entityId?: Identifier;
  version?: number;
  completedAt: IsoTimestamp;
}

export type DomainActionKind = 'record-set' | 'correct-set' | 'undo-last-action';

interface SetAction {
  operationKey: string;
  kind: 'record-set' | 'correct-set';
  sessionId: Identifier;
  entityId: Identifier;
  before?: CompletedSet;
  after: CompletedSet;
  performedAt: IsoTimestamp;
  undoneByOperationKey?: string;
}

export interface WorkoutDomainState {
  accountId: Identifier;
  plans: WorkoutPlan[];
  planExercises: PlanExercise[];
  occurrences: WorkoutOccurrence[];
  sessions: WorkoutSession[];
  exercises: ExerciseInstance[];
  completedSets: CompletedSet[];
  cardioRecords: CardioRecord[];
  restTimers: RestTimer[];
  exerciseDayCredits: ExerciseDayCredit[];
  milestoneUnlocks: MilestoneUnlock[];
  operations: OperationReceipt[];
  /** Internal audit history used to make Undo deterministic. */
  actions: SetAction[];
}

export const createWorkoutDomainState = (accountId: Identifier): WorkoutDomainState => ({
  accountId,
  plans: [],
  planExercises: [],
  occurrences: [],
  sessions: [],
  exercises: [],
  completedSets: [],
  cardioRecords: [],
  restTimers: [],
  exerciseDayCredits: [],
  milestoneUnlocks: [],
  operations: [],
  actions: [],
});

export class DomainValidationError extends Error {
  override name = 'DomainValidationError';
}

export class DomainConflictError extends Error {
  override name = 'DomainConflictError';
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(
    message: string,
    expectedVersion: number,
    actualVersion: number,
  ) {
    super(message);
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export interface CommandResult<T> {
  state: WorkoutDomainState;
  value: T;
  duplicate: boolean;
}

const cleanKey = (value: string): string => value.trim().toLocaleLowerCase();

const requireText = (value: string, label: string): string => {
  const result = value.trim();
  if (!result) throw new DomainValidationError(`${label} is required.`);
  return result;
};

const requireTimestamp = (value: string, label: string): void => {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new DomainValidationError(`${label} must be an ISO timestamp.`);
  }
};

const requireLocalDate = (value: string): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new DomainValidationError('localDate must use YYYY-MM-DD.');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new DomainValidationError('localDate must be a real calendar date.');
  }
};

const findOperation = (state: WorkoutDomainState, operationKey: string): OperationReceipt | undefined =>
  state.operations.find((operation) => operation.operationKey === operationKey);

const assertReusableOperation = (
  state: WorkoutDomainState,
  operationKey: string,
  expectedType: OperationReceipt['operationType'],
): OperationReceipt | undefined => {
  const existing = findOperation(state, requireText(operationKey, 'operationKey'));
  if (existing && existing.operationType !== expectedType) {
    throw new DomainConflictError(
      `Operation key ${operationKey} was already used for ${existing.operationType}.`,
      0,
      1,
    );
  }
  return existing;
};

const addOperation = (
  state: WorkoutDomainState,
  receipt: OperationReceipt,
): WorkoutDomainState => ({ ...state, operations: [...state.operations, receipt] });

export interface DraftWorkoutInput {
  operationKey: string;
  planId: Identifier;
  name: string;
  weeklyTarget?: number;
  exercises: Array<{
    id: Identifier;
    exerciseKey: string;
    displayName: string;
    targetSets?: number;
    targetReps?: number;
    targetLoad?: number;
    loadUnit?: LoadUnit;
    loadMode?: LoadMode;
    restSeconds?: number;
  }>;
  now: IsoTimestamp;
}

/** A proposal creates planned records only; it never creates completed work. */
export const draftWorkout = (
  state: WorkoutDomainState,
  input: DraftWorkoutInput,
): CommandResult<WorkoutPlan> => {
  const previous = assertReusableOperation(state, input.operationKey, 'draft-workout');
  if (previous) {
    const value = state.plans.find((plan) => plan.id === previous.entityId);
    if (!value) throw new DomainValidationError('The prior draft result is unavailable.');
    return { state, value, duplicate: true };
  }
  requireTimestamp(input.now, 'now');
  if (state.plans.some((plan) => plan.id === input.planId)) {
    throw new DomainConflictError(`Plan ${input.planId} already exists.`, 0, 1);
  }
  if (input.weeklyTarget !== undefined && (!Number.isInteger(input.weeklyTarget) || input.weeklyTarget < 1)) {
    throw new DomainValidationError('weeklyTarget must be a positive whole number.');
  }

  const value: WorkoutPlan = {
    id: requireText(input.planId, 'planId'),
    name: requireText(input.name, 'name'),
    status: 'draft',
    weeklyTarget: input.weeklyTarget,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  for (const exercise of input.exercises) {
    if (exercise.targetLoad !== undefined && !exercise.loadUnit) {
      throw new DomainValidationError('A load unit is required for a weighted exercise target.');
    }
    if (exercise.targetLoad !== undefined && !exercise.loadMode) {
      throw new DomainValidationError('A load mode is required for a weighted exercise target.');
    }
  }

  const planExercises: PlanExercise[] = input.exercises.map((exercise, position) => ({
    id: requireText(exercise.id, 'exercise.id'),
    planId: value.id,
    position,
    exerciseKey: cleanKey(requireText(exercise.exerciseKey, 'exerciseKey')),
    displayName: requireText(exercise.displayName, 'displayName'),
    targetSets: exercise.targetSets,
    targetReps: exercise.targetReps,
    targetLoad: exercise.targetLoad,
    loadUnit: exercise.loadUnit,
    loadMode: exercise.loadMode,
    restSeconds: exercise.restSeconds,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  }));

  const next = addOperation({
    ...state,
    plans: [...state.plans, value],
    planExercises: [...state.planExercises, ...planExercises],
  }, {
    operationKey: input.operationKey,
    operationType: 'draft-workout',
    entityId: value.id,
    version: value.version,
    completedAt: input.now,
  });
  return { state: next, value, duplicate: false };
};

export interface StartWorkoutInput {
  operationKey: string;
  sessionId: Identifier;
  planId?: Identifier;
  occurrenceId?: Identifier;
  source: WorkoutSession['source'];
  localDate: LocalDate;
  timezone: string;
  startedAt: IsoTimestamp;
  exerciseIds?: Identifier[];
}

export const startWorkout = (
  state: WorkoutDomainState,
  input: StartWorkoutInput,
): CommandResult<WorkoutSession> => {
  const previous = assertReusableOperation(state, input.operationKey, 'start-workout');
  if (previous) {
    const value = state.sessions.find((session) => session.id === previous.entityId);
    if (!value) throw new DomainValidationError('The prior session result is unavailable.');
    return { state, value, duplicate: true };
  }
  requireTimestamp(input.startedAt, 'startedAt');
  requireLocalDate(input.localDate);
  requireText(input.timezone, 'timezone');
  if (state.sessions.some((session) => session.status === 'active')) {
    throw new DomainValidationError('A workout is already active. Finish it before starting another.');
  }
  if (state.sessions.some((session) => session.id === input.sessionId)) {
    throw new DomainConflictError(`Session ${input.sessionId} already exists.`, 0, 1);
  }

  const value: WorkoutSession = {
    id: requireText(input.sessionId, 'sessionId'),
    occurrenceId: input.occurrenceId,
    source: input.source,
    status: 'active',
    localDate: input.localDate,
    timezone: input.timezone,
    startedAt: input.startedAt,
    version: 1,
    createdAt: input.startedAt,
    updatedAt: input.startedAt,
  };
  const planned = input.planId
    ? state.planExercises.filter((exercise) => exercise.planId === input.planId)
    : [];
  const exercises = planned.map((exercise, index): ExerciseInstance => ({
    id: input.exerciseIds?.[index] ?? `${value.id}:${exercise.id}`,
    sessionId: value.id,
    planExerciseId: exercise.id,
    position: exercise.position,
    exerciseKey: exercise.exerciseKey,
    displayName: exercise.displayName,
    plannedSets: exercise.targetSets,
    plannedReps: exercise.targetReps,
    plannedLoad: exercise.targetLoad,
    plannedLoadUnit: exercise.loadUnit,
    plannedLoadMode: exercise.loadMode,
    restSeconds: exercise.restSeconds,
    version: 1,
    createdAt: input.startedAt,
    updatedAt: input.startedAt,
  }));

  const next = addOperation({
    ...state,
    sessions: [...state.sessions, value],
    exercises: [...state.exercises, ...exercises],
  }, {
    operationKey: input.operationKey,
    operationType: 'start-workout',
    entityId: value.id,
    version: value.version,
    completedAt: input.startedAt,
  });
  return { state: next, value, duplicate: false };
};

export interface RecordSetInput {
  operationKey: string;
  setId: Identifier;
  sessionId: Identifier;
  exerciseInstanceId: Identifier;
  reps: number;
  load?: number;
  loadUnit?: LoadUnit;
  loadMode?: LoadMode;
  effort?: number;
  feeling?: string;
  completedAt: IsoTimestamp;
}

const validateActualSet = (input: Pick<RecordSetInput, 'reps' | 'load' | 'loadUnit' | 'loadMode' | 'effort'>): void => {
  if (!Number.isInteger(input.reps) || input.reps < 1) {
    throw new DomainValidationError('Actual reps must be a positive whole number.');
  }
  if (input.load !== undefined && (!Number.isFinite(input.load) || input.load < 0)) {
    throw new DomainValidationError('Actual load must be zero or greater.');
  }
  if (input.load !== undefined && input.loadMode !== 'bodyweight' && !input.loadUnit) {
    throw new DomainValidationError('A load unit is required for a weighted set.');
  }
  if (input.load !== undefined && !input.loadMode) {
    throw new DomainValidationError('A load mode is required for a weighted set.');
  }
  if (input.effort !== undefined && (!Number.isFinite(input.effort) || input.effort < 0 || input.effort > 10)) {
    throw new DomainValidationError('Effort must be between 0 and 10.');
  }
};

export const recordSet = (
  state: WorkoutDomainState,
  input: RecordSetInput,
): CommandResult<CompletedSet> => {
  const previous = assertReusableOperation(state, input.operationKey, 'record-set');
  if (previous) {
    const value = state.completedSets.find((set) => set.id === previous.entityId);
    if (!value) throw new DomainValidationError('The prior set result is unavailable.');
    return { state, value, duplicate: true };
  }
  requireTimestamp(input.completedAt, 'completedAt');
  validateActualSet(input);
  const session = state.sessions.find((candidate) => candidate.id === input.sessionId);
  if (!session || session.status !== 'active') {
    throw new DomainValidationError('Sets can only be recorded in an active workout.');
  }
  const exercise = state.exercises.find((candidate) => candidate.id === input.exerciseInstanceId);
  if (!exercise || exercise.sessionId !== session.id) {
    throw new DomainValidationError('The exercise does not belong to this workout.');
  }
  if (state.completedSets.some((set) => set.id === input.setId)) {
    throw new DomainConflictError(`Set ${input.setId} already exists.`, 0, 1);
  }

  const setOrder = state.completedSets.filter(
    (set) => set.exerciseInstanceId === exercise.id && !set.deletedAt,
  ).length + 1;
  const value: CompletedSet = {
    id: requireText(input.setId, 'setId'),
    sessionId: session.id,
    exerciseInstanceId: exercise.id,
    setOrder,
    reps: input.reps,
    load: input.load,
    loadUnit: input.loadUnit,
    loadMode: input.loadMode,
    effort: input.effort,
    feeling: input.feeling?.trim() || undefined,
    completedAt: input.completedAt,
    syncState: 'synced',
    version: 1,
    createdAt: input.completedAt,
    updatedAt: input.completedAt,
  };
  const action: SetAction = {
    operationKey: input.operationKey,
    kind: 'record-set',
    sessionId: session.id,
    entityId: value.id,
    after: value,
    performedAt: input.completedAt,
  };
  const next = addOperation({
    ...state,
    completedSets: [...state.completedSets, value],
    actions: [...state.actions, action],
  }, {
    operationKey: input.operationKey,
    operationType: 'record-set',
    entityId: value.id,
    version: value.version,
    completedAt: input.completedAt,
  });
  return { state: next, value, duplicate: false };
};

export interface CorrectSetInput {
  operationKey: string;
  setId: Identifier;
  expectedVersion: number;
  changes: Partial<Pick<CompletedSet, 'reps' | 'load' | 'loadUnit' | 'loadMode' | 'effort' | 'feeling'>>;
  correctedAt: IsoTimestamp;
}

export const correctSet = (
  state: WorkoutDomainState,
  input: CorrectSetInput,
): CommandResult<CompletedSet> => {
  const previous = assertReusableOperation(state, input.operationKey, 'correct-set');
  if (previous) {
    const value = state.completedSets.find((set) => set.id === previous.entityId);
    if (!value) throw new DomainValidationError('The prior correction result is unavailable.');
    return { state, value, duplicate: true };
  }
  requireTimestamp(input.correctedAt, 'correctedAt');
  const current = state.completedSets.find((set) => set.id === input.setId && !set.deletedAt);
  if (!current) throw new DomainValidationError('The set to correct was not found.');
  if (current.version !== input.expectedVersion) {
    throw new DomainConflictError(
      'The set changed on another device. Refresh before correcting it.',
      input.expectedVersion,
      current.version,
    );
  }
  const merged = { ...current, ...input.changes };
  validateActualSet(merged);
  const value: CompletedSet = {
    ...merged,
    feeling: merged.feeling?.trim() || undefined,
    version: current.version + 1,
    correctedAt: input.correctedAt,
    updatedAt: input.correctedAt,
    syncState: 'synced',
  };
  const action: SetAction = {
    operationKey: input.operationKey,
    kind: 'correct-set',
    sessionId: value.sessionId,
    entityId: value.id,
    before: current,
    after: value,
    performedAt: input.correctedAt,
  };
  const next = addOperation({
    ...state,
    completedSets: state.completedSets.map((set) => (set.id === value.id ? value : set)),
    actions: [...state.actions, action],
  }, {
    operationKey: input.operationKey,
    operationType: 'correct-set',
    entityId: value.id,
    version: value.version,
    completedAt: input.correctedAt,
  });
  return { state: next, value, duplicate: false };
};

export interface UndoInput {
  operationKey: string;
  sessionId: Identifier;
  at: IsoTimestamp;
}

export interface UndoResult {
  undoneOperationKey?: string;
  set?: CompletedSet;
}

export const undoLastAction = (
  state: WorkoutDomainState,
  input: UndoInput,
): CommandResult<UndoResult> => {
  const previous = assertReusableOperation(state, input.operationKey, 'undo-last-action');
  if (previous) {
    return {
      state,
      value: { undoneOperationKey: previous.entityId },
      duplicate: true,
    };
  }
  requireTimestamp(input.at, 'at');
  const action = [...state.actions].reverse().find(
    (candidate) => candidate.sessionId === input.sessionId && !candidate.undoneByOperationKey,
  );
  if (!action) {
    const next = addOperation(state, {
      operationKey: input.operationKey,
      operationType: 'undo-last-action',
      completedAt: input.at,
    });
    return { state: next, value: {}, duplicate: false };
  }
  const current = state.completedSets.find((set) => set.id === action.entityId);
  if (!current) throw new DomainValidationError('The set for the last action is unavailable.');

  const value: CompletedSet = action.kind === 'record-set'
    ? {
      ...current,
      deletedAt: input.at,
      updatedAt: input.at,
      version: current.version + 1,
    }
    : {
      ...action.before!,
      correctedAt: input.at,
      updatedAt: input.at,
      version: current.version + 1,
    };
  const actions = state.actions.map((candidate) => (
    candidate.operationKey === action.operationKey
      ? { ...candidate, undoneByOperationKey: input.operationKey }
      : candidate
  ));
  const next = addOperation({
    ...state,
    completedSets: state.completedSets.map((set) => (set.id === value.id ? value : set)),
    actions,
  }, {
    operationKey: input.operationKey,
    operationType: 'undo-last-action',
    entityId: action.operationKey,
    version: value.version,
    completedAt: input.at,
  });
  return {
    state: next,
    value: { undoneOperationKey: action.operationKey, set: value },
    duplicate: false,
  };
};

export interface FinishWorkoutInput {
  operationKey: string;
  sessionId: Identifier;
  expectedVersion: number;
  completedAt: IsoTimestamp;
}

/**
 * The session's localDate/timezone are frozen at start. Travel later cannot
 * rewrite an earned day, and a second workout on that same local date is logged
 * without another credit.
 */
export const finishWorkout = (
  state: WorkoutDomainState,
  input: FinishWorkoutInput,
): CommandResult<WorkoutSession> => {
  const previous = assertReusableOperation(state, input.operationKey, 'finish-workout');
  if (previous) {
    const value = state.sessions.find((session) => session.id === previous.entityId);
    if (!value) throw new DomainValidationError('The prior finish result is unavailable.');
    return { state, value, duplicate: true };
  }
  requireTimestamp(input.completedAt, 'completedAt');
  const current = state.sessions.find((session) => session.id === input.sessionId);
  if (!current) throw new DomainValidationError('The workout was not found.');
  if (current.version !== input.expectedVersion) {
    throw new DomainConflictError(
      'The workout changed on another device. Refresh before finishing it.',
      input.expectedVersion,
      current.version,
    );
  }
  const value: WorkoutSession = {
    ...current,
    status: 'completed',
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
    version: current.version + 1,
  };
  const alreadyCredited = state.exerciseDayCredits.some((credit) => credit.localDate === value.localDate);
  const exerciseDayCredits = alreadyCredited ? state.exerciseDayCredits : [...state.exerciseDayCredits, {
    localDate: value.localDate,
    timezone: value.timezone,
    firstSessionId: value.id,
    earnedAt: input.completedAt,
  }];
  const milestoneUnlocks = [...state.milestoneUnlocks];
  if (!milestoneUnlocks.some((milestone) => milestone.milestoneId === 'first-session')) {
    milestoneUnlocks.push({
      milestoneId: 'first-session',
      associatedSessionId: value.id,
      unlockedAt: input.completedAt,
    });
  }
  if (
    exerciseDayCredits.length >= 3
    && !milestoneUnlocks.some((milestone) => milestone.milestoneId === 'little-mountain')
  ) {
    milestoneUnlocks.push({
      milestoneId: 'little-mountain',
      associatedSessionId: value.id,
      unlockedAt: input.completedAt,
    });
  }
  const next = addOperation({
    ...state,
    sessions: state.sessions.map((session) => (session.id === value.id ? value : session)),
    occurrences: state.occurrences.map((occurrence) => (
      occurrence.id === value.occurrenceId
        ? {
          ...occurrence,
          status: 'completed' as const,
          completedSessionId: value.id,
          version: occurrence.version + 1,
          updatedAt: input.completedAt,
        }
        : occurrence
    )),
    exerciseDayCredits,
    milestoneUnlocks,
  }, {
    operationKey: input.operationKey,
    operationType: 'finish-workout',
    entityId: value.id,
    version: value.version,
    completedAt: input.completedAt,
  });
  return { state: next, value, duplicate: false };
};

export const remainingRestSeconds = (timer: RestTimer, now: IsoTimestamp): number => {
  requireTimestamp(now, 'now');
  if (timer.status !== 'running') return 0;
  return Math.max(0, Math.ceil((Date.parse(timer.endsAt) - Date.parse(now)) / 1_000));
};

export interface StrengthProgressPoint {
  setId: Identifier;
  completedAt: IsoTimestamp;
  reps: number;
  load?: number;
  loadUnit?: LoadUnit;
  loadMode?: LoadMode;
}

export type StrengthProgress =
  | { status: 'no-data'; summary: string; points: [] }
  | { status: 'needs-context'; summary: string; compatibilityGroups: string[]; points: [] }
  | { status: 'ready'; summary: string; compatibilityKey: string; points: StrengthProgressPoint[] };

const loadCompatibilityKey = (set: CompletedSet): string => {
  if (set.loadMode === 'bodyweight' || set.load === undefined) return 'bodyweight / reps';
  return `${set.loadUnit ?? 'unit missing'} / ${set.loadMode ?? 'mode missing'}`;
};

const describeSet = (point: StrengthProgressPoint): string => {
  if (point.loadMode === 'bodyweight' || point.load === undefined) return `${point.reps} reps at bodyweight`;
  const mode = point.loadMode === 'per-dumbbell' ? ' per dumbbell' : point.loadMode === 'total' ? ' total' : '';
  return `${point.reps} reps at ${point.load} ${point.loadUnit}${mode}`;
};

/** Returns saved actuals only. It never turns targets into results or compares incompatible loading modes. */
export const getStrengthProgress = (
  state: WorkoutDomainState,
  exerciseKey: string,
  compatibilityKey?: string,
): StrengthProgress => {
  const instanceIds = new Set(state.exercises
    .filter((exercise) => cleanKey(exercise.exerciseKey) === cleanKey(exerciseKey))
    .map((exercise) => exercise.id));
  const actuals = state.completedSets
    .filter((set) => instanceIds.has(set.exerciseInstanceId) && !set.deletedAt)
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  if (!actuals.length) return { status: 'no-data', summary: 'No completed sets are saved for that exercise.', points: [] };

  const groups = [...new Set(actuals.map(loadCompatibilityKey))].sort();
  if (!compatibilityKey && groups.length > 1) {
    return {
      status: 'needs-context',
      summary: 'The saved sets use different load units or modes. Choose one before comparing.',
      compatibilityGroups: groups,
      points: [],
    };
  }
  const chosen = compatibilityKey ?? groups[0];
  const points = actuals
    .filter((set) => loadCompatibilityKey(set) === chosen)
    .map((set): StrengthProgressPoint => ({
      setId: set.id,
      completedAt: set.completedAt,
      reps: set.reps,
      load: set.load,
      loadUnit: set.loadUnit,
      loadMode: set.loadMode,
    }));
  if (!points.length) return { status: 'no-data', summary: 'No completed sets match that load context.', points: [] };
  const first = points[0];
  const latest = points[points.length - 1];
  return {
    status: 'ready',
    compatibilityKey: chosen,
    points,
    summary: `${points.length} actual ${points.length === 1 ? 'set' : 'sets'} saved. First: ${describeSet(first)}. Latest: ${describeSet(latest)}.`,
  };
};

export interface CardioProgressPoint {
  recordId: Identifier;
  completedAt: IsoTimestamp;
  distance: number;
  distanceUnit: DistanceUnit;
  durationSeconds: number;
}

export type CardioProgress =
  | { status: 'no-data'; summary: string; points: [] }
  | { status: 'needs-distance'; summary: string; distances: string[]; points: [] }
  | { status: 'ready'; summary: string; distance: string; points: CardioProgressPoint[] };

const distanceInMetres = (record: Pick<CardioRecord, 'distance' | 'distanceUnit'>): number => {
  if (record.distanceUnit === 'km') return record.distance * 1_000;
  if (record.distanceUnit === 'mi') return record.distance * 1_609.344;
  return record.distance;
};

const distanceKey = (record: Pick<CardioRecord, 'distance' | 'distanceUnit'>): string =>
  distanceInMetres(record).toFixed(3);

/** Compatible-distance comparison only; unlike runs are never presented as equivalent. */
export const getCardioProgress = (
  state: WorkoutDomainState,
  activityKey: string,
  requestedDistance?: { distance: number; unit: DistanceUnit },
): CardioProgress => {
  const records = state.cardioRecords
    .filter((record) => cleanKey(record.activityKey) === cleanKey(activityKey) && !record.deletedAt)
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  if (!records.length) return { status: 'no-data', summary: 'No completed cardio records are saved for that activity.', points: [] };
  const distanceGroups = [...new Set(records.map(distanceKey))].sort((a, b) => Number(a) - Number(b));
  if (!requestedDistance && distanceGroups.length > 1) {
    return {
      status: 'needs-distance',
      summary: 'The saved activities cover different distances. Choose a distance before comparing times.',
      distances: distanceGroups.map((group) => {
        const example = records.find((record) => distanceKey(record) === group)!;
        return `${example.distance} ${example.distanceUnit}`;
      }),
      points: [],
    };
  }
  const chosenKey = requestedDistance
    ? distanceKey({ distance: requestedDistance.distance, distanceUnit: requestedDistance.unit })
    : distanceGroups[0];
  const chosenLabel = requestedDistance
    ? `${requestedDistance.distance} ${requestedDistance.unit}`
    : (() => {
      const example = records.find((record) => distanceKey(record) === chosenKey)!;
      return `${example.distance} ${example.distanceUnit}`;
    })();
  const points = records
    .filter((record) => distanceKey(record) === chosenKey)
    .map((record): CardioProgressPoint => ({
      recordId: record.id,
      completedAt: record.completedAt,
      distance: record.distance,
      distanceUnit: record.distanceUnit,
      durationSeconds: record.durationSeconds,
    }));
  if (!points.length) return { status: 'no-data', summary: `No completed ${chosenLabel} records are saved.`, points: [] };
  const first = points[0].durationSeconds;
  const latest = points[points.length - 1].durationSeconds;
  return {
    status: 'ready',
    distance: chosenLabel,
    points,
    summary: `${points.length} completed ${chosenLabel} ${cleanKey(activityKey)} ${points.length === 1 ? 'record' : 'records'}. First: ${first} seconds. Latest: ${latest} seconds.`,
  };
};

export interface CompletionRate {
  completed: number;
  eligible: number;
  rate?: number;
  windowStart: LocalDate;
  windowEnd: LocalDate;
}

export const getCompletionRate = (
  occurrences: WorkoutOccurrence[],
  windowStart: LocalDate,
  windowEnd: LocalDate,
  today: LocalDate,
): CompletionRate => {
  [windowStart, windowEnd, today].forEach(requireLocalDate);
  const eligibleOccurrences = occurrences.filter((occurrence) => (
    occurrence.scheduledLocalDate >= windowStart
    && occurrence.scheduledLocalDate <= windowEnd
    && occurrence.scheduledLocalDate <= today
    && occurrence.status !== 'cancelled'
  ));
  const completed = eligibleOccurrences.filter((occurrence) => occurrence.status === 'completed').length;
  return {
    completed,
    eligible: eligibleOccurrences.length,
    rate: eligibleOccurrences.length ? completed / eligibleOccurrences.length : undefined,
    windowStart,
    windowEnd,
  };
};

export interface LegacyImportPreview {
  valid: true;
  companionName: string;
  sanitizedProfile: { name: string };
  sourceVersion: number;
  importable: { sessionIds: string[]; memoryIds: string[]; milestoneIds: string[] };
  duplicate: { sessionIds: string[]; memoryIds: string[]; milestoneIds: string[] };
  conflicts: Array<{ kind: 'session' | 'memory'; id: string }>;
}

interface LegacyExportShape {
  version: number;
  profile: Record<string, unknown>;
  logs: Array<Record<string, unknown>>;
  memories?: Array<Record<string, unknown>>;
  unlockedMoves?: unknown[];
}

const stableSubset = (record: Record<string, unknown>, keys: string[]): string =>
  JSON.stringify(Object.fromEntries(keys.map((key) => [key, record[key] ?? null])));

/**
 * Produces a non-mutating preview. Gender/pronoun fields are intentionally not
 * represented in the result. Same IDs with changed content are conflicts, not
 * silent overwrites.
 */
export const previewLegacyImport = (
  raw: string | unknown,
  existing: {
    sessions?: Array<Pick<WorkoutSession, 'id' | 'localDate' | 'source' | 'startedAt'>>;
    memories?: Array<{ id: string; title: string; note: string; associatedSessionId?: string }>;
    milestoneIds?: string[];
  } = {},
): LegacyImportPreview => {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || typeof value !== 'object') throw new DomainValidationError('The import is not a Knufl export.');
  const parsed = value as Partial<LegacyExportShape>;
  if (parsed.version !== 1 || !parsed.profile || !Array.isArray(parsed.logs)) {
    throw new DomainValidationError('The import is not a supported Knufl export.');
  }
  const name = typeof parsed.profile.name === 'string' ? parsed.profile.name.trim() : '';
  if (!name) throw new DomainValidationError('The import does not include a companion name.');

  const existingSessions = new Map((existing.sessions ?? []).map((session) => [session.id, session]));
  const existingMemories = new Map((existing.memories ?? []).map((memory) => [memory.id, memory]));
  const currentMilestones = new Set(existing.milestoneIds ?? []);
  const importable = { sessionIds: [] as string[], memoryIds: [] as string[], milestoneIds: [] as string[] };
  const duplicate = { sessionIds: [] as string[], memoryIds: [] as string[], milestoneIds: [] as string[] };
  const conflicts: LegacyImportPreview['conflicts'] = [];

  for (const log of parsed.logs) {
    if (typeof log.id !== 'string' || typeof log.date !== 'string' || typeof log.createdAt !== 'string') {
      throw new DomainValidationError('A legacy session is missing its stable ID, date or timestamp.');
    }
    const current = existingSessions.get(log.id);
    if (!current) {
      importable.sessionIds.push(log.id);
      continue;
    }
    const incomingComparable = stableSubset({
      id: log.id,
      localDate: log.date,
      source: 'legacy',
      startedAt: log.createdAt,
    }, ['id', 'localDate', 'source', 'startedAt']);
    const currentComparable = stableSubset(current as unknown as Record<string, unknown>, ['id', 'localDate', 'source', 'startedAt']);
    if (incomingComparable === currentComparable) duplicate.sessionIds.push(log.id);
    else conflicts.push({ kind: 'session', id: log.id });
  }

  for (const memory of parsed.memories ?? []) {
    if (typeof memory.id !== 'string' || typeof memory.title !== 'string' || typeof memory.note !== 'string') {
      throw new DomainValidationError('A legacy memory is missing its stable ID or content.');
    }
    const current = existingMemories.get(memory.id);
    if (!current) {
      importable.memoryIds.push(memory.id);
      continue;
    }
    const keys = ['id', 'title', 'note', 'associatedSessionId'];
    const incomingComparable = stableSubset(memory, keys);
    const currentComparable = stableSubset(current as unknown as Record<string, unknown>, keys);
    if (incomingComparable === currentComparable) duplicate.memoryIds.push(memory.id);
    else conflicts.push({ kind: 'memory', id: memory.id });
  }

  for (const milestone of parsed.unlockedMoves ?? []) {
    if (typeof milestone !== 'string') continue;
    if (currentMilestones.has(milestone)) duplicate.milestoneIds.push(milestone);
    else importable.milestoneIds.push(milestone);
  }

  return {
    valid: true,
    companionName: name,
    sanitizedProfile: { name },
    sourceVersion: parsed.version,
    importable,
    duplicate,
    conflicts,
  };
};
