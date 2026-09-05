import test from 'node:test';
import assert from 'node:assert/strict';
import {
  importConflictCount,
  isCloudAccountExport,
  normalizeClientContext,
  panelForTool,
  panelFromContract,
  parseCloudImportResponse,
  parseCloudRestorePreview,
  planFrom,
  targetSetToActiveContext,
} from './client-contract.ts';

test('cloud import parsing counts every non-overwriting conflict shape', () => {
  const preview = {
    profile: { action: 'conflict' },
    plan: { action: 'duplicate' },
    sessions: { conflicts: ['session-a', 'session-b'] },
    memories: { conflicts: ['memory-a'] },
  };

  assert.equal(importConflictCount(preview), 4);
  assert.deepEqual(parseCloudImportResponse({ status: 'conflict', preview }), {
    status: 'conflict',
    conflictCount: 4,
    completed: false,
  });
  assert.equal(importConflictCount({ conflicts: [{ id: 'flat-conflict' }] }), 1);
});

test('cloud import parsing accepts only completed conflict-free statuses', () => {
  assert.deepEqual(parseCloudImportResponse({ status: 'completed', preview: {} }), {
    status: 'completed', conflictCount: 0, completed: true,
  });
  assert.deepEqual(parseCloudImportResponse([{ status: 'already-imported', preview: {} }]), {
    status: 'already-imported', conflictCount: 0, completed: true,
  });
  assert.deepEqual(parseCloudImportResponse({ status: 'already-restored', preview: {} }), {
    status: 'already-restored', conflictCount: 0, completed: true,
  });
  assert.deepEqual(parseCloudImportResponse({ status: 'completed', preview: { plan: { action: 'conflict' } } }), {
    status: 'completed', conflictCount: 1, completed: false,
  });
  assert.deepEqual(parseCloudImportResponse({ status: 'surprising' }), {
    status: 'unknown', conflictCount: 0, completed: false,
  });
});

test('cloud account archives are detected and restore previews expose only bounded counts', () => {
  assert.equal(isCloudAccountExport({ formatVersion: 2, sessions: [] }), true);
  assert.equal(isCloudAccountExport({ schemaVersion: 1 }), false);
  assert.deepEqual(parseCloudRestorePreview({
    valid: true,
    action: 'importable',
    companionName: 'Moss',
    counts: { sessions: 4, memories: 2, milestones: 1, completedSets: 9 },
    conflicts: [],
  }), {
    valid: true,
    action: 'importable',
    companionName: 'Moss',
    sessions: 4,
    memories: 2,
    milestones: 1,
    conflicts: 0,
  });
  assert.deepEqual(parseCloudRestorePreview([{
    preview: {
      valid: true,
      action: 'conflict',
      counts: { sessions: -1, memories: 'many' },
      conflicts: ['account-not-empty-or-different'],
    },
  }]), {
    valid: true,
    action: 'conflict',
    companionName: 'Knufl',
    sessions: 0,
    memories: 0,
    milestones: 0,
    conflicts: 1,
  });
});

test('context normalization accepts cloud and demonstrator naming without inventing records', () => {
  const cloud = normalizeClientContext({
    session: { id: 'session-cloud', status: 'active' },
    exercises: [{ id: 'exercise-cloud', display_name: 'Bench Press' }],
    completedSets: [{ id: 'set-cloud', reps: 8 }],
    latestRestTimer: { id: 'rest-cloud', ends_at: '2026-09-05T12:01:30.000Z' },
  });
  assert.equal(cloud.activeSession?.id, 'session-cloud');
  assert.equal(cloud.exercises[0]?.id, 'exercise-cloud');
  assert.equal(cloud.completedSets[0]?.id, 'set-cloud');
  assert.equal(cloud.latestRestTimer?.id, 'rest-cloud');

  const demonstrator = normalizeClientContext({
    context: {
      activeSession: { id: 'session-demo' },
      exercise: { id: 'exercise-demo' },
      sets: [{ id: 'set-demo' }],
      restTimer: { id: 'rest-demo' },
    },
  });
  assert.equal(demonstrator.activeSession?.id, 'session-demo');
  assert.deepEqual(demonstrator.exercises.map((item) => item.id), ['exercise-demo']);
  assert.deepEqual(demonstrator.completedSets.map((item) => item.id), ['set-demo']);
  assert.equal(demonstrator.latestRestTimer?.id, 'rest-demo');

  assert.deepEqual(normalizeClientContext({ malformed: true }), {
    activeSession: undefined,
    exercises: [],
    completedSets: [],
    latestRestTimer: undefined,
    plan: undefined,
  });
});

test('plan normalization supports imported snake-case and client camel-case rows', () => {
  assert.deepEqual(planFrom({
    workout_plans: [{
      id: 'legacy-plan-v1:user',
      weekly_target: 3,
      schedule_days: ['Mon', 'Thu'],
      default_activity_key: 'Strength',
      activity_detail: 'Bench focus',
      next_session_local_date: '2026-09-08',
    }],
  }), {
    raw: {
      id: 'legacy-plan-v1:user',
      weekly_target: 3,
      schedule_days: ['Mon', 'Thu'],
      default_activity_key: 'Strength',
      activity_detail: 'Bench focus',
      next_session_local_date: '2026-09-08',
    },
    id: 'legacy-plan-v1:user',
    title: undefined,
    weeklyTarget: 3,
    scheduleDays: ['Mon', 'Thu'],
    activity: 'Strength',
    activityDetail: 'Bench focus',
    nextSessionDate: '2026-09-08',
    exercises: [],
  });

  const camel = planFrom({ active: { activePlan: {
    id: 'plan-client', title: 'Saturday strength', weeklyTarget: 1,
    scheduleDays: ['Sat'], activity: 'Strength', exercises: [{ name: 'Squat' }],
  } } });
  assert.equal(camel?.title, 'Saturday strength');
  assert.equal(camel?.exercises[0]?.name, 'Squat');

  const recovered = planFrom({
    plans: [
      { id: 'archived-plan', status: 'archived', name: 'Old plan' },
      { id: 'active-plan', status: 'active', name: 'Current plan' },
    ],
    planExercises: [
      { id: 'unrelated', plan_id: 'archived-plan', display_name: 'Old movement' },
      { id: 'current-exercise', plan_id: 'active-plan', display_name: 'Bench press' },
    ],
  });
  assert.equal(recovered?.id, 'active-plan');
  assert.deepEqual(recovered?.exercises.map((item) => item.id), ['current-exercise']);
});

test('panel mapping follows the typed tool and client-directive contracts', () => {
  assert.equal(panelForTool('record_set'), 'set');
  assert.equal(panelForTool('correct_set'), 'set');
  assert.equal(panelForTool('undo_last_action'), null);
  assert.equal(panelForTool('start_rest_timer'), 'rest');
  assert.equal(panelForTool('get_progress'), 'progress');
  assert.equal(panelForTool('draft_workout'), 'plan');
  assert.equal(panelForTool('get_session_context'), null);

  assert.equal(panelFromContract('set_receipt'), 'set');
  assert.equal(panelFromContract('rest_timer'), 'rest');
  assert.equal(panelFromContract('progress'), 'progress');
  assert.equal(panelFromContract('clarification'), 'clarification');
  assert.equal(panelFromContract('unknown-panel'), null);
  assert.equal(panelFromContract({ panel: 'progress' }), null);
});

test('a first set is retargeted to the workout that was just started', () => {
  assert.deepEqual(targetSetToActiveContext({
    sessionId: 'model-placeholder-session',
    exerciseInstanceId: 'model-placeholder-exercise',
    exercise: 'bench',
    reps: 8,
    load: 60,
  }, {
    activeSession: { id: 'actual-session' },
    exercises: [
      { id: 'actual-squat', displayName: 'Back squat' },
      { id: 'actual-exercise', displayName: 'Bench press' },
    ],
  }), {
    sessionId: 'actual-session',
    exerciseInstanceId: 'actual-exercise',
    reps: 8,
    load: 60,
  });

  assert.equal(targetSetToActiveContext({ reps: 8 }, { activeSession: { id: 'session-only' } }), undefined);
  assert.equal(targetSetToActiveContext({ reps: 8 }, {
    activeSession: { id: 'ambiguous-session' },
    exercises: [
      { id: 'squat', displayName: 'Back squat' },
      { id: 'bench', displayName: 'Bench press' },
    ],
  }), undefined);
});
