// sc-2478: a second agent restages the shared index right after the gate's freeze; every later
// read must still come from the frozen tree, never the live index.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freezeIndex } from '../../ratchets/git-index.mts';
import { judgeStagedIntegrity } from '../integrity/staged-gate.mts';

/** The real freeze, then a concurrent writer — the interleaving a live-index read cannot survive. */
function freezeThen(writer: () => void) {
  let ran = false;
  return {
    freeze: (root: string) => {
      const frozen = freezeIndex(root);
      writer();
      ran = true;
      return frozen;
    },
    ran: () => ran,
  };
}

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

const D = 'docs/decisions';

const target = (date: string, headline: string, evidenceChange = false) =>
  `## Target · ${date} — ${headline}\n\n` +
  '**Context:** c\n**Ruling:** r\n**Consequences:**\n- Positive: p\n- Negative: n\n' +
  '**Vision-fit:** n/a\n' +
  (evidenceChange ? '**Evidence-change:** what changed\n' : '') +
  '**Source:** collab\n';

const record = (blocks: string[]) =>
  `---\nslug: a\ncreated: 2026-01-01\n---\n\n# a\n\n${blocks.join('\n')}`;

const index = (updated: string) =>
  '# Decision Index\n\n| Axis | Current ruling | Why (hook) | Updated |\n' +
  '|------|----------------|------------|---------|\n' +
  `| [a](a.md) | r | w | ${updated} |\n`;

function stage(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(root, rel), content);
  git(root, 'add', '--', ...Object.keys(files));
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'devkit-integrity-race-'));
  cleanup.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  mkdirSync(join(root, D), { recursive: true });
  stage(root, {
    [`${D}/a.md`]: record([target('2026-01-01', 'one')]),
    [`${D}/INDEX.md`]: index('2026-01-01'),
  });
  git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'seed');
  return root;
}

describe('staged integrity under a concurrent git add', () => {
  it('passes the clean commit it froze even when the index is made stale mid-run', () => {
    const root = repo();
    const retargeted = record([target('2026-01-01', 'one'), target('2026-02-01', 'two', true)]);
    stage(root, { [`${D}/a.md`]: retargeted, [`${D}/INDEX.md`]: index('2026-02-01') });
    const concurrent = freezeThen(() => stage(root, { [`${D}/INDEX.md`]: index('2026-01-01') }));

    const verdict = judgeStagedIntegrity(root, concurrent.freeze);
    expect(concurrent.ran()).toBe(true);
    expect(verdict.scoped).toEqual(['a']);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.code).toBe(0);
  });

  it('blocks the defective commit it froze even when the index is repaired mid-run', () => {
    const root = repo();
    const retargeted = record([target('2026-01-01', 'one'), target('2026-02-01', 'two', true)]);
    stage(root, { [`${D}/a.md`]: retargeted });
    const concurrent = freezeThen(() => stage(root, { [`${D}/INDEX.md`]: index('2026-02-01') }));

    const verdict = judgeStagedIntegrity(root, concurrent.freeze);
    expect(concurrent.ran()).toBe(true);
    expect(verdict.code).toBe(1);
    expect(verdict.blocking.map((f) => f.check)).toContain('index-stale');
  });
});
