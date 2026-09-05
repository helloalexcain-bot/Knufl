import test from 'node:test';
import assert from 'node:assert/strict';
import { activityAcknowledgement } from './dialogue.ts';

test('home acknowledgements reflect supported and custom activities without inventing results', () => {
  assert.match(activityAcknowledgement('Walking'), /^Walk logged\./);
  assert.match(activityAcknowledgement('Running'), /^Run logged\./);
  assert.match(activityAcknowledgement('Cycling'), /^Ride logged\./);
  assert.match(activityAcknowledgement('Strength'), /^Strength logged\./);
  assert.equal(
    activityAcknowledgement('Swimming'),
    'Swimming logged. We showed up together. I brought the determined little wobble.',
  );
});
