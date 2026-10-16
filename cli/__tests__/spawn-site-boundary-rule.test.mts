import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import { spawnSiteBoundaryRule } from '../../oxc/rules/spawn-site-boundary.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } });
const error = { messageId: 'rawSpawn' };
const RAW = "import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';\n";
const HELPERS = "import { CLI } from './_helpers.mts';\n";

tester.run('devkit/spawn-site-boundary', spawnSiteBoundaryRule, {
  valid: [
    `${RAW}${HELPERS}spawnSync(cliNode, [CLI, 'review'], {
      // Named 124-sentinel carve-out: supervising this call gives the assertion two sources.
      timeout: 240_000,
    });`,
    `${RAW}${HELPERS}// Named 124-sentinel carve-out: two sources of 124 otherwise.
    const result = spawnSync(cliNode, [CLI, 'review'], { timeout: 240_000 });`,
    `${RAW}const SUPERVISOR = join(ROOT, 'cli/index.mts');
    function supervisor() {
      // Supervisor-subject carve-out: the supervisor is what this file tests.
      return spawnSync(process.execPath, [SUPERVISOR]);
    }`,
    `${RAW}spawnSync('bash', ['-c', shell], { timeout: 60_000 /* Sentinel carve-out: native bound */ });`,
    `import { testExecFileSync as execFileSync } from './_helpers.mts';
    execFileSync('/bin/bash', ['-c', \`. "\${join(dir, 'ship-run-record.sh')}"; f\`]);`,
    `import { CLI, testSpawnSync as spawnSync } from './_helpers.mts';
    spawnSync(process.execPath, [CLI, 'reconcile']);`,
    `${RAW}execFileSync('git', ['init', '-q', root]);`,
    `${RAW}execFileSync('git', ['add', '-f', '.codex/hooks/decision-stop-check.sh']);`,
    `${RAW}execSync('git add tool.sh');`,
    `${RAW}execFileSync('/bin/sh', ['-n', hook]);`,
    `${RAW}${HELPERS}spawn(process.execPath, [CLI, 'reconcile']);`,
    `${RAW}spawnSync(process.execPath, ['--import', './loader.shim.mjs', '-e', code]);`,
    `${RAW}spawnSync(process.execPath, ['-e', code], { env: { HOOK: 'pre-commit.sh' } });`,
  ],
  invalid: [
    {
      code: `${RAW}${HELPERS}spawnSync(cliNode, [CLI, 'review'], { timeout: 240_000 });`,
      errors: [error],
    },
    {
      code: `${RAW}execFileSync('/bin/bash', ['-c', \`. "\${join(dir, '../progress.sh')}"; fn\`]);`,
      errors: [error],
    },
    {
      code: `${RAW}spawnSync(process.execPath, [join(root, 'index.mts'), 'ship']);`,
      errors: [error],
    },
    {
      code: `${RAW}const script = join(ROOT, 'cli/lib/run.sh'); spawnSync('bash', [script]);`,
      errors: [error],
    },
    { code: `${RAW}execSync('node cli/index.mts review');`, errors: [error] },
    { code: `${RAW}execSync('bash ' + join(ROOT, 'cli/lib/run.sh'));`, errors: [error] },
    {
      code: `${RAW}${HELPERS}
      /** Named 124-sentinel carve-out, but on the test rather than the call. */
      it('bounds a wedge', () => {
        spawnSync(cliNode, [CLI, 'review']);
      });`,
      errors: [error],
    },
    {
      code: `import { spawnSync as run } from 'node:child_process';\n${HELPERS}run(process.execPath, [CLI]);`,
      errors: [error],
    },
  ],
});
