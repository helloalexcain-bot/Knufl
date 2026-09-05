'use client';

import {
  correctSet,
  createWorkoutDomainState,
  draftWorkout,
  finishWorkout,
  getCardioProgress,
  getCompletionRate,
  getStrengthProgress,
  recordSet,
  remainingRestSeconds,
  startWorkout,
  undoLastAction,
  previewLegacyImport,
  type CardioRecord,
  type RestTimer,
  type WorkoutDomainState,
} from './cloud-domain.ts';
import { parseProgressImport } from './storage.ts';

export const DEMO_STORAGE_KEY = 'knufl.voice.demo.v1::development-demonstrator';

export type ToolName =
  | 'get_session_context'
  | 'draft_workout'
  | 'start_workout'
  | 'record_set'
  | 'correct_set'
  | 'undo_last_action'
  | 'start_rest_timer'
  | 'get_rest_status'
  | 'finish_workout'
  | 'record_cardio'
  | 'get_progress'
  | 'show_panel'
  | 'close_panel';

export interface ToolRequest {
  name: ToolName;
  arguments: Record<string, unknown>;
  operationId: string;
}

export interface ToolResult {
  ok: boolean;
  tool: ToolName;
  message: string;
  data?: Record<string, unknown>;
  panel?: 'set' | 'rest' | 'progress' | 'plan' | 'history' | 'clarification' | null;
  duplicate?: boolean;
}

interface LegacyMemory {
  id: string;
  associatedSessionId?: string;
  title: string;
  note: string;
  createdAt: string;
}

export interface DemoState {
  schemaVersion: 1;
  companionName: string;
  domain: WorkoutDomainState;
  currentPlanId?: string;
  currentSessionId?: string;
  currentExerciseId?: string;
  legacyMemories: LegacyMemory[];
  legacyMilestoneIds: string[];
  importedSourceIds: string[];
  auxiliaryOperationIds: string[];
}

const newId = (): string => {
  if (typeof crypto === 'undefined' || !('randomUUID' in crypto)) {
    throw new Error('This browser cannot create secure record identifiers.');
  }
  return crypto.randomUUID();
};

const nowIso = (): string => new Date().toISOString();

export const localDate = (date = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
};

const timezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const cleanString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const firstObject = (value: unknown): Record<string, unknown> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const first: unknown = value[0];
  return first && typeof first === 'object' && !Array.isArray(first)
    ? first as Record<string, unknown>
    : undefined;
};

const positiveInteger = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
};

const nonNegativeNumber = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};

const freshState = (): DemoState => ({
  schemaVersion: 1,
  companionName: 'Knufl',
  domain: createWorkoutDomainState('development-demonstrator'),
  legacyMemories: [],
  legacyMilestoneIds: [],
  importedSourceIds: [],
  auxiliaryOperationIds: [],
});

const isDemoState = (value: unknown): value is DemoState => {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<DemoState>;
  return state.schemaVersion === 1
    && typeof state.companionName === 'string'
    && Boolean(state.domain && typeof state.domain === 'object')
    && Array.isArray(state.legacyMemories)
    && Array.isArray(state.legacyMilestoneIds)
    && Array.isArray(state.importedSourceIds)
    && Array.isArray(state.auxiliaryOperationIds);
};

interface DevelopmentDemoExport {
  kind: 'knufl-development-demonstrator';
  data: DemoState;
}

export const isDevelopmentDemoExport = (value: unknown): value is DevelopmentDemoExport => {
  if (!value || typeof value !== 'object') return false;
  const archive = value as Partial<DevelopmentDemoExport>;
  return archive.kind === 'knufl-development-demonstrator' && isDemoState(archive.data);
};

const parseDevelopmentDemoExport = (text: string): DevelopmentDemoExport | undefined => {
  const value: unknown = JSON.parse(text);
  return isDevelopmentDemoExport(value) ? value : undefined;
};

const isEmptyDemoState = (state: DemoState): boolean => state.companionName === 'Knufl'
  && !state.currentPlanId
  && !state.currentSessionId
  && !state.currentExerciseId
  && state.legacyMemories.length === 0
  && state.legacyMilestoneIds.length === 0
  && state.importedSourceIds.length === 0
  && state.auxiliaryOperationIds.length === 0
  && Object.entries(state.domain)
    .filter(([key]) => key !== 'accountId')
    .every(([, value]) => Array.isArray(value) && value.length === 0);

export function loadDemoState(): DemoState {
  if (typeof window === 'undefined') return freshState();
  try {
    const raw = window.localStorage.getItem(DEMO_STORAGE_KEY);
    if (!raw) return freshState();
    const parsed: unknown = JSON.parse(raw);
    return isDemoState(parsed) ? parsed : freshState();
  } catch {
    return freshState();
  }
}

export function saveDemoState(state: DemoState): void {
  window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state));
}

export const exportDemoState = (state: DemoState): string => JSON.stringify({
  kind: 'knufl-development-demonstrator',
  exportedAt: nowIso(),
  data: state,
}, null, 2);

export interface LegacyPreview {
  companionName: string;
  sessions: number;
  memories: number;
  milestoneIds: string[];
  duplicateSessions: number;
  conflicts: number;
}

export const previewLegacyFile = (text: string, state: DemoState): LegacyPreview => {
  const demonstrator = parseDevelopmentDemoExport(text);
  if (demonstrator) {
    const archived = demonstrator.data;
    const exactDuplicate = JSON.stringify(archived) === JSON.stringify(state);
    const conflicts = isEmptyDemoState(state) || exactDuplicate ? 0 : 1;
    const existingSessionIds = new Set(state.domain.sessions.map((session) => session.id));
    return {
      companionName: archived.companionName,
      sessions: archived.domain.sessions.length,
      memories: archived.legacyMemories.length,
      milestoneIds: [...new Set([
        ...archived.legacyMilestoneIds,
        ...archived.domain.milestoneUnlocks.map((item) => item.milestoneId),
      ])],
      duplicateSessions: archived.domain.sessions.filter((session) => existingSessionIds.has(session.id)).length,
      conflicts,
    };
  }
  const data = parseProgressImport(text);
  const preview = previewLegacyImport(data, {
    sessions: state.domain.sessions,
    memories: state.legacyMemories,
    milestoneIds: [
      ...state.legacyMilestoneIds,
      ...state.domain.milestoneUnlocks.map((item) => item.milestoneId),
    ],
  });
  const hasExistingProfile = state.importedSourceIds.length > 0
    || state.domain.sessions.length > 0
    || state.legacyMemories.length > 0;
  const profileConflict = hasExistingProfile && state.companionName !== data.profile.name ? 1 : 0;
  return {
    companionName: data.profile.name,
    sessions: data.logs.length,
    memories: data.memories.length,
    milestoneIds: [...data.unlockedMoves],
    duplicateSessions: preview.duplicate.sessionIds.length,
    conflicts: preview.conflicts.length + profileConflict,
  };
};

/** Development-only migration mirror. Cloud migration is performed atomically by Supabase. */
export const importLegacyFile = (text: string, state: DemoState): DemoState => {
  const demonstrator = parseDevelopmentDemoExport(text);
  if (demonstrator) {
    if (JSON.stringify(demonstrator.data) === JSON.stringify(state)) return state;
    if (!isEmptyDemoState(state)) {
      throw new Error('Import stopped because this demonstrator already contains different records.');
    }
    return demonstrator.data;
  }
  const legacy = parseProgressImport(text);
  const preview = previewLegacyFile(text, state);
  if (preview.conflicts > 0) {
    throw new Error('Import stopped because existing demonstrator records with the same IDs contain different data.');
  }
  const imported = new Set(state.importedSourceIds);
  const existingSessionIds = new Set(state.domain.sessions.map((session) => session.id));
  const newLogs = legacy.logs.filter((log) => !existingSessionIds.has(log.id));
  const sessions = [...state.domain.sessions];
  const exercises = [...state.domain.exercises];
  const credits = [...state.domain.exerciseDayCredits];

  for (const log of newLogs) {
    const activity = cleanString(log.activity) || 'Activity';
    const durationSeconds = typeof log.duration === 'number' && Number.isFinite(log.duration) && log.duration >= 0
      ? Math.round(log.duration * 60)
      : undefined;
    sessions.push({
      id: log.id,
      source: 'legacy',
      status: 'completed',
      localDate: log.date,
      timezone: 'Legacy/Unknown',
      startedAt: log.createdAt,
      completedAt: log.createdAt,
      durationSeconds,
      feeling: log.feeling,
      version: 1,
      createdAt: log.createdAt,
      updatedAt: log.createdAt,
    });
    exercises.push({
      id: `${log.id}:legacy-activity`,
      sessionId: log.id,
      position: 0,
      exerciseKey: activity.toLocaleLowerCase(),
      displayName: activity,
      version: 1,
      createdAt: log.createdAt,
      updatedAt: log.createdAt,
    });
    if (!credits.some((credit) => credit.localDate === log.date)) {
      credits.push({
        localDate: log.date,
        timezone: 'Legacy/Unknown',
        firstSessionId: log.id,
        earnedAt: log.createdAt,
      });
    }
  }
  legacy.logs.forEach((log) => imported.add(log.id));

  const legacyPlanId = 'legacy-plan-v1:development-demonstrator';
  const plans = [...state.domain.plans];
  if (!plans.some((plan) => plan.id === legacyPlanId)) {
    plans.push({
      id: legacyPlanId,
      name: 'Imported Knufl plan',
      status: 'active',
      weeklyTarget: legacy.plan.weeklyTarget,
      scheduleDays: [...legacy.plan.days],
      defaultActivityKey: legacy.plan.activity,
      activityDetail: legacy.plan.activityDetail,
      nextSessionLocalDate: legacy.plan.nextSessionDate,
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  const memoriesById = new Map(state.legacyMemories.map((memory) => [memory.id, memory]));
  for (const memory of legacy.memories) {
    if (!memoriesById.has(memory.id)) memoriesById.set(memory.id, memory);
  }

  return {
    ...state,
    companionName: legacy.profile.name,
    domain: { ...state.domain, plans, sessions, exercises, exerciseDayCredits: credits },
    legacyMemories: [...memoriesById.values()],
    legacyMilestoneIds: [...new Set([...state.legacyMilestoneIds, ...legacy.unlockedMoves])],
    importedSourceIds: [...imported],
  };
};

const contextData = (state: DemoState): Record<string, unknown> => {
  const activeSession = state.domain.sessions.find((session) => session.id === state.currentSessionId && session.status === 'active');
  const exercise = state.domain.exercises.find((item) => item.id === state.currentExerciseId);
  const sets = state.domain.completedSets.filter((set) => set.sessionId === activeSession?.id && !set.deletedAt);
  const timer = [...state.domain.restTimers].reverse().find((item) => item.sessionId === activeSession?.id && item.status === 'running');
  return {
    companionName: state.companionName,
    activeSession,
    exercise,
    sets,
    completedSets: sets,
    restTimer: timer ? { ...timer, remainingSeconds: remainingRestSeconds(timer, nowIso()) } : undefined,
    latestRestTimer: timer ? { ...timer, remainingSeconds: remainingRestSeconds(timer, nowIso()) } : undefined,
    recentSessions: [...state.domain.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    plans: state.domain.plans,
    planExercises: state.domain.planExercises,
    occurrences: state.domain.occurrences,
    cardioRecords: state.domain.cardioRecords,
    exerciseDayCredits: state.domain.exerciseDayCredits.length,
    credits: state.domain.exerciseDayCredits,
    memories: state.legacyMemories,
    milestones: [...new Set([
      ...state.legacyMilestoneIds,
      ...state.domain.milestoneUnlocks.map((item) => item.milestoneId),
    ])],
  };
};

const ensureAuxiliaryOperation = (state: DemoState, operationId: string): boolean => {
  if (state.auxiliaryOperationIds.includes(operationId)) return false;
  state.auxiliaryOperationIds.push(operationId);
  return true;
};

export function runDemoTool(current: DemoState, request: ToolRequest): { state: DemoState; result: ToolResult } {
  let state: DemoState = structuredClone(current);
  const at = nowIso();
  const args = request.arguments;

  switch (request.name) {
    case 'get_session_context':
      return { state, result: { ok: true, tool: request.name, message: 'Current saved context loaded.', data: contextData(state) } };

    case 'draft_workout': {
      const proposedExercise = firstObject(args.exercises);
      const displayName = cleanString(proposedExercise?.name) || cleanString(args.exercise) || cleanString(args.displayName) || 'Strength exercise';
      const exerciseKey = cleanString(proposedExercise?.exerciseKey) || cleanString(args.exerciseKey) || displayName.toLocaleLowerCase();
      const plannedSets = positiveInteger(proposedExercise?.sets ?? args.sets);
      const plannedReps = positiveInteger(proposedExercise?.reps ?? args.reps);
      const plannedLoad = nonNegativeNumber(proposedExercise?.load ?? args.load);
      const proposedLoadUnit = proposedExercise?.loadUnit ?? args.loadUnit;
      const proposedLoadMode = proposedExercise?.loadMode ?? args.loadMode;
      const proposedRestSeconds = positiveInteger(proposedExercise?.restSeconds ?? args.restSeconds);
      const planId = newId();
      const result = draftWorkout(state.domain, {
        operationKey: request.operationId,
        planId,
        name: cleanString(args.title) || cleanString(args.name) || `${displayName} session`,
        exercises: [{
          id: newId(),
          exerciseKey,
          displayName,
          targetSets: plannedSets,
          targetReps: plannedReps,
          targetLoad: plannedLoad,
          loadUnit: proposedLoadUnit === 'lb' ? 'lb' : 'kg',
          loadMode: proposedLoadMode === 'per-dumbbell' ? 'per-dumbbell' : 'total',
          restSeconds: proposedRestSeconds,
        }],
        now: at,
      });
      const savedPlanId = result.value.id;
      state = { ...state, domain: result.state, currentPlanId: savedPlanId };
      return {
        state,
        result: {
          ok: true, tool: request.name, duplicate: result.duplicate, panel: 'plan',
          message: `${displayName}: ${plannedSets ?? 'set count open'} × ${plannedReps ?? 'reps open'}${plannedLoad !== undefined ? ` at ${plannedLoad} ${proposedLoadUnit ?? 'kg'}` : ''}. Planned, not logged as completed.`,
          data: { plan: result.value, exercises: result.state.planExercises.filter((item) => item.planId === savedPlanId) },
        },
      };
    }

    case 'start_workout': {
      const planId = cleanString(args.planId) || state.currentPlanId;
      const result = startWorkout(state.domain, {
        operationKey: request.operationId,
        sessionId: newId(),
        planId,
        source: planId ? 'planned' : 'manual',
        localDate: cleanString(args.localDate) || localDate(),
        timezone: cleanString(args.timezone) || timezone(),
        startedAt: at,
      });
      const exercise = result.state.exercises.find((item) => item.sessionId === result.value.id);
      state = { ...state, domain: result.state, currentSessionId: result.value.id, currentExerciseId: exercise?.id };
      return { state, result: { ok: true, tool: request.name, duplicate: result.duplicate, message: 'Workout started. Ready when you are.', data: contextData(state) } };
    }

    case 'record_set': {
      const requestedSessionId = cleanString(args.sessionId) || state.currentSessionId;
      const requestedExerciseId = cleanString(args.exerciseInstanceId) || state.currentExerciseId;
      const session = state.domain.sessions.find((item) => item.id === requestedSessionId && item.status === 'active');
      const exercise = state.domain.exercises.find((item) => item.id === requestedExerciseId);
      if (!session || !exercise) throw new Error('Start a workout before recording a set.');
      const reps = positiveInteger(args.reps);
      if (!reps) throw new Error('Tell me the completed rep count before I save it.');
      const result = recordSet(state.domain, {
        operationKey: request.operationId,
        setId: newId(),
        sessionId: session.id,
        exerciseInstanceId: exercise.id,
        reps,
        load: nonNegativeNumber(args.load) ?? exercise.plannedLoad,
        loadUnit: args.loadUnit === 'lb' ? 'lb' : exercise.plannedLoadUnit,
        loadMode: args.loadMode === 'per-dumbbell' ? 'per-dumbbell' : exercise.plannedLoadMode,
        completedAt: at,
      });
      state = { ...state, domain: result.state };
      const set = result.value;
      return {
        state,
        result: {
          ok: true, tool: request.name, duplicate: result.duplicate, panel: 'set',
          message: `${set.reps}${set.load !== undefined ? ` at ${set.load} ${set.loadUnit}` : ' reps'}, saved.`,
          data: { set, undoAvailable: true },
        },
      };
    }

    case 'correct_set': {
      const latest = [...state.domain.completedSets].reverse().find((set) => set.sessionId === state.currentSessionId && !set.deletedAt);
      if (!latest) throw new Error('There is no completed set to correct.');
      const changes: Record<string, unknown> = {};
      const reps = positiveInteger(args.reps);
      const load = nonNegativeNumber(args.load);
      if (reps) changes.reps = reps;
      if (load !== undefined) changes.load = load;
      if (args.loadUnit === 'kg' || args.loadUnit === 'lb') changes.loadUnit = args.loadUnit;
      if (!Object.keys(changes).length) throw new Error('Tell me which reps or load to correct.');
      const result = correctSet(state.domain, {
        operationKey: request.operationId,
        setId: cleanString(args.setId) || latest.id,
        expectedVersion: positiveInteger(args.expectedVersion) || latest.version,
        changes,
        correctedAt: at,
      });
      state = { ...state, domain: result.state };
      return {
        state,
        result: {
          ok: true, tool: request.name, duplicate: result.duplicate, panel: 'set',
          message: `${result.value.reps}${result.value.load !== undefined ? ` at ${result.value.load} ${result.value.loadUnit}` : ' reps'}. Fixed.`,
          data: { set: result.value },
        },
      };
    }

    case 'undo_last_action': {
      if (!state.currentSessionId) throw new Error('There is no active workout action to undo.');
      const result = undoLastAction(state.domain, { operationKey: request.operationId, sessionId: state.currentSessionId, at });
      state = { ...state, domain: result.state };
      return { state, result: { ok: true, tool: request.name, duplicate: result.duplicate, panel: null, message: result.value.undoneOperationKey ? 'Last set change undone.' : 'There was nothing to undo.', data: { set: result.value.set } } };
    }

    case 'start_rest_timer': {
      if (!state.currentSessionId) throw new Error('Start a workout before timing a rest.');
      const seconds = positiveInteger(args.durationSeconds ?? args.seconds);
      if (!seconds || seconds > 3_600) throw new Error('Rest must be between 1 and 3,600 seconds.');
      const auxiliaryKey = `${request.name}:${request.operationId}`;
      const timerId = `${request.operationId}:rest`;
      const fresh = ensureAuxiliaryOperation(state, auxiliaryKey);
      if (fresh) {
        state.domain.restTimers = state.domain.restTimers.map((timer) => timer.status === 'running'
          ? { ...timer, status: 'cancelled' as const, stoppedAt: at, updatedAt: at, version: timer.version + 1 }
          : timer);
        const timer: RestTimer = {
          id: timerId, sessionId: state.currentSessionId, exerciseInstanceId: state.currentExerciseId,
          status: 'running', startedAt: at,
          endsAt: new Date(Date.parse(at) + seconds * 1_000).toISOString(),
          version: 1, createdAt: at, updatedAt: at,
        };
        state.domain.restTimers.push(timer);
      }
      const timer = state.domain.restTimers.find((item) => item.id === timerId);
      return { state, result: { ok: true, tool: request.name, duplicate: !fresh, panel: 'rest', message: `${seconds} seconds to regroup.`, data: { timer, remainingSeconds: timer ? remainingRestSeconds(timer, at) : 0 } } };
    }

    case 'get_rest_status': {
      let timer = [...state.domain.restTimers].reverse().find((item) => item.status === 'running');
      const remaining = timer ? remainingRestSeconds(timer, at) : 0;
      if (timer && remaining === 0) {
        const timerId = timer.id;
        state.domain.restTimers = state.domain.restTimers.map((item) => item.id === timerId
          ? { ...item, status: 'finished' as const, stoppedAt: item.endsAt, updatedAt: at, version: item.version + 1 }
          : item);
        timer = state.domain.restTimers.find((item) => item.id === timerId);
      }
      const message = timer
        ? remaining > 0 ? `${remaining} seconds left.` : 'Rest complete. Ready when you are.'
        : 'No rest timer is running.';
      return { state, result: { ok: true, tool: request.name, panel: 'rest', message, data: { timer, remainingSeconds: remaining } } };
    }

    case 'finish_workout': {
      const session = state.domain.sessions.find((item) => item.id === state.currentSessionId);
      if (!session) throw new Error('There is no active workout to finish.');
      const beforeCredits = state.domain.exerciseDayCredits.length;
      const result = finishWorkout(state.domain, { operationKey: request.operationId, sessionId: session.id, expectedVersion: session.version, completedAt: at });
      state = { ...state, domain: result.state, currentSessionId: undefined, currentExerciseId: undefined };
      const earned = result.state.exerciseDayCredits.length > beforeCredits;
      return { state, result: { ok: true, tool: request.name, duplicate: result.duplicate, message: earned ? 'Workout saved. One exercise-day credit earned.' : 'Workout saved. Today’s exercise-day credit was already earned.', data: { session: result.value, exerciseDayCredits: result.state.exerciseDayCredits.length, earnedCredit: earned } } };
    }

    case 'record_cardio': {
      const distance = nonNegativeNumber(args.distance);
      const durationSeconds = positiveInteger(args.durationSeconds);
      if (!distance || !durationSeconds) throw new Error('Cardio needs a distance and completed duration.');
      const auxiliaryKey = `${request.name}:${request.operationId}`;
      const recordId = `${request.operationId}:cardio`;
      const standaloneSessionId = `${request.operationId}:session`;
      const fresh = ensureAuxiliaryOperation(state, auxiliaryKey);
      let standaloneSession = false;
      if (fresh) {
        let sessionId = state.currentSessionId;
        const frozenSession = state.domain.sessions.find((item) => item.id === sessionId);
        const cardioLocalDate = frozenSession?.localDate || cleanString(args.localDate) || localDate();
        const cardioTimezone = frozenSession?.timezone || cleanString(args.timezone) || timezone();
        if (!sessionId) {
          standaloneSession = true;
          const started = startWorkout(state.domain, {
            operationKey: `${request.operationId}:session`, sessionId: standaloneSessionId, source: 'manual',
            localDate: cardioLocalDate, timezone: cardioTimezone, startedAt: at,
          });
          state.domain = started.state;
          sessionId = started.value.id;
          state.currentSessionId = sessionId;
        }
        const record: CardioRecord = {
          id: recordId, sessionId,
          activityKey: cleanString(args.activity) || cleanString(args.activityKey) || 'running',
          displayName: cleanString(args.activity) || cleanString(args.displayName) || 'Running',
          distance, distanceUnit: args.distanceUnit === 'mi' ? 'mi' : args.distanceUnit === 'm' ? 'm' : 'km',
          durationSeconds, completedAt: cleanString(args.completedAt) || at,
          localDate: cardioLocalDate, timezone: cardioTimezone,
          feeling: cleanString(args.feeling),
          syncState: 'synced', version: 1, createdAt: at, updatedAt: at,
        };
        state.domain.cardioRecords.push(record);
        if (standaloneSession) {
          const session = state.domain.sessions.find((item) => item.id === sessionId);
          if (!session) throw new Error('The cardio session could not be completed.');
          const finished = finishWorkout(state.domain, {
            operationKey: `${request.operationId}:finish`,
            sessionId,
            expectedVersion: session.version,
            completedAt: at,
          });
          state.domain = finished.state;
          state.currentSessionId = undefined;
        }
      }
      const savedRecord = state.domain.cardioRecords.find((item) => item.id === recordId);
      return { state, result: { ok: true, tool: request.name, duplicate: !fresh, message: 'Cardio result saved.', data: { record: savedRecord, standaloneSession: standaloneSession || savedRecord?.sessionId === standaloneSessionId } } };
    }

    case 'get_progress': {
      const kind = cleanString(args.kind) || 'strength';
      let progress: unknown;
      if (kind === 'cardio') {
        const requestedDistance = nonNegativeNumber(args.distance);
        const requestedUnit = args.distanceUnit === 'mi' ? 'mi' : args.distanceUnit === 'm' ? 'm' : args.distanceUnit === 'km' ? 'km' : undefined;
        progress = getCardioProgress(
          state.domain,
          cleanString(args.activity) || cleanString(args.activityKey) || 'running',
          requestedDistance && requestedUnit ? { distance: requestedDistance, unit: requestedUnit } : undefined,
        );
      } else if (kind === 'completion') {
        const today = localDate();
        const fromDate = cleanString(args.fromDate) || `${today.slice(0, 8)}01`;
        const toDate = cleanString(args.toDate) || today;
        const completion = getCompletionRate(state.domain.occurrences, fromDate, toDate, today);
        progress = {
          ...completion,
          points: [],
          summary: completion.eligible
            ? `${completion.completed} of ${completion.eligible} eligible scheduled workouts were completed from ${fromDate} to ${toDate} (${Math.round((completion.rate ?? 0) * 100)}%).`
            : `No eligible scheduled workouts are saved from ${fromDate} to ${toDate}, so there is no completion-rate denominator.`,
        };
      } else {
        const exercise = state.domain.exercises.find((item) => item.id === state.currentExerciseId);
        progress = getStrengthProgress(state.domain, cleanString(args.exercise) || cleanString(args.exerciseKey) || exercise?.exerciseKey || 'bench press');
      }
      const summary = typeof progress === 'object' && progress && 'summary' in progress
        ? String((progress as { summary: unknown }).summary)
        : 'There is no eligible scheduled-workout denominator in that window.';
      return { state, result: { ok: true, tool: request.name, panel: 'progress', message: summary, data: { progress } } };
    }

    case 'show_panel':
      return { state, result: { ok: true, tool: request.name, panel: ({ set_receipt: 'set', rest_timer: 'rest', progress: 'progress', clarification: 'clarification' } as const)[cleanString(args.panel) as 'set_receipt' | 'rest_timer' | 'progress' | 'clarification'] || 'history', message: 'Panel opened.' } };
    case 'close_panel':
      return { state, result: { ok: true, tool: request.name, panel: null, message: 'Panel closed.' } };
  }
}
