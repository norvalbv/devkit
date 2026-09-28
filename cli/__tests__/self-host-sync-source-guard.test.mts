// sc-2345: in devkit's own repo, a devkit that is not the checkout must not write agent assets.
// Tests run from source, so a tmp root named @norvalbv/devkit is exactly that foreign runner.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncAgents } from '../commands/sync/sync-agents.mts';
import { syncSkills } from '../commands/sync/sync-skills.mts';
import { assertRunsFromSource } from '../lib/doctor/pin/runner-identity.mts';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('selfhost-source-guard-');
const DEVKIT_PKG = { name: '@norvalbv/devkit', version: '0.0.0' };
const REFUSAL = /refusing to write devkit-managed agent assets/;

/** Every file under `root` with its bytes, so "nothing was written" is one equality. */
function snapshot(root: string) {
  const out = new Map<string, string>();
  const walk = (dir: string, rel = ''): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else out.set(path, readFileSync(join(dir, entry.name), 'utf8'));
    }
  };
  walk(root);
  return out;
}

/** A devkit-named repo carrying a manifest and a projection the foreign runner would overwrite. */
function devkitRepo(): string {
  const root = tmpRepo(DEVKIT_PKG);
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, '.devkit'), { recursive: true });
  const manifest = { devkitRef: 'v0.0.0', generatedAt: 'checkout', targets: ['claude'], files: {} };
  writeFileSync(join(root, '.devkit', 'skills-manifest.json'), `${JSON.stringify(manifest)}\n`);
  mkdirSync(join(root, '.claude', 'skills', 'testing'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'testing', 'SKILL.md'), 'checkout copy\n');
  return root;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('assertRunsFromSource — identity', () => {
  it('refuses a devkit repo written by a runner rooted elsewhere, naming the from-source command', () => {
    const root = devkitRepo();
    expect(() => assertRunsFromSource(root, 'sync-skills', tmpRepo())).toThrow(
      /Run from source: bun run devkit sync-skills/,
    );
  });

  it('allows the runner that IS the repo, however the path is spelled', () => {
    const root = devkitRepo();
    const link = `${tmpRepo()}-link`;
    symlinkSync(root, link);
    expect(() => assertRunsFromSource(root, 'x', root)).not.toThrow();
    expect(() => assertRunsFromSource(root, 'x', `${root}/`)).not.toThrow();
    expect(() => assertRunsFromSource(root, 'x', join(root, 'cli', '..'))).not.toThrow();
    expect(() => assertRunsFromSource(link, 'x', root)).not.toThrow();
    expect(() => assertRunsFromSource(root, 'x', link)).not.toThrow();
  });

  it('refuses the repo own dist build and a runner path that does not exist', () => {
    const root = devkitRepo();
    expect(() => assertRunsFromSource(root, 'x', join(root, 'dist'))).toThrow(REFUSAL);
    expect(() => assertRunsFromSource(root, 'x', join(root, 'no-such-dir'))).toThrow(REFUSAL);
  });

  it('never refuses a consumer, whatever runs it', () => {
    const consumer = tmpRepo({ name: 'some-consumer' });
    expect(() => assertRunsFromSource(consumer, 'x', tmpRepo())).not.toThrow();
  });

  it('treats a malformed or absent package.json as not devkit instead of crashing', () => {
    const broken = tmpRepo();
    writeFileSync(join(broken, 'package.json'), '{ not json');
    expect(() => assertRunsFromSource(broken, 'x', tmpRepo())).not.toThrow();
    const bare = tmpRepo();
    writeFileSync(join(bare, 'package.json'), '');
    expect(() => assertRunsFromSource(bare, 'x', tmpRepo())).not.toThrow();
  });

  it('keys on the git root: a devkit-named sub-package in a consumer monorepo is not self-host', () => {
    const mono = tmpRepo({ name: 'consumer-monorepo' });
    mkdirSync(join(mono, 'packages', 'devkit'), { recursive: true });
    writeFileSync(join(mono, 'packages', 'devkit', 'package.json'), JSON.stringify(DEVKIT_PKG));
    expect(() => assertRunsFromSource(mono, 'x', tmpRepo())).not.toThrow();
  });
});

describe('agent-asset writers — a foreign runner writes nothing', () => {
  it('syncSkills refuses and leaves manifest and projections byte-identical', () => {
    const root = devkitRepo();
    const before = snapshot(root);
    expect(() => syncSkills([], root, ['claude', 'cursor'])).toThrow(REFUSAL);
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, '.cursor'))).toBe(false);
  });

  it('syncAgents refuses and leaves the tree byte-identical', () => {
    const root = devkitRepo();
    const before = snapshot(root);
    expect(() => syncAgents([], root, ['claude', 'cursor'])).toThrow(/bun run devkit sync-agents/);
    expect(snapshot(root)).toEqual(before);
  });

  it('a dry run is not refused and still writes nothing', () => {
    const root = devkitRepo();
    const before = snapshot(root);
    expect(() => syncSkills(['--dry-run'], root, ['claude'])).not.toThrow();
    expect(() => syncAgents(['--dry-run'], root, ['claude'])).not.toThrow();
    expect(snapshot(root)).toEqual(before);
  });

  it('a consumer repo still syncs', () => {
    const root = tmpRepo({ name: 'some-consumer' });
    syncSkills([], root, ['claude']);
    expect(existsSync(join(root, '.devkit', 'skills-manifest.json'))).toBe(true);
  });
});

describe('CLI wiring — refusal surfaces as exit 1 with the remedy', () => {
  it('sync-skills', () => {
    const root = devkitRepo();
    const before = snapshot(root);
    const r = devkit(root, 'sync-skills');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Run from source: bun run devkit sync-skills/);
    expect(snapshot(root)).toEqual(before);
  });

  it('init refuses before writing anything, not halfway through', () => {
    const root = devkitRepo();
    const before = snapshot(root);
    const r = devkit(root, 'init', '--yes', '--stack', 'generic');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/bun run devkit init/);
    expect(snapshot(root)).toEqual(before);
  });

  it('upgrade in a self-host repo refuses before regenerating anything', () => {
    const root = devkitRepo();
    writeFileSync(
      join(root, '.devkit', 'config.json'),
      JSON.stringify({ stack: 'generic', selfHost: true, components: {} }),
    );
    const before = snapshot(root);
    const r = devkit(root, 'upgrade');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/bun run devkit upgrade/);
    expect(snapshot(root)).toEqual(before);
  });
});

describe('subdirectory runs resolve to the repo root', () => {
  it('the guard refuses from any directory inside devkit own repo', () => {
    const root = devkitRepo();
    const sub = join(root, 'cli', 'commands');
    mkdirSync(sub, { recursive: true });
    expect(() => assertRunsFromSource(sub, 'init', tmpRepo())).toThrow(REFUSAL);
    expect(() => assertRunsFromSource(sub, 'init', root)).not.toThrow();
  });

  it('init launched from a subdirectory refuses before writing anything', () => {
    const root = devkitRepo();
    const sub = join(root, 'docs');
    mkdirSync(sub);
    const before = snapshot(root);
    const r = devkit(sub, 'init', '--yes', '--stack', 'generic');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/bun run devkit init/);
    expect(snapshot(root)).toEqual(before);
  });
});
