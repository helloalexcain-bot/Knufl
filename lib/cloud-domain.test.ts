import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DomainConflictError,
  correctSet,
  createWorkoutDomainState,
  draftWorkout,
  finishWorkout,
  getCardioProgress,
  getCompletionRate,
  getStrengthProgress,
  previewLegacyImport,
  recordSet,
  remainingRestSeconds,
  startWorkout,
  undoLastAction,
  type CardioRecord,
  type WorkoutDomainState,
  type WorkoutOccurrence,
} from './cloud-domain.ts';

const T0 = '2026-09-05T08:00:00.000Z';

const plannedBenchState = (): WorkoutDomainState => {
  let state = createWorkoutDomainState('account-a');
  state = draftWorkout(state, {
    operationKey: 'draft-1',
    planId: 'plan-1',
    name: 'Bench day',
    exercises: [{
      id: 'planned-bench',
      exerciseKey: 'bench-press',
      displayName: 'Bench press',
      targetSets: 3,
      targetReps: 8,
      targetLoad: 60,
      loadUnit: 'kg',
      loadMode: 'total',
      restSeconds: 90,
    }],
    now: T0,
  }).state;
  return startWorkout(state, {
    operationKey: 'start-1',
    sessionId: 'session-1',
    planId: 'plan-1',
    source: 'planned',
    localDate: '2026-09-05',
    timezone: 'Europe/London',
    startedAt: T0,
    exerciseIds: ['bench-1'],
  }).state;
};

test('drafting and starting planned work never creates completed sets', () => {
  const state = plannedBenchState();

  assert.equal(state.plans[0]?.status, 'draft');
  assert.equal(state.planExercises[0]?.targetSets, 3);
  assert.equal(state.exercises[0]?.plannedReps, 8);
  assert.equal(state.sessions[0]?.status, 'active');
  assert.equal(state.completedSets.length, 0);
  assert.equal(state.exerciseDayCredits.length, 0);
});

test('weighted plans and actual sets require an explicit load mode', () => {
  assert.throws(() => draftWorkout(createWorkoutDomainState('account-a'), {
    operationKey: 'draft-ambiguous-mode',
    planId: 'plan-ambiguous-mode',
    name: 'Curl day',
    exercises: [{
      id: 'planned-curl',
      exerciseKey: 'dumbbell-curl',
      displayName: 'Dumbbell curl',
      targetSets: 3,
      targetReps: 8,
      targetLoad: 20,
      loadUnit: 'kg',
    }],
    now: T0,
  }), /load mode is required/i);

  assert.throws(() => recordSet(plannedBenchState(), {
    operationKey: 'record-ambiguous-mode',
    setId: 'set-ambiguous-mode',
    sessionId: 'session-1',
    exerciseInstanceId: 'bench-1',
    reps: 8,
    load: 60,
    loadUnit: 'kg',
    completedAt: '2026-09-05T08:10:00.000Z',
  }), /load mode is required/i);
});

test('record, correction, idempotent retry and undo preserve one set identity', () => {
  let state = plannedBenchState();
  const recorded = recordSet(state, {
    operationKey: 'record-1',
    setId: 'set-1',
    sessionId: 'session-1',
    exerciseInstanceId: 'bench-1',
    reps: 8,
    load: 60,
    loadUnit: 'kg',
    loadMode: 'total',
    completedAt: '2026-09-05T08:10:00.000Z',
  });
  state = recorded.state;

  const retried = recordSet(state, {
    operationKey: 'record-1',
    setId: 'a-different-retry-id',
    sessionId: 'session-1',
    exerciseInstanceId: 'bench-1',
    reps: 8,
    load: 60,
    loadUnit: 'kg',
    loadMode: 'total',
    completedAt: '2026-09-05T08:10:02.000Z',
  });
  assert.equal(retried.duplicate, true);
  assert.equal(retried.value.id, 'set-1');
  assert.equal(retried.state.completedSets.length, 1);

  const corrected = correctSet(state, {
    operationKey: 'correct-1',
    setId: 'set-1',
    expectedVersion: 1,
    changes: { reps: 6 },
    correctedAt: '2026-09-05T08:11:00.000Z',
  });
  state = corrected.state;
  assert.equal(corrected.value.id, 'set-1');
  assert.equal(corrected.value.reps, 6);
  assert.equal(corrected.value.version, 2);
  assert.equal(state.completedSets.length, 1);

  assert.throws(() => correctSet(state, {
    operationKey: 'correct-stale',
    setId: 'set-1',
    expectedVersion: 1,
    changes: { load: 16 },
    correctedAt: '2026-09-05T08:12:00.000Z',
  }), (error: unknown) => (
    error instanceof DomainConflictError
    && error.expectedVersion === 1
    && error.actualVersion === 2
  ));

  const undoneCorrection = undoLastAction(state, {
    operationKey: 'undo-1',
    sessionId: 'session-1',
    at: '2026-09-05T08:13:00.000Z',
  });
  state = undoneCorrection.state;
  assert.equal(undoneCorrection.value.set?.id, 'set-1');
  assert.equal(undoneCorrection.value.set?.reps, 8);
  assert.equal(undoneCorrection.value.set?.version, 3);

  const undoneRecord = undoLastAction(state, {
    operationKey: 'undo-2',
    sessionId: 'session-1',
    at: '2026-09-05T08:14:00.000Z',
  });
  assert.equal(undoneRecord.value.set?.id, 'set-1');
  assert.equal(undoneRecord.value.set?.deletedAt, '2026-09-05T08:14:00.000Z');

  const repeatedUndo = undoLastAction(undoneRecord.state, {
    operationKey: 'undo-2',
    sessionId: 'session-1',
    at: '2026-09-05T08:14:05.000Z',
  });
  assert.equal(repeatedUndo.duplicate, true);
  assert.equal(repeatedUndo.state.operations.length, undoneRecord.state.operations.length);
});

test('an operation key cannot be reused for another mutation type', () => {
  const state = plannedBenchState();
  assert.throws(() => recordSet(state, {
    operationKey: 'start-1',
    setId: 'set-1',
    sessionId: 'session-1',
    exerciseInstanceId: 'bench-1',
    reps: 8,
    completedAt: '2026-09-05T08:10:00.000Z',
  }), DomainConflictError);
});

const addEmptySession = (
  state: WorkoutDomainState,
  id: string,
  localDate: string,
  timezone: string,
  at: string,
): WorkoutDomainState => startWorkout(state, {
  operationKey: `start-${id}`,
  sessionId: id,
  source: 'manual',
  localDate,
  timezone,
  startedAt: at,
}).state;

test('exercise-day credits use the frozen local date, have no weekly cap and unlocks never retract', () => {
  let state = createWorkoutDomainState('account-a');
  const sessions = [
    ['london-a', '2026-09-05', 'Europe/London', '2026-09-05T07:00:00.000Z'],
    ['tokyo-same-date', '2026-09-05', 'Asia/Tokyo', '2026-09-05T13:00:00.000Z'],
    ['tokyo-next', '2026-09-06', 'Asia/Tokyo', '2026-09-05T16:00:00.000Z'],
    ['la-date', '2026-09-04', 'America/Los_Angeles', '2026-09-05T18:00:00.000Z'],
  ] as const;

  for (const [index, [id, date, zone, startedAt]] of sessions.entries()) {
    state = addEmptySession(state, id, date, zone, startedAt);
    state = finishWorkout(state, {
      operationKey: `finish-${id}`,
      sessionId: id,
      expectedVersion: 1,
      completedAt: `2026-09-0${5 + Math.min(index, 1)}T20:0${index}:00.000Z`,
    }).state;
  }

  assert.deepEqual(
    state.exerciseDayCredits.map((credit) => credit.localDate).sort(),
    ['2026-09-04', '2026-09-05', '2026-09-06'],
  );
  assert.equal(state.exerciseDayCredits.find((credit) => credit.localDate === '2026-09-05')?.timezone, 'Europe/London');
  assert.deepEqual(
    state.milestoneUnlocks.map((milestone) => milestone.milestoneId).sort(),
    ['first-session', 'little-mountain'],
  );

  const withoutHistory = { ...state, sessions: [], completedSets: [] };
  assert.equal(withoutHistory.exerciseDayCredits.length, 3);
  assert.equal(withoutHistory.milestoneUnlocks.length, 2);
});

test('a second active workout is rejected until the first is finished', () => {
  const state = addEmptySession(
    createWorkoutDomainState('account-a'),
    'session-one',
    '2026-09-05',
    'Europe/London',
    T0,
  );
  assert.throws(() => addEmptySession(
    state,
    'session-two',
    '2026-09-05',
    'Europe/London',
    '2026-09-05T09:00:00.000Z',
  ), /already active/i);
});

test('strength progress reports actuals and refuses mixed load contexts', () => {
  let state = plannedBenchState();
  state = recordSet(state, {
    operationKey: 'set-kg',
    setId: 'set-kg',
    sessionId: 'session-1',
    exerciseInstanceId: 'bench-1',
    reps: 8,
    load: 60,
    loadUnit: 'kg',
    loadMode: 'total',
    completedAt: '2026-09-05T08:10:00.000Z',
  }).state;
  state = recordSet(state, {
    operationKey: 'set-lb',
    setId: 'set-lb',
    sessionId: 'session-1',
    exerciseInstanceId: 'bench-1',
    reps: 5,
    load: 135,
    loadUnit: 'lb',
    loadMode: 'total',
    completedAt: '2026-09-05T08:20:00.000Z',
  }).state;

  const ambiguous = getStrengthProgress(state, 'bench-press');
  assert.equal(ambiguous.status, 'needs-context');
  if (ambiguous.status === 'needs-context') {
    assert.deepEqual(ambiguous.compatibilityGroups, ['kg / total', 'lb / total']);
  }

  const kilograms = getStrengthProgress(state, 'bench-press', 'kg / total');
  assert.equal(kilograms.status, 'ready');
  if (kilograms.status === 'ready') {
    assert.equal(kilograms.points.length, 1);
    assert.match(kilograms.summary, /8 reps at 60 kg total/);
    assert.doesNotMatch(kilograms.summary, /target|planned|improved/i);
  }
});

test('cardio progress asks for a compatible distance rather than comparing unlike runs', () => {
  const state = createWorkoutDomainState('account-a');
  const records: CardioRecord[] = [
    {
      id: 'run-5k', sessionId: 's1', activityKey: 'running', displayName: 'Run',
      distance: 5, distanceUnit: 'km', durationSeconds: 1500,
      completedAt: '2026-08-01T07:00:00.000Z', localDate: '2026-08-01', timezone: 'Europe/London',
      syncState: 'synced', version: 1, createdAt: '2026-08-01T07:00:00.000Z', updatedAt: '2026-08-01T07:00:00.000Z',
    },
    {
      id: 'run-10k', sessionId: 's2', activityKey: 'running', displayName: 'Run',
      distance: 10, distanceUnit: 'km', durationSeconds: 3300,
      completedAt: '2026-08-08T07:00:00.000Z', localDate: '2026-08-08', timezone: 'Europe/London',
      syncState: 'synced', version: 1, createdAt: '2026-08-08T07:00:00.000Z', updatedAt: '2026-08-08T07:00:00.000Z',
    },
    {
      id: 'run-5000m', sessionId: 's3', activityKey: 'running', displayName: 'Run',
      distance: 5000, distanceUnit: 'm', durationSeconds: 1470,
      completedAt: '2026-08-15T07:00:00.000Z', localDate: '2026-08-15', timezone: 'Europe/London',
      syncState: 'synced', version: 1, createdAt: '2026-08-15T07:00:00.000Z', updatedAt: '2026-08-15T07:00:00.000Z',
    },
  ];

  const ambiguous = getCardioProgress({ ...state, cardioRecords: records }, 'running');
  assert.equal(ambiguous.status, 'needs-distance');

  const fiveK = getCardioProgress({ ...state, cardioRecords: records }, 'running', { distance: 5, unit: 'km' });
  assert.equal(fiveK.status, 'ready');
  if (fiveK.status === 'ready') {
    assert.equal(fiveK.points.length, 2);
    assert.match(fiveK.summary, /1500 seconds/);
    assert.match(fiveK.summary, /1470 seconds/);
    assert.doesNotMatch(fiveK.summary, /10 km|3300/);
  }
});

test('completion rate excludes future and cancelled occurrences and exposes an empty denominator', () => {
  const base = { timezone: 'Europe/London', version: 1, createdAt: T0, updatedAt: T0 } as const;
  const occurrences: WorkoutOccurrence[] = [
    { ...base, id: 'done', scheduledLocalDate: '2026-09-01', status: 'completed' },
    { ...base, id: 'missed', scheduledLocalDate: '2026-09-03', status: 'scheduled' },
    { ...base, id: 'cancelled', scheduledLocalDate: '2026-09-04', status: 'cancelled' },
    { ...base, id: 'future', scheduledLocalDate: '2026-09-10', status: 'scheduled' },
  ];
  assert.deepEqual(getCompletionRate(occurrences, '2026-09-01', '2026-09-30', '2026-09-05'), {
    completed: 1,
    eligible: 2,
    rate: 0.5,
    windowStart: '2026-09-01',
    windowEnd: '2026-09-30',
  });
  assert.equal(getCompletionRate([], '2026-09-01', '2026-09-30', '2026-09-05').rate, undefined);
});

test('legacy import preview preserves stable IDs, deduplicates and discards removed identity fields', () => {
  const raw = {
    version: 1,
    profile: { name: 'Atlas', gender: 'Female', pronouns: 'she/her' },
    logs: [
      { id: 'same-session', date: '2026-09-01', createdAt: '2026-09-01T08:00:00.000Z' },
      { id: 'conflicting-session', date: '2026-09-02', createdAt: '2026-09-02T08:00:00.000Z' },
      { id: 'new-session', date: '2026-09-03', createdAt: '2026-09-03T08:00:00.000Z' },
    ],
    memories: [
      { id: 'same-memory', title: 'First', note: 'Still here.', associatedSessionId: 'same-session' },
      { id: 'new-memory', title: 'Second', note: 'Also here.', associatedSessionId: 'new-session' },
    ],
    unlockedMoves: ['first-session', 'little-mountain'],
  };
  const preview = previewLegacyImport(raw, {
    sessions: [
      { id: 'same-session', localDate: '2026-09-01', source: 'legacy', startedAt: '2026-09-01T08:00:00.000Z' },
      { id: 'conflicting-session', localDate: '2026-08-30', source: 'legacy', startedAt: '2026-09-02T08:00:00.000Z' },
    ],
    memories: [{ id: 'same-memory', title: 'First', note: 'Still here.', associatedSessionId: 'same-session' }],
    milestoneIds: ['first-session'],
  });

  assert.deepEqual(preview.sanitizedProfile, { name: 'Atlas' });
  assert.deepEqual(Object.keys(preview.sanitizedProfile), ['name']);
  assert.deepEqual(preview.duplicate.sessionIds, ['same-session']);
  assert.deepEqual(preview.importable.sessionIds, ['new-session']);
  assert.deepEqual(preview.conflicts, [{ kind: 'session', id: 'conflicting-session' }]);
  assert.deepEqual(preview.duplicate.memoryIds, ['same-memory']);
  assert.deepEqual(preview.importable.memoryIds, ['new-memory']);
  assert.deepEqual(preview.duplicate.milestoneIds, ['first-session']);
  assert.deepEqual(preview.importable.milestoneIds, ['little-mountain']);
});

test('rest time is derived from timestamps and survives a delayed refresh', () => {
  const timer = {
    id: 'rest-1',
    sessionId: 'session-1',
    status: 'running' as const,
    startedAt: '2026-09-05T08:00:00.000Z',
    endsAt: '2026-09-05T08:01:30.000Z',
    version: 1,
    createdAt: '2026-09-05T08:00:00.000Z',
    updatedAt: '2026-09-05T08:00:00.000Z',
  };
  assert.equal(remainingRestSeconds(timer, '2026-09-05T08:00:41.100Z'), 49);
  assert.equal(remainingRestSeconds(timer, '2026-09-05T08:02:00.000Z'), 0);
});
