import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('CI guide retires wrapper recommendations without losing immutable provenance', () => {
  const guide = readFileSync(new URL('../docs/ci-runner.md', import.meta.url), 'utf8');
  assert.ok(guide.includes('wrapper is retired and is no longer a maintained integration route'));
  assert.ok(guide.includes('bb6e4ca4e9e94c7e81cf42d3808ef7b092c681b0'));
  assert.ok(guide.includes('npx --yes neondiff@1.1.1 review-pr --ci'));
  assert.ok(!guide.includes('uses: electricsheephq/neondiff-action@'));
  assert.ok(!guide.includes('For most repositories, use the'));
});
