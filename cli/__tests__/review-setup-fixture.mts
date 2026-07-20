import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import { normalizeSelection } from '../lib/components.mts';
import { rootRegistry } from './_helpers.mts';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function write(root: string, relativePath: string, contents: string, executable = false): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, executable ? 0o755 : 0o644);
  return path;
}

export function reviewSetupFixtures() {
  const { mkTmp, cleanup } = rootRegistry();
  afterEach(cleanup);
  const selection = normalizeSelection({
    biome: false,
    tsconfig: false,
    skills: false,
    agents: false,
    searchSteering: false,
    agentHooks: false,
    husky: true,
    structure: false,
    fallow: false,
    searchCode: false,
    lineGrowth: false,
    guards: ['size', 'decisions'],
  });
  return { git, mkTmp, selection, write };
}
