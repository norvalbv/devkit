/**
 * A Target the staged diff adds or changes is a claim under review, so the completeness judge must
 * get it as a named note rather than inside its authority block.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCompleteness } from '../completeness.mts';
import { renderChangedTargets, stagedTargetChanges } from '../evidence/targets-block.mts';
import {
  cleanupReviewFixtures,
  consumerRepo,
  messageFile,
  mkExec,
} from './run-review-fixtures.mts';

const target = (ruling: string): string =>
  `## Target · 2026-10-01 — Heading\n\n**Context:** c\n**Ruling:** ${ruling}\n**Consequences:**\n- Positive: p\n**Scope:** src/**\n`;
const axis = (slug: string, body: string): string =>
  `---\nslug: ${slug}\ncreated: 2026-10-01\n---\n\n# ${slug}\n\n${body}`;

let repo: string;
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const write = (rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), text);
};
const staged = (): string[] => git('diff', '--cached', '--name-only').split('\n').filter(Boolean);

beforeEach(() => {
  vi.stubEnv('GUARD_DECISIONS_DIR', undefined);
  vi.stubEnv('FRINK_DECISIONS_DIR', undefined);
  vi.stubEnv('DECISIONS_NO_EMBED', '1');
  repo = mkdtempSync(path.join(tmpdir(), 'staged-targets-'));
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  write('guard.config.json', JSON.stringify({ decisionsDir: 'docs/decisions' }));
  write('docs/decisions/kept.md', axis('kept', target('The old ruling.')));
  write('docs/decisions/INDEX.md', '# index\n');
  git('add', '.');
  git('commit', '-qm', 'base');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupReviewFixtures();
  rmSync(repo, { recursive: true, force: true });
});

describe('stagedTargetChanges', () => {
  it('names a new axis and a superseding Target, never INDEX.md', () => {
    write('docs/decisions/fresh.md', axis('fresh', target('A brand new claim.')));
    write(
      'docs/decisions/kept.md',
      axis('kept', `${target('The old ruling.')}\n${target('The replacing ruling.')}`),
    );
    write('docs/decisions/INDEX.md', '# index v2\n');
    git('add', '.');
    expect(stagedTargetChanges(staged(), repo).sort()).toEqual(['fresh', 'kept']);
  });

  it('keeps a Target whose staged change is a note-only append', () => {
    write(
      'docs/decisions/kept.md',
      axis('kept', `${target('The old ruling.')}- 2026-10-02 — a convergence note\n`),
    );
    git('add', '.');
    expect(staged()).toEqual(['docs/decisions/kept.md']);
    expect(stagedTargetChanges(staged(), repo)).toEqual([]);
  });

  it('reads the index, not the worktree, and is empty with no decision file staged', () => {
    write('src/a.ts', 'export {};\n');
    git('add', 'src/a.ts');
    write('docs/decisions/kept.md', axis('kept', target('Unstaged edit.')));
    expect(stagedTargetChanges(staged(), repo)).toEqual([]);
    expect(renderChangedTargets([])).toBe('');
  });

  it('treats every staged Target as changed on a first commit (unborn HEAD)', () => {
    repo = mkdtempSync(path.join(tmpdir(), 'staged-targets-unborn-'));
    git('init', '-q');
    write('guard.config.json', JSON.stringify({ decisionsDir: 'docs/decisions' }));
    write('docs/decisions/first.md', axis('first', target('Initial claim.')));
    git('add', '.');
    expect(stagedTargetChanges(staged(), repo)).toEqual(['first']);
  });

  it('returns [] without throwing when the configured decisions dir does not exist', () => {
    write('guard.config.json', JSON.stringify({ decisionsDir: 'governance/adr' }));
    write('governance/notes.md', 'x\n');
    git('add', '.');
    expect(stagedTargetChanges(staged(), repo)).toEqual([]);
  });

  it('resolves the decisions dir from a package subdirectory against toplevel-relative paths', () => {
    const pkg = path.join(repo, 'packages/app');
    write('packages/app/guard.config.json', JSON.stringify({ decisionsDir: 'adr' }));
    write('packages/app/adr/pkg-axis.md', axis('pkg-axis', target('Package claim.')));
    git('add', '.');
    expect(stagedTargetChanges(staged(), pkg)).toEqual(['pkg-axis']);
  });
});

async function judgedPrompt(dir: string): Promise<string> {
  const exec = mkExec(async () => 'VERDICT: PASS');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await runCompleteness(messageFile(dir, 'feat: retry policy'), dir, { exec });
  return JSON.stringify(exec.mock.calls[0]?.[0] ?? null);
}

describe('runCompleteness — Targets the commit changes', () => {
  const fixture = (staged: string): string => {
    const dir = consumerRepo({ backend: true });
    repo = dir;
    write('docs/decisions/kept.md', axis('kept', target('The old ruling.')));
    git('add', 'docs/decisions');
    git(
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-qm',
      'axis',
      '--',
      'docs/decisions',
    );
    write('docs/decisions/kept.md', axis('kept', staged));
    git('add', 'docs/decisions/kept.md');
    return dir;
  };

  it('moves a superseded Target out of the authority block into the NOT AUTHORITY note', async () => {
    const prompt = await judgedPrompt(
      fixture(`${target('The old ruling.')}\n${target('A false new claim.')}`),
    );
    expect(prompt).not.toContain('### kept');
    expect(prompt).toContain('NOT AUTHORITY: kept');
  });

  it('keeps a note-only append under the authority block with no NOT AUTHORITY note', async () => {
    const prompt = await judgedPrompt(fixture(`${target('The old ruling.')}- 2026-10-02 — note\n`));
    expect(prompt).toContain('### kept');
    expect(prompt).not.toContain('NOT AUTHORITY');
  });
});
