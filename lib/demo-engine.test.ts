import test from 'node:test';
import assert from 'node:assert/strict';
import {
  importLegacyFile,
  exportDemoState,
  loadDemoState,
  previewLegacyFile,
  runDemoTool,
} from './demo-engine.ts';

const tool = (
  state: ReturnType<typeof loadDemoState>,
  name: Parameters<typeof runDemoTool>[1]['name'],
  args: Record<string, unknown>,
  operationId: string,
) => runDemoTool(state, { name, arguments: args, operationId });

test('development demonstrator retries a draft without losing its saved plan identity', () => {
  const initial = loadDemoState();
  const request = {
    title: 'Bench day',
    exercises: [{ name: 'Bench press', sets: 3, reps: 8, load: 60, loadUnit: 'kg', restSeconds: 90 }],
  };
  const first = tool(initial, 'draft_workout', request, 'manual:draft-stable');
  const retried = tool(first.state, 'draft_workout', request, 'manual:draft-stable');

  assert.equal(first.state.domain.plans.length, 1);
  assert.equal(retried.state.domain.plans.length, 1);
  assert.equal(retried.result.duplicate, true);
  assert.equal(retried.state.currentPlanId, first.state.domain.plans[0]?.id);
  assert.equal(retried.result.data?.exercises instanceof Array, true);
  assert.equal((retried.result.data?.exercises as unknown[]).length, 1);
});

test('development demonstrator exports restore exactly and repeat without duplication', () => {
  let state = loadDemoState();
  state = tool(state, 'draft_workout', {
    title: 'Walking day', exercises: [{ name: 'Walking' }],
  }, 'manual:demo-export-draft').state;
  state.companionName = 'Moss';
  const archive = exportDemoState(state);
  const portableState = (JSON.parse(archive) as { data: typeof state }).data;
  const restored = importLegacyFile(archive, loadDemoState());
  assert.deepEqual(restored, portableState);
  assert.deepEqual(importLegacyFile(archive, restored), restored);
  assert.equal(previewLegacyFile(archive, restored).duplicateSessions, state.domain.sessions.length);
});

test('legacy demonstrator import preserves plan, activity, duration, IDs and unknown timezone', () => {
  const initial = loadDemoState();
  const legacy = JSON.stringify({
    version: 1,
    onboarded: true,
    profile: { name: 'Moss', gender: 'legacy', pronouns: 'legacy' },
    plan: { weeklyTarget: 3, days: ['Mon'], activity: 'Walking', activityDetail: 'Park loop' },
    logs: [{
      id: 'legacy-session', submissionKey: 'legacy-key', date: '2026-09-01', activity: 'Walking',
      duration: 25, feeling: 'Steady', source: 'completed', createdAt: '2026-09-01T08:00:00.000Z',
    }],
    memories: [{
      id: 'legacy-memory', associatedSessionId: 'legacy-session', title: 'First walk',
      note: 'One wonderfully wobbly beginning.', createdAt: '2026-09-01T08:00:00.000Z',
    }],
    unlockedMoves: ['first-session'], restDates: [], lastOpened: '', dialogueCursor: 0,
  });

  assert.equal(previewLegacyFile(legacy, initial).conflicts, 0);
  const imported = importLegacyFile(legacy, initial);
  assert.equal(imported.companionName, 'Moss');
  assert.equal(imported.domain.sessions[0]?.id, 'legacy-session');
  assert.equal(imported.domain.sessions[0]?.durationSeconds, 1500);
  assert.equal(imported.domain.sessions[0]?.timezone, 'Legacy/Unknown');
  assert.equal(imported.domain.exercises[0]?.displayName, 'Walking');
  assert.equal(imported.domain.plans[0]?.weeklyTarget, 3);
  assert.equal(imported.legacyMemories[0]?.associatedSessionId, 'legacy-session');

  const repeated = importLegacyFile(legacy, imported);
  assert.equal(repeated.domain.sessions.length, 1);
  assert.equal(repeated.legacyMemories.length, 1);
});

test('cardio uses an active session frozen date/timezone and filters progress by actual distance', () => {
  let state = loadDemoState();
  const draft = tool(state, 'draft_workout', {
    title: 'Run day', exercises: [{ name: 'Running' }],
  }, 'manual:draft-run');
  state = draft.state;
  const started = tool(state, 'start_workout', {
    localDate: '2026-09-04', timezone: 'Europe/London',
  }, 'manual:start-run');
  state = started.state;
  const first = tool(state, 'record_cardio', {
    activity: 'Running', distance: 5, distanceUnit: 'km', durationSeconds: 1500,
    localDate: '2026-09-05', timezone: 'Asia/Tokyo', feeling: 'Steady',
  }, 'manual:cardio-5k');
  state = first.state;
  const second = tool(state, 'record_cardio', {
    activity: 'Running', distance: 10, distanceUnit: 'km', durationSeconds: 3300,
  }, 'manual:cardio-10k');
  state = second.state;

  assert.equal(state.domain.cardioRecords[0]?.localDate, '2026-09-04');
  assert.equal(state.domain.cardioRecords[0]?.timezone, 'Europe/London');
  assert.equal(state.domain.cardioRecords[0]?.feeling, 'Steady');
  const progress = tool(state, 'get_progress', {
    kind: 'cardio', activity: 'Running', distance: 5, distanceUnit: 'km',
  }, 'read:run-progress');
  const value = progress.result.data?.progress as { status: string; points: unknown[] };
  assert.equal(value.status, 'ready');
  assert.equal(value.points.length, 1);
  assert.match(progress.result.message, /5 km/i);
  assert.doesNotMatch(progress.result.message, /3300/);
});

test('expired demonstrator rest timers become finished and context includes completed history', () => {
  const state = loadDemoState();
  state.currentSessionId = 'session-active';
  state.domain.sessions.push({
    id: 'session-active', source: 'manual', status: 'active', localDate: '2026-09-05',
    timezone: 'Europe/London', startedAt: '2026-09-05T08:00:00.000Z', version: 1,
    createdAt: '2026-09-05T08:00:00.000Z', updatedAt: '2026-09-05T08:00:00.000Z',
  });
  state.domain.restTimers.push({
    id: 'rest-expired', sessionId: 'session-active', status: 'running',
    startedAt: '2026-09-05T08:00:00.000Z', endsAt: '2026-09-05T08:01:00.000Z',
    version: 1, createdAt: '2026-09-05T08:00:00.000Z', updatedAt: '2026-09-05T08:00:00.000Z',
  });

  const status = tool(state, 'get_rest_status', {}, 'read:rest-expired');
  assert.equal(status.state.domain.restTimers[0]?.status, 'finished');
  assert.match(status.result.message, /Rest complete/);

  const finished = tool(status.state, 'finish_workout', {}, 'manual:finish-history');
  const context = tool(finished.state, 'get_session_context', {}, 'read:context');
  assert.equal((context.result.data?.recentSessions as unknown[]).length, 1);
  assert.equal((context.result.data?.credits as unknown[]).length, 1);
});
