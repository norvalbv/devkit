import fs, { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installSearchCode } from '../lib/install/install-search-code.mts';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('sc-');
afterEach(cleanup);

describe('installSearchCode .gitignore line', () => {
  it('keeps an edit another writer makes between its read and its write', () => {
    const root = tmpRepo();
    const gitignore = join(root, '.gitignore');
    writeFileSync(gitignore, 'node_modules\n');
    const realReadFileSync = fs.readFileSync;
    let interleaved = false;
    // SAFETY: the wrapper forwards every argument to the real readFileSync and returns its value.
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const stale = realReadFileSync(...args);
      if (!interleaved && String(args[0]) === gitignore) {
        interleaved = true; // an editor saves its own line just after devkit's read
        writeFileSync(gitignore, 'node_modules\nuser-line\n');
      }
      return stale;
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports(); // install-search-code.mts binds readFileSync by name
    try {
      installSearchCode(root, false);
    } finally {
      fs.readFileSync = realReadFileSync;
      syncBuiltinESMExports();
    }
    expect(interleaved).toBe(true);
    expect(readFileSync(gitignore, 'utf8')).toBe('node_modules\nuser-line\n.search-code/\n');
  });

  it('puts the line on its own line when the file lacks a trailing newline, once', () => {
    const root = tmpRepo();
    writeFileSync(join(root, '.gitignore'), 'node_modules');
    installSearchCode(root, false);
    installSearchCode(root, false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n.search-code/\n');
  });

  it('appends under the shared .gitignore lock, and a re-run converges once it is free', () => {
    const root = tmpRepo();
    const lock = join(root, '.devkit', 'gitignore.lock');
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    mkdirSync(join(root, '.devkit'));
    writeFileSync(lock, String(process.pid)); // a live devkit writer mid-rewrite
    expect(() => installSearchCode(root, false)).toThrow(/held by another devkit process/);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n');
    rmSync(lock);
    installSearchCode(root, false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n.search-code/\n');
    expect(existsSync(lock)).toBe(false); // released
  });

  it('dry-run writes neither .gitignore nor .devkit/', () => {
    const root = tmpRepo();
    installSearchCode(root, true);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    expect(existsSync(join(root, '.devkit'))).toBe(false);
  });
});

describe('search-code opt-in component', () => {
  it('--search-code writes the opt-in config + gitignores the index + wires indexPath', () => {
    const root = tmpRepo();
    const r = devkit(root, 'init', '--stack', 'generic', '--yes', '--search-code');
    expect(r.status).toBe(0);
    expect(existsSync(join(root, 'search-code.config.json')), 'opt-in config written').toBe(true);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.search-code/');
    // generic template ships no indexPath → installSearchCode must INSERT it.
    expect(readFileSync(join(root, 'guard.config.json'), 'utf8')).toContain(
      '"indexPath": ".search-code/index.db"',
    );
    // recorded so clean knows to reverse it.
    const cfg = JSON.parse(readFileSync(join(root, '.devkit/config.json'), 'utf8'));
    expect(cfg.components.searchCode).toBe(true);
  });

  it('is off by default (no --search-code → no config)', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes');
    expect(existsSync(join(root, 'search-code.config.json'))).toBe(false);
  });

  it('clean removes the opt-in config + prunes the gitignore line', () => {
    const root = tmpRepo();
    devkit(root, 'init', '--stack', 'generic', '--yes', '--search-code');
    expect(devkit(root, 'clean', '--yes').status).toBe(0);
    expect(existsSync(join(root, 'search-code.config.json'))).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).not.toContain('.search-code/');
  });

  it('syncs the external search-code CLI fallback for commit-guard', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);

    const surfaces = [
      {
        skill: ['.claude', 'skills/commit-guard/SKILL.md'],
        agent: ['.claude', 'agents/commit-guard.md'],
      },
      {
        skill: ['.agents', 'skills/commit-guard/SKILL.md'],
        agent: ['.codex', 'agents/commit-guard.toml'],
      },
      {
        skill: ['.cursor', 'skills/commit-guard/SKILL.md'],
        agent: ['.cursor', 'agents/commit-guard.md'],
      },
    ] as const;

    for (const surface of surfaces) {
      const skill = readFileSync(join(root, ...surface.skill), 'utf8');
      const agent = readFileSync(join(root, ...surface.agent), 'utf8');

      expect(skill).toContain('`search-code search "<text>"`');
      expect(skill).not.toContain('tools/search-code/bin/semantic-search.mjs');
      expect
        .soft(skill, `${surface.skill[0]} semantic boundary`)
        .toContain('Semantic matching is intentionally not run as an advisory pre-push net');
      expect
        .soft(skill, `${surface.skill[0]} stale semantic pre-push guidance`)
        .not.toContain('+ the advisory `.husky/pre-push` net');
      expect(agent).toContain('search-code search');
      expect(agent).toContain('--json');
      expect(agent).not.toContain('tools/search-code/bin/semantic-search.mjs');
    }
  });
});
