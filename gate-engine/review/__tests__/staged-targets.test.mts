/**
 * A Target the staged diff adds or changes is a claim under review, so the completeness judge must
 * get it as a named note rather than inside its authority block.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wrapCompleteness } from '../completeness.mts';
import {
  renderChangedTargets,
  renderTargets,
  stagedTargetChanges,
} from '../evidence/targets-block.mts';

const target = (ruling: string): string =>
  `## Target · 2026-10-01 — Heading\n\n**Context:** c\n**Ruling:** ${ruling}\n**Consequences:**\n- Positive: p\n`;
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

  it('resolves the decisions dir from a package subdirectory against toplevel-relative paths', () => {
    const pkg = path.join(repo, 'packages/app');
    write('packages/app/guard.config.json', JSON.stringify({ decisionsDir: 'adr' }));
    write('packages/app/adr/pkg-axis.md', axis('pkg-axis', target('Package claim.')));
    git('add', '.');
    expect(stagedTargetChanges(staged(), pkg)).toEqual(['pkg-axis']);
  });
});

describe('completeness prompt with a changed Target', () => {
  it('keeps the changed Target out of the authority block and names it in its own note', () => {
    const block = renderTargets([]) + renderChangedTargets(['fresh']);
    const prompt = wrapCompleteness('brief', 'feat: x', ['docs/decisions/fresh.md'], block);
    expect(prompt).toContain('## RELEVANT RECORDED TARGETS — SKIP');
    expect(prompt).not.toContain('### fresh');
    expect(prompt).toContain('## TARGETS THIS DIFF ADDS OR CHANGES — NOT AUTHORITY: fresh');
    expect(prompt).toContain('report the Target, not the files that disagree with it');
  });
});
