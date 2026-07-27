import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { selectionFlags } from '../commands/doctor.mts';
import { tmpRepos } from './_helpers.mts';

const { tmpRepo, devkit, cleanup } = tmpRepos('doctor-provider-');
afterEach(cleanup);

describe('doctor provider lifecycle', () => {
  it('replays opt-ins and deselections exactly during --fix', () => {
    const flags = selectionFlags({
      agents: false,
      lineGrowth: false,
      fallow: true,
      searchSteering: true,
      agentHooks: true,
      searchCode: true,
      guards: [],
      agentTargets: ['claude'],
    });
    expect(flags).toEqual(
      expect.arrayContaining([
        '--no-agents',
        '--no-line-growth',
        '--fallow',
        '--search-steering',
        '--agent-hooks',
        '--search-code',
        '--no-guards',
        '--no-codex',
        '--no-cursor',
      ]),
    );
  });

  it('leaves an invalid strict asset manifest for explicit recovery', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    const manifest = join(root, '.devkit', 'agents-manifest.json');
    writeFileSync(manifest, '{not-json');

    const result = devkit(root, 'doctor', '--fix');
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/agents: DRIFT .*invalid agents-manifest\.json/s);
    expect(readFileSync(manifest, 'utf8')).toBe('{not-json');
  });

  it('reports an invalid hook ledger as drift instead of throwing or overwriting it', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes', '--agent-hooks').status).toBe(0);
    const ledger = join(root, '.devkit', 'agent-hook-registrations-manifest.json');
    writeFileSync(ledger, '{not-json');

    const result = devkit(root, 'doctor', '--fix');
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/hook registrations: DRIFT/);
    expect(readFileSync(ledger, 'utf8')).toBe('{not-json');
  });

  it('does not accept a same-byte symlink as a healthy provider output', () => {
    const root = tmpRepo();
    expect(devkit(root, 'init', '--stack', 'generic', '--yes').status).toBe(0);
    const output = join(root, '.codex', 'agents', 'correctness-reviewer.toml');
    const outside = join(root, 'same-bytes.toml');
    writeFileSync(outside, readFileSync(output));
    rmSync(output);
    symlinkSync(outside, output);

    const result = devkit(root, 'doctor');
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/agents: DRIFT .*consumer copy drifted/s);
    expect(existsSync(outside)).toBe(true);
  });
});
