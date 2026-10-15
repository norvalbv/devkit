import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordStageable, renderBlockRemedy, smellFiles } from '../capture/block-remedy.mts';

const base: Parameters<typeof renderBlockRemedy>[0] = {
  files: ['package.json'],
  slugs: [],
  stageable: true,
  judgeLive: true,
  decisionsDir: 'docs/decisions',
};

describe('renderBlockRemedy', () => {
  it('with no governing Target, prints the scoped add command, the re-run and staging', () => {
    const out = renderBlockRemedy(base).join('\n');
    expect(out).toContain('No recorded Target is scoped to these files.');
    expect(out).toContain('guard-decisions add <slug> --target "<ruling>" --scope "package.json"');
    expect(out).toContain('then re-run: the judge reads Targets scoped to the changed files');
    expect(out).toContain('Or stage the record under docs/decisions/');
  });

  it('lists the scoped Targets and warns off staging into an unstageable log', () => {
    const out = renderBlockRemedy({
      ...base,
      files: ['package.json', 'src/a.ts'],
      slugs: ['dep-policy', 'layout'],
      stageable: false,
    }).join('\n');
    // The size cap can drop a slug from the judge's prompt, and a garbled verdict is not a ruling,
    // so the remedy lists the Targets without claiming what the judge read or decided.
    expect(out).toContain('Targets scoped to these files: dep-policy, layout.');
    expect(out).not.toMatch(/The judge read|still ruled/);
    expect(out).toContain('--scope "package.json,src/a.ts"');
    expect(out).toContain('docs/decisions is git-ignored or linked here: do not stage the record');
    expect(out).not.toContain('Or stage the record');
  });

  it('says so when the log is unreadable', () => {
    expect(renderBlockRemedy({ ...base, slugs: null })[0]).toBe(
      '   Recorded Targets could not be read.',
    );
  });

  it('asks for the judge on the re-run when it did not run', () => {
    const out = renderBlockRemedy({ ...base, judgeLive: false }).join('\n');
    expect(out).toContain('then re-run with the judge available');
  });
});

describe('smellFiles', () => {
  it('maps a dep-change to its package.json, never the dependency name', () => {
    const files = smellFiles(
      [
        { label: 'dep-change', path: 'dotenv' },
        { label: 'legacy-deletion', path: 'src/old.ts' },
      ],
      [{ path: 'package.json', depChanged: true }, { path: 'src/old.ts' }, { path: 'README.md' }],
    );
    expect(files).toEqual(['package.json', 'src/old.ts']);
  });
});

describe('recordStageable', () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'block-remedy-'));
    repo = join(root, 'repo');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('is true for a tracked decisions dir', () => {
    mkdirSync(join(repo, 'docs', 'decisions'));
    expect(recordStageable(repo, 'docs/decisions')).toBe(true);
  });

  it('is false when the dir is git-excluded', () => {
    mkdirSync(join(repo, 'docs', 'decisions'));
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '/docs/decisions/\n');
    expect(recordStageable(repo, 'docs/decisions')).toBe(false);
  });

  it('is false when the dir is a symlink git cannot traverse', () => {
    mkdirSync(join(root, 'shared'));
    symlinkSync(join(root, 'shared'), join(repo, 'docs', 'decisions'), 'dir');
    expect(recordStageable(repo, 'docs/decisions')).toBe(false);
  });
});
