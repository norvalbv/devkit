import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseFlags, selectionFromFlags } from '../commands/init.mts';
import { type Selection } from '../lib/components.mts';
import { sha256 } from '../lib/fs-helpers.mts';
import { readConfig, tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('init-recorded-');
afterEach(cleanup);

const providers = ['claude', 'codex', 'cursor'];

function hookSnapshot(root: string): Record<string, string> {
  const files: Array<[string, string]> = [];
  for (const provider of providers) {
    const dir = join(root, `.${provider}`, 'hooks');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      files.push([`${provider}/${name}`, sha256(path)]);
    }
  }
  return Object.fromEntries(files);
}

describe('selectionFromFlags — recorded re-run precedence', () => {
  it('preserves unspecified values while explicit positive and negative flags win', () => {
    const recorded: Partial<Selection> = {
      biome: false,
      agentHooks: true,
      adhd: true,
      priorArtGate: true,
      agentTargets: ['claude', 'codex'],
      guards: ['size', 'comments', 'review'],
    };

    const selection = selectionFromFlags(
      parseFlags(['--yes', '--search-code', '--no-adhd', '--no-codex', '--no-comments']),
      recorded,
    );

    expect(selection).toMatchObject({
      biome: false,
      agentHooks: true,
      searchCode: true,
      adhd: false,
      priorArtGate: true,
      agentTargets: ['claude'],
      guards: ['size', 'review'],
    });
  });
});

describe('devkit init --yes — recorded selection re-run', () => {
  it('enables one component without changing other components, review, or provider hooks', () => {
    const root = tmpRepo();
    const guards = 'size,fanout,dup,clone,comments,decisions,qavis-advisory,review,sentry,coverage';
    const reviewGuards = 'size,fanout,dup,clone,decisions,qavis-advisory,review,coverage';
    const first = devkit(
      root,
      'init',
      '--stack',
      'generic',
      '--yes',
      '--no-biome',
      '--agent-hooks',
      '--search-steering',
      '--anti-slop',
      '--adhd',
      '--prior-art-gate',
      '--no-cursor',
      '--guards',
      guards,
      '--no-comments',
      '--review',
      '--review-guards',
      reviewGuards,
    );
    expect(first.status, first.stderr).toBe(0);
    const before = readConfig(root);
    const beforeHooks = hookSnapshot(root);
    expect(Object.keys(beforeHooks).length).toBeGreaterThan(0);

    const rerun = devkit(root, 'init', '--stack', 'generic', '--yes', '--search-code');

    expect(rerun.status, rerun.stderr).toBe(0);
    const after = readConfig(root);
    expect(after.components).toEqual({ ...before.components, searchCode: true });
    expect(after.review).toEqual(before.review);
    expect(hookSnapshot(root)).toEqual(beforeHooks);
  });

  it('keeps legacy unoffered optional-component keys absent', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    const configPath = join(root, '.devkit', 'config.json');
    const legacy = readConfig(root);
    delete legacy.components.adhd;
    delete legacy.components.priorArtGate;
    delete legacy.components.antiSlop;
    writeFileSync(configPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const rerun = devkit(root, 'init', '--stack', 'generic', '--yes', '--search-code');

    expect(rerun.status, rerun.stderr).toBe(0);
    const after = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(after.components.searchCode).toBe(true);
    expect(after.components).not.toHaveProperty('adhd');
    expect(after.components).not.toHaveProperty('priorArtGate');
    expect(after.components).not.toHaveProperty('antiSlop');
  });

  it('infers legacy provider ownership without claiming a fresh Codex surface', () => {
    const root = tmpRepo();
    const first = devkit(root, 'init', '--stack', 'generic', '--yes', '--no-codex', '--no-cursor');
    expect(first.status, first.stderr).toBe(0);
    const configPath = join(root, '.devkit', 'config.json');
    const legacy = readConfig(root);
    delete legacy.components.agentTargets;
    writeFileSync(configPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const rerun = devkit(root, 'init', '--stack', 'generic', '--yes', '--search-code');

    expect(rerun.status, rerun.stderr).toBe(0);
    expect(readConfig(root).components.agentTargets).toEqual(['claude']);
    expect(existsSync(join(root, '.codex'))).toBe(false);
  });

  it('enables structure when an explicit stack change makes the preset newly viable', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    expect(readConfig(root).components.structure).toBe(false);

    const rerun = devkit(root, 'init', '--stack', 'react-app', '--yes');

    expect(rerun.status, rerun.stderr).toBe(0);
    expect(readConfig(root).components.structure).toBe(true);
    expect(existsSync(join(root, 'eslint.config.mjs'))).toBe(true);
  });

  it('preserves a legacy overlay biome opt-out and records it for later reruns', () => {
    const root = tmpRepo();
    execFileSync('git', ['init', '-q'], { cwd: root });
    const first = devkit(root, 'init', '--stack', 'generic', '--overlay', '--yes', '--no-biome');
    expect(first.status, first.stderr).toBe(0);
    const configPath = join(root, '.devkit', 'config.json');
    const legacy = readConfig(root);
    delete legacy.components.biome;
    writeFileSync(configPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const rerun = devkit(root, 'init', '--stack', 'generic', '--overlay', '--yes', '--agent-hooks');

    expect(rerun.status, rerun.stderr).toBe(0);
    expect(readConfig(root).components.biome).toBe(false);
    expect(existsSync(join(root, 'biome.devkit.jsonc'))).toBe(false);
  });
});
