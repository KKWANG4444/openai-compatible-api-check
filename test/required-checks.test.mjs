import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredChecksPassed } from '../src/check.mjs';

const checkIds = [
  'models-endpoint',
  'model-listed',
  'chat-completions',
  'protocol',
  'instruction-following',
  'metadata',
  'model-claim',
  'usage',
  'dynamic-challenge',
];

test('every advertised check is individually required by the deployment gate', () => {
  const passing = checkIds.map((id) => ({ id, passed: true }));
  assert.equal(requiredChecksPassed(passing), true);

  for (const failedId of checkIds) {
    const checks = passing.map((check) => ({ ...check, passed: check.id !== failedId }));
    assert.equal(requiredChecksPassed(checks), false, `${failedId} must fail the gate`);
  }
});

test('missing or duplicate required checks cannot pass the deployment gate', () => {
  const passing = checkIds.map((id) => ({ id, passed: true }));
  assert.equal(requiredChecksPassed(passing.slice(1)), false);
  assert.equal(requiredChecksPassed([...passing, passing[0]]), false);
});
