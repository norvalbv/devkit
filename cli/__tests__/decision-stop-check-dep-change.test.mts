// decision-stop-check.sh against the REAL `detect scan --files` output: a stub bin cannot catch the
// scan's file column drifting from the session-edits ledger the hook matches it against.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry, seedSessionLedger } from './_helpers.mts';

const HOOK = fileURLToPath(new URL('../../agents-hooks/decision-stop-check.sh', import.meta.url));
const CLI = fileURLToPath(new URL('../../gate-engine/decisions/cli.mts', import.meta.url));

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const manifest = (deps: Record<string, string>) =>
  `${JSON.stringify({ name: 'x', dependencies: deps }, null, 2)}\n`;

/** A committed consumer repo whose node_modules/.bin/guard-decisions runs this checkout's CLI. */
function consumerRepo(): string {
  const root = mkTmp('dsc-dep-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(root, 'package.json'), manifest({}));
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.test-tmpdir/\n');
  git('add', '.');
  git('-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-qm', 'base');
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  const bin = `#!/bin/sh\nexec node ${JSON.stringify(CLI)} "$@"\n`;
  writeFileSync(join(root, 'node_modules', '.bin', 'guard-decisions'), bin, { mode: 0o755 });
  return root;
}

const stop = (root: string, tmp: string) =>
  spawnSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: 's1' }),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
      TMPDIR: tmp,
      GUARD_NO_LOG: '',
      FRINK_NO_LOG: '',
    },
    encoding: 'utf8',
  });

describe('decision-stop-check.sh — dep-change nudge with the real scan output', () => {
  it('nudges once per new dependency when this session edited package.json', () => {
    const root = consumerRepo();
    const tmp = seedSessionLedger(root, 's1', ['package.json']);
    writeFileSync(join(root, 'package.json'), manifest({ a: '1.0.0' }));
    const first = stop(root, tmp);
    expect(first.status).toBe(2);
    expect(first.stderr).toContain('dep-change');

    const again = stop(root, tmp);
    expect(again.status).toBe(0);
    expect(again.stderr).toBe('');

    writeFileSync(join(root, 'package.json'), manifest({ a: '1.0.0', b: '2.0.0' }));
    const next = stop(root, tmp);
    expect(next.status).toBe(2);
    expect(next.stderr).toContain('dep-change');
  });

  it('stays silent when this session did not edit package.json', () => {
    const root = consumerRepo();
    const tmp = seedSessionLedger(root, 's1', ['src/x.ts']);
    writeFileSync(join(root, 'package.json'), manifest({ a: '1.0.0' }));
    const r = stop(root, tmp);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});
