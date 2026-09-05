import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHARACTER_STATES,
  CharacterController,
  createInitialCharacterSnapshot,
  reduceCharacterController,
} from './character-controller.ts';

test('all required states produce deterministic state-entry gestures', () => {
  const run = () => {
    let snapshot = createInitialCharacterSnapshot({ at: 100 });
    return CHARACTER_STATES.map((state, index) => {
      snapshot = reduceCharacterController(snapshot, {
        type: 'state.changed',
        state,
        at: 200 + index,
      });
      return snapshot.gesture?.name;
    });
  };

  assert.deepEqual(run(), run());
  assert.deepEqual(run(), [
    'idle-breathe',
    'greeting-wave',
    'listening-head-tilt',
    'thinking-paw-to-chin',
    'speaking-conversational-paw',
    'ready-paw-tap',
    'resting-breathe',
    'celebrating-paw-tap',
    'comforting-paw-to-heart',
    'farewell-wave',
  ]);
});

test('renderer inputs are clamped and speech inputs only move a speaking character', () => {
  let snapshot = createInitialCharacterSnapshot({ at: 0 });
  snapshot = reduceCharacterController(snapshot, {
    type: 'gaze.changed',
    horizontal: 4,
    vertical: -3,
    at: 1,
  });
  snapshot = reduceCharacterController(snapshot, { type: 'energy.changed', value: 2, at: 2 });
  snapshot = reduceCharacterController(snapshot, {
    type: 'speech.amplitude',
    value: 0.8,
    at: 3,
  });

  assert.deepEqual(snapshot.gaze, { horizontal: 1, vertical: -1 });
  assert.equal(snapshot.energy, 1);
  assert.equal(snapshot.speechAmplitude, 0);

  snapshot = reduceCharacterController(snapshot, {
    type: 'state.changed',
    state: 'speaking',
    at: 4,
  });
  snapshot = reduceCharacterController(snapshot, {
    type: 'speech.amplitude',
    value: 3,
    at: 5,
  });
  snapshot = reduceCharacterController(snapshot, {
    type: 'speech.visemes',
    weights: { aa: 1.4, PP: -0.4 },
    at: 6,
  });

  assert.equal(snapshot.speechAmplitude, 1);
  assert.deepEqual(snapshot.visemes, { aa: 1, PP: 0 });
});

test('interruption immediately settles playback and hands control back to listening', () => {
  let snapshot = createInitialCharacterSnapshot({ at: 0 });
  snapshot = reduceCharacterController(snapshot, {
    type: 'state.changed',
    state: 'speaking',
    at: 10,
  });
  snapshot = reduceCharacterController(snapshot, {
    type: 'speech.amplitude',
    value: 0.7,
    at: 11,
  });
  snapshot = reduceCharacterController(snapshot, {
    type: 'speech.visemes',
    weights: { oh: 0.9 },
    at: 12,
  });
  snapshot = reduceCharacterController(snapshot, {
    type: 'conversation.interrupted',
    at: 13,
  });

  assert.equal(snapshot.state, 'listening');
  assert.equal(snapshot.speechAmplitude, 0);
  assert.deepEqual(snapshot.visemes, {});
  assert.equal(snapshot.gesture?.name, 'interrupt-settle');
  assert.equal(snapshot.interruptedAt, 13);
});

test('gesture operation keys prevent retrying an achievement animation', () => {
  const initial = createInitialCharacterSnapshot({ at: 0 });
  const first = reduceCharacterController(initial, {
    type: 'gesture.triggered',
    gesture: 'celebrating-little-mountain',
    operationKey: 'milestone:little-mountain:user-1',
    at: 20,
  });
  const retried = reduceCharacterController(first, {
    type: 'gesture.triggered',
    gesture: 'celebrating-little-mountain',
    operationKey: 'milestone:little-mountain:user-1',
    at: 21,
  });

  assert.equal(first.gesture?.name, 'celebrating-little-mountain');
  assert.equal(retried, first);
  assert.equal(retried.handledGestureOperationKeys.length, 1);
});

test('reduced motion suppresses large gestures while preserving semantic state', () => {
  let snapshot = createInitialCharacterSnapshot({ at: 0 });
  snapshot = reduceCharacterController(snapshot, {
    type: 'motion.preference',
    reduced: true,
    at: 1,
  });
  snapshot = reduceCharacterController(snapshot, {
    type: 'state.changed',
    state: 'celebrating',
    at: 2,
  });

  assert.equal(snapshot.state, 'celebrating');
  assert.equal(snapshot.motionMode, 'reduced');
  assert.equal(snapshot.gesture?.name, 'reduced-settle');
  assert.ok((snapshot.gesture?.intensity ?? 1) <= 0.14);

  snapshot = reduceCharacterController(snapshot, {
    type: 'gesture.triggered',
    gesture: 'celebrating-little-mountain',
    operationKey: 'unlock:1',
    at: 3,
  });
  assert.equal(snapshot.gesture?.name, 'reduced-emphasis');
});

test('reconnect and errors use neutral recovery gestures, never celebration', () => {
  let snapshot = createInitialCharacterSnapshot({ at: 0 });
  snapshot = reduceCharacterController(snapshot, {
    type: 'state.changed',
    state: 'celebrating',
    at: 1,
  });
  snapshot = reduceCharacterController(snapshot, {
    type: 'connection.reconnecting',
    attempt: 2,
    at: 2,
  });

  assert.equal(snapshot.connection, 'reconnecting');
  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.gesture?.name, 'reconnect-attentive');
  assert.equal(snapshot.reconnectAttempt, 2);

  snapshot = reduceCharacterController(snapshot, {
    type: 'connection.failed',
    code: 'network',
    message: 'Connection lost',
    retryable: true,
    at: 3,
  });
  assert.equal(snapshot.connection, 'error');
  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.lastError?.retryable, true);
  assert.notEqual(snapshot.gesture?.name, 'celebrating-paw-tap');

  snapshot = reduceCharacterController(snapshot, { type: 'connection.connected', at: 4 });
  assert.equal(snapshot.connection, 'connected');
  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.lastError, undefined);
  assert.equal(snapshot.reconnectAttempt, 0);
});

test('controller timestamps events, notifies subscribers, and expires cues', () => {
  let now = 50;
  const controller = new CharacterController({ clock: () => now });
  const revisions: number[] = [];
  const unsubscribe = controller.subscribe((snapshot) => revisions.push(snapshot.revision));

  now = 100;
  controller.dispatch({ type: 'state.changed', state: 'greeting' });
  assert.equal(controller.snapshot.updatedAt, 100);
  assert.equal(revisions.length, 1);

  now = 2_000;
  controller.dispatch({ type: 'clock.tick' });
  assert.equal(controller.snapshot.gesture, undefined);
  assert.equal(revisions.length, 2);

  unsubscribe();
  controller.dispatch({ type: 'state.changed', state: 'ready' });
  assert.equal(revisions.length, 2);
});
