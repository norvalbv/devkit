/**
 * The staged fallow gate blocks introduced duplication against the real fallow binary, which rates
 * a duplication-only changeset `warn` and exits 0 — the verdict the agent wrapper already blocks.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FALLOW_STAGED } from '../lib/husky/gate-policy/fallow-staged.mts';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';
import { runHookFragment } from './_husky-hook-harness.mts';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const BASE_ENV = Object.fromEntries(
  Object.entries(GIT_ENV).filter(([name]) => !name.startsWith('FALLOW_')),
);
const hasFallow = spawnSync('fallow', ['--version'], { encoding: 'utf8' }).status === 0;
const DUPLICATION = 'the staged diff introduces duplication';

// Long enough to clear fallow's default clone floor (50 tokens, 5 lines).
const body = (name: string) => `export function ${name}(x) {
  let total = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] > 10) { total += x[i] * 2; } else { total -= x[i]; }
    if (total > 1000) { total = total / 3; }
    console.log('step', i, total, x[i]);
  }
  return total;
}
`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A committed `a.js`, then `files` written and staged on top of it. */
function stagedRepo(files: Record<string, string>) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'fallow-dup-')));
  dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV });
  writeFileSync(join(cwd, 'package.json'), '{"name":"x","version":"1.0.0","type":"module"}\n');
  // Every file is an entry, so an unused file or export can never be what blocks.
  writeFileSync(join(cwd, '.fallowrc.json'), '{"entry":["*.js"]}\n');
  writeFileSync(join(cwd, 'a.js'), body('a'));
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'base');
  for (const [file, text] of Object.entries(files)) writeFileSync(join(cwd, file), text);
  git('add', '-A');
  return cwd;
}

function runGate(cwd: string) {
  const r = runHookFragment(FALLOW_STAGED, { cwd, env: BASE_ENV });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!hasFallow)('staged fallow gate — introduced duplication', () => {
  it('blocks a duplication-only staged set that fallow alone lets through', () => {
    const cwd = stagedRepo({ 'c.js': body('c') });
    const diff = execFileSync('git', ['diff', '--cached'], { cwd, env: GIT_ENV });
    const unaided = spawnSync('fallow', ['audit', '--diff-stdin'], {
      cwd,
      encoding: 'utf8',
      input: diff,
      env: BASE_ENV,
    });

    const gate = runGate(cwd);

    expect(unaided.status).toBe(0);
    expect(gate.status).toBe(1);
    expect(gate.out).toContain(DUPLICATION);
    expect(gate.out).toContain('c.js');
  });

  it('lets an intended copy through once it carries the suppression the block line names', () => {
    const gate = runGate(
      stagedRepo({ 'c.js': `// fallow-ignore-next-line code-duplication\n${body('c')}` }),
    );
    expect(gate.out).not.toContain(DUPLICATION);
    expect(gate.status).toBe(0);
  });

  it('lets a staged set with no new clone through', () => {
    const gate = runGate(stagedRepo({ 'b.js': 'export const b = () => 1;\n' }));
    expect(gate.out).not.toContain(DUPLICATION);
    expect(gate.status).toBe(0);
  });
});
