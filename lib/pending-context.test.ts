import test from 'node:test';
import assert from 'node:assert/strict';
import { activeSessionFrom, exercisesFrom, restTimerFrom, setsFrom } from './client-contract.ts';
import { projectPendingToolOperation } from './pending-context.ts';

test('dependent offline workout operations reuse the pending deterministic session', async () => {
  const accountId = 'account-a';
  const startOperation = 'manual:start';
  let context = await projectPendingToolOperation(accountId, {}, 'start_workout', {
    title: 'Bench day',
    localDate: '2026-09-05',
    timezone: 'Europe/London',
    exercises: [{ name: 'Bench press', sets: 3, reps: 8, load: 60, loadUnit: 'kg', restSeconds: 90 }],
  }, startOperation);

  const sessionId = String(activeSessionFrom(context)?.id);
  const exerciseId = String(exercisesFrom(context)[0]?.id);
  assert.notEqual(sessionId, 'undefined');
  assert.notEqual(exerciseId, 'undefined');

  context = await projectPendingToolOperation(accountId, context, 'record_set', {
    sessionId,
    exerciseInstanceId: exerciseId,
    reps: 8,
    load: 60,
    loadUnit: 'kg',
    completedAt: '2026-09-05T09:00:00.000Z',
  }, 'manual:set-1');
  assert.equal(activeSessionFrom(context)?.id, sessionId);
  assert.equal(setsFrom(context)[0]?.exercise_instance_id, exerciseId);
  assert.equal(setsFrom(context)[0]?.pending, true);

  const setId = String(setsFrom(context)[0]?.id);
  context = await projectPendingToolOperation(accountId, context, 'correct_set', {
    setId,
    expectedVersion: 1,
    reps: 6,
  }, 'manual:correct-1');
  assert.equal(setsFrom(context)[0]?.reps, 6);
  assert.equal(setsFrom(context)[0]?.version, 2);

  context = await projectPendingToolOperation(accountId, context, 'start_rest_timer', {
    sessionId,
    durationSeconds: 90,
    startedAt: '2026-09-05T09:01:00.000Z',
  }, 'manual:rest-1');
  assert.equal(restTimerFrom(context)?.endsAt, '2026-09-05T09:02:30.000Z');

  context = await projectPendingToolOperation(accountId, context, 'finish_workout', {
    sessionId,
    expectedVersion: 1,
  }, 'manual:finish-1');
  assert.equal(activeSessionFrom(context), undefined);
  assert.deepEqual(setsFrom(context), []);
});
