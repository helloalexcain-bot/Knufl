import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PENDING_OPERATIONS,
  PENDING_QUEUE_PREFIX,
  clearPendingOperations,
  enqueuePendingOperation,
  readPendingOperations,
} from './pending-queue.ts';

test('pending operations are namespaced per authenticated account', () => {
  assert.equal(PENDING_QUEUE_PREFIX, 'knufl.voice.pending.v1::');
  assert.notEqual(`${PENDING_QUEUE_PREFIX}user-a`, `${PENDING_QUEUE_PREFIX}user-b`);
});

test('permanent account deletion clears only that account queue', () => {
  const originalWindow = globalThis.window;
  const entries = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  };
  Object.assign(globalThis, { window: { localStorage } });
  try {
    enqueuePendingOperation('account-a', { id: 'a', name: 'record_set', arguments: { reps: 8 } });
    enqueuePendingOperation('account-b', { id: 'b', name: 'record_set', arguments: { reps: 6 } });
    clearPendingOperations('account-a');
    assert.deepEqual(readPendingOperations('account-a'), []);
    assert.equal(readPendingOperations('account-b').length, 1);
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.assign(globalThis, { window: originalWindow });
  }
});

test('a full offline queue preserves all existing operations and rejects another', () => {
  const originalWindow = globalThis.window;
  const entries = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  };
  Object.assign(globalThis, { window: { localStorage } });
  try {
    for (let index = 0; index < MAX_PENDING_OPERATIONS; index += 1) {
      enqueuePendingOperation('account-a', {
        id: `operation-${index}`,
        name: 'record_set',
        arguments: { reps: index + 1 },
      });
    }

    assert.throws(
      () => enqueuePendingOperation('account-a', {
        id: 'one-too-many',
        name: 'record_set',
        arguments: { reps: 1 },
      }),
      /offline queue is full/i,
    );
    assert.equal(readPendingOperations('account-a').length, MAX_PENDING_OPERATIONS);
    assert.equal(readPendingOperations('account-a')[0]?.id, 'operation-0');
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.assign(globalThis, { window: originalWindow });
  }
});
