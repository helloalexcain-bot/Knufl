import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretManualCommand } from './manual-command.ts';

test('manual fallback keeps a described workout planned rather than completed', () => {
  const result = interpretManualCommand('Bench today, three sets of eight at sixty kilos, ninety seconds rest.');
  assert.equal(result.status, 'actions');
  if (result.status !== 'actions') return;
  assert.deepEqual(result.actions, [{
    name: 'draft_workout',
    arguments: {
      title: 'Bench Press session',
      exercises: [{
        name: 'Bench Press', sets: 3, reps: 8, load: 60,
        loadUnit: 'kg', loadMode: 'total', restSeconds: 90,
      }],
    },
  }]);
});

test('manual fallback distinguishes a completed set and both correction forms', () => {
  assert.deepEqual(interpretManualCommand('First set done, eight reps.'), {
    status: 'actions', actions: [{ name: 'record_set', arguments: { reps: 8 } }],
  });
  assert.deepEqual(interpretManualCommand('Actually that was six.'), {
    status: 'actions', actions: [{ name: 'correct_set', arguments: { reps: 6 } }],
  });
  assert.deepEqual(interpretManualCommand('Make that sixteen, not sixty.'), {
    status: 'actions', actions: [{ name: 'correct_set', arguments: { load: 16 } }],
  });
});

test('manual fallback creates deterministic timer and grounded progress intents', () => {
  assert.deepEqual(interpretManualCommand('Start a ninety seconds rest'), {
    status: 'actions', actions: [{ name: 'start_rest_timer', arguments: { durationSeconds: 90 } }],
  });
  assert.deepEqual(interpretManualCommand('How long left?'), {
    status: 'actions', actions: [{ name: 'get_rest_status', arguments: {} }],
  });
  assert.deepEqual(interpretManualCommand('Show my bench progress.'), {
    status: 'actions', actions: [{ name: 'get_progress', arguments: { kind: 'strength', exercise: 'Bench Press' } }],
  });
});
