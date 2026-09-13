// Source-adaptation controls only: no model, scorer, or corpus mutation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { materializeFixture } from '../../../../gate-engine/decisions/eval/bench.mts';

const [bug, repair] = JSON.parse(readFileSync(new URL('./vue-proposals.json', import.meta.url)));
assert.deepEqual(bug.repo.base, repair.repo.base);
assert.equal(bug.caseId, repair.caseId);
assert.equal(repair.variantOf, bug.id);
assert.equal(
  repair.repo.staged['src/async-view.mjs'],
  bug.repo.staged['src/async-view.mjs'].replace(
    '        if (instance.isUnmounted) return;\n        onError(error);',
    '        if (instance.isUnmounted) {\n          pendingRequest = null;\n          return;\n        }\n        onError(error);',
  ),
);

const exercise = `
import { defineAsyncView } from './src/async-view.mjs';
import { mountView } from './src/view-host.mjs';
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const requests = [];
  const definition = defineAsyncView(() => new Promise((resolve, reject) => requests.push({ resolve, reject })));
  return { definition, requests };
}
const observations = {};
{
  const { definition, requests } = setup();
  const errors = [];
  const old = mountView(definition, error => errors.push(error.message));
  old.unmount();
  requests[0].reject(new Error('first request failed'));
  await settle();
  const oldErrors = errors.length;
  const fresh = mountView(definition, error => errors.push(error.message));
  await settle();
  const attempts = requests.length;
  requests[1]?.resolve(() => 'loaded');
  await settle();
  observations.remount = { attempts, oldErrors, rendered: fresh.read() };
}
{
  const { definition, requests } = setup();
  const errors = [];
  mountView(definition, error => errors.push(error.message));
  requests[0].reject(new Error('active request failed'));
  await settle();
  const fresh = mountView(definition, error => errors.push(error.message));
  requests[1].resolve(() => 'retry loaded');
  await settle();
  observations.activeError = { attempts: requests.length, errors, rendered: fresh.read() };
}
{
  const { definition, requests } = setup();
  const errors = [];
  const old = mountView(definition, error => errors.push(error.message));
  const live = mountView(definition, error => errors.push(error.message));
  old.unmount();
  requests[0].resolve(() => 'shared loaded');
  await settle();
  const later = mountView(definition, error => errors.push(error.message));
  observations.sharedSuccess = { attempts: requests.length, errors, live: live.read(), later: later.read() };
}
{
  const { definition, requests } = setup();
  const oldErrors = [], liveErrors = [];
  const old = mountView(definition, error => oldErrors.push(error.message));
  mountView(definition, error => liveErrors.push(error.message));
  old.unmount();
  requests[0].reject(new Error('shared request failed'));
  await settle();
  const fresh = mountView(definition, error => liveErrors.push(error.message));
  requests[1].resolve(() => 'recovered');
  await settle();
  observations.sharedFailure = { attempts: requests.length, oldErrors: oldErrors.length, liveErrors: liveErrors.length, rendered: fresh.read() };
}
console.log(JSON.stringify(observations));
`;

const results = [];
for (const [view, row] of [
  ['base', { repo: { base: bug.repo.base, staged: {} } }],
  ['bug', bug],
  ['repair', repair],
]) {
  const fixture = materializeFixture(row);
  try {
    if (view !== 'base') assert.deepEqual(fixture.staged, ['src/async-view.mjs']);
    const observed = JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '--eval', exercise], {
        cwd: fixture.repo,
        encoding: 'utf8',
        timeout: 30000,
      }),
    );
    assert.deepEqual(observed.remount, {
      attempts: view === 'bug' ? 1 : 2,
      oldErrors: view === 'base' ? 1 : 0,
      rendered: view === 'bug' ? null : 'loaded',
    });
    assert.deepEqual(observed.activeError, {
      attempts: 2,
      errors: ['active request failed'],
      rendered: 'retry loaded',
    });
    assert.deepEqual(observed.sharedSuccess, {
      attempts: 1,
      errors: [],
      live: 'shared loaded',
      later: 'shared loaded',
    });
    assert.deepEqual(observed.sharedFailure, {
      attempts: 2,
      oldErrors: view === 'base' ? 1 : 0,
      liveErrors: 1,
      rendered: 'recovered',
    });
    results.push({ view, observed });
  } finally {
    fixture.cleanup();
  }
}
console.log(
  JSON.stringify(
    { lifecycle: 'source-adaptation-controls', modelCalls: 0, scenarios: 12, results },
    null,
    2,
  ),
);
