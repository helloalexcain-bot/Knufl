import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgressImport } from './storage.ts';

test('older exports keep progress and names while removed identity fields are discarded', () => {
  const imported = parseProgressImport(JSON.stringify({
    version: 1,
    onboarded: true,
    profile: {
      name: 'Atlas',
      gender: 'Male',
      genderDetail: 'old value',
      pronouns: 'he/him',
    },
    plan: {
      weeklyTarget: 4,
      days: ['Mon', 'Thu'],
      activity: 'Walking',
      activityDetail: '',
    },
    logs: [{
      id: 'session-1',
      submissionKey: 'submission-1',
      date: '2026-09-01',
      activity: 'Walking',
      source: 'completed',
      createdAt: '2026-09-01T12:00:00.000Z',
    }],
    memories: [{
      id: 'memory-1',
      associatedSessionId: 'session-1',
      title: 'Our first session',
      note: 'Still here.',
      createdAt: '2026-09-01T12:00:00.000Z',
    }],
    unlockedMoves: ['first-session', 'little-mountain'],
    restDates: ['2026-09-02'],
    lastOpened: '2026-09-02',
    dialogueCursor: 2,
  }));

  assert.deepEqual(imported.profile, { name: 'Atlas' });
  assert.equal('gender' in imported.profile, false);
  assert.equal('pronouns' in imported.profile, false);
  assert.equal(imported.plan.weeklyTarget, 4);
  assert.equal(imported.logs[0]?.id, 'session-1');
  assert.equal(imported.memories[0]?.id, 'memory-1');
  assert.ok(imported.unlockedMoves.includes('little-mountain'));
  assert.deepEqual(imported.restDates, ['2026-09-02']);
});

test('current exports require a name-bearing profile but do not add identity fields', () => {
  const imported = parseProgressImport(JSON.stringify({
    version: 1,
    onboarded: false,
    profile: { name: 'Bram' },
    plan: { weeklyTarget: 3, days: [], activity: 'Strength', activityDetail: '' },
    logs: [],
  }));

  assert.deepEqual(Object.keys(imported.profile), ['name']);
});
