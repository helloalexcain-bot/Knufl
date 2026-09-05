import test from 'node:test';
import assert from 'node:assert/strict';
import { addSession, calendarDayDifference, deleteSession, practiceCredits, updateSession } from './progression.ts';
import { createDefaultData, type SessionLog } from './types.ts';

const makeLog = (date: string, id: string, submissionKey = id): SessionLog => ({
  id,
  submissionKey,
  date,
  activity: 'Walking',
  source: 'completed',
  createdAt: `${date}T12:00:00.000Z`,
});

test('one practice credit is awarded per local calendar day, without a weekly cap', () => {
  let data = createDefaultData();
  data = addSession(data, makeLog('2026-09-01', 'a')).data;
  data = addSession(data, makeLog('2026-09-01', 'b')).data;
  data = addSession(data, makeLog('2026-09-02', 'c')).data;
  data = addSession(data, makeLog('2026-09-03', 'd')).data;
  data = addSession(data, makeLog('2026-09-04', 'e')).data;

  assert.equal(data.logs.length, 5);
  assert.equal(practiceCredits(data.logs), 4);
  assert.ok(data.unlockedMoves.includes('little-mountain'));
});

test('repeat submissions cannot duplicate the log or reward', () => {
  const initial = createDefaultData();
  const first = addSession(initial, makeLog('2026-09-01', 'a', 'same-tap'));
  const repeated = addSession(first.data, makeLog('2026-09-01', 'b', 'same-tap'));

  assert.equal(repeated.created, false);
  assert.equal(repeated.data.logs.length, 1);
  assert.equal(practiceCredits(repeated.data.logs), 1);
});

test('the first session creates its dated memory and deleting it removes that memory', () => {
  const saved = addSession(createDefaultData(), makeLog('2026-08-28', 'first')).data;
  assert.equal(saved.memories[0]?.title, 'Our first session');
  assert.equal(saved.memories[0]?.associatedSessionId, 'first');

  const deleted = deleteSession(saved, 'first');
  assert.equal(deleted.logs.length, 0);
  assert.equal(deleted.memories.length, 0);
});

test('editing a same-day log onto a third distinct date unlocks Little Mountain', () => {
  let data = createDefaultData();
  data = addSession(data, makeLog('2026-09-01', 'a')).data;
  data = addSession(data, makeLog('2026-09-02', 'b')).data;
  data = addSession(data, makeLog('2026-09-02', 'c')).data;
  assert.equal(practiceCredits(data.logs), 2);
  assert.equal(data.unlockedMoves.includes('little-mountain'), false);

  data = updateSession(data, { ...data.logs[2], date: '2026-08-20' });
  assert.equal(practiceCredits(data.logs), 3);
  assert.ok(data.unlockedMoves.includes('little-mountain'));
});

test('earned moves remain available when corrections or deletions reduce credited days', () => {
  let data = createDefaultData();
  data = addSession(data, makeLog('2026-09-01', 'a')).data;
  data = addSession(data, makeLog('2026-09-02', 'b')).data;
  data = addSession(data, makeLog('2026-09-03', 'c')).data;
  data = deleteSession(data, 'c');

  assert.equal(practiceCredits(data.logs), 2);
  assert.ok(data.unlockedMoves.includes('little-mountain'));
  assert.equal(data.memories.some((memory) => memory.associatedSessionId === 'c'), false);
});

test('calendar gaps are calculated by date rather than elapsed hours', () => {
  assert.equal(calendarDayDifference('2026-08-29', '2026-09-05'), 7);
  assert.equal(calendarDayDifference('2026-09-05', '2026-09-05'), 0);
});
