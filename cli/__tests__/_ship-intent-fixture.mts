import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import type { writeIntent } from '../lib/ship/ship-intent.mts';

export const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
export const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type ObjectFormat = 'sha1' | 'sha256';
interface SeedOpts {
  ignored?: boolean;
  objectFormat?: ObjectFormat;
}

/** A repo whose .gitignore covers the manifest — the write guard's happy path. */
export function seedRepo({ ignored = true, objectFormat = 'sha1' }: SeedOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ship-intent-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', `--object-format=${objectFormat}`, dir], {
    env: { ...process.env, ...GIT_ENV },
  });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/app.git'], {
    env: { ...process.env, ...GIT_ENV },
  });
  if (ignored) writeFileSync(join(dir, '.gitignore'), '.devkit/\n');
  return dir;
}

export const base = (
  opts: Partial<Parameters<typeof writeIntent>[0]> = {},
  seed: SeedOpts = {},
) => ({
  root: seedRepo(seed),
  branch: 'feat/x',
  mode: 'ship',
  title: 'ship it',
  links: [],
  updatePrBody: false,
  draft: false,
  noStack: false,
  resumed: false,
  mergePaths: false,
  body: Buffer.from('pr body\n'),
  ...opts,
});
