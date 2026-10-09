/**
 * The decisions skill's "Which gates read scoped Targets" table is the one place an agent learns which
 * code loads scoped Targets and in which hook it runs. This pins it to the loader calls and both hooks.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUARD_IDS } from '../lib/components.mts';
import { buildCommitMsgBlock } from '../lib/husky/commit-msg-block.mts';
import { buildGuardBlock } from '../lib/husky/husky-block.mts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = 'skills/decisions/SKILL.md';
const SOURCE_DIRS = ['gate-engine', 'cli', 'agents-hooks'];
const SOURCE_RE = /\.(mts|mjs|ts|js)$/;
const SKIP_RE = /(^|\/)(__tests__|eval|node_modules)\/|\.test\./;
const LOADER_RE =
  /\b(?:scopedTargets|loadScopedTargets|loadReviewerTargetsBlocks)\(|\['scoped-targets'/;
const STAGES = ['pre-edit', 'pre-commit', 'commit-msg', 'on-demand'] as const;
const STAGE_RE = new RegExp(`\\b(${STAGES.join('|')})\\b`, 'g');
const ROW_RE = /^\| `([^`]+)` \| ([^|]+) \| `([^`]+)` \|/;

interface ReaderRow {
  file: string;
  stages: string[];
  call: string;
}

/** Both generated hooks, every guard selected, quotes dropped so `"$dir/guard-x" y` reads as a call. */
const HOOKS = {
  'pre-commit': buildGuardBlock({ guards: GUARD_IDS }).replaceAll('"', ''),
  'commit-msg': (buildCommitMsgBlock({ guards: GUARD_IDS }) ?? '').replaceAll('"', ''),
};

/** True when `source` loads scoped Targets: calls a loader, or spawns the `scoped-targets` subcommand. */
function readsScopedTargets(source: string): boolean {
  return LOADER_RE.test(source);
}

/** Repo-relative non-test source files under the gate, CLI and agent-hook roots that load Targets. */
function loaderFiles(): string[] {
  return SOURCE_DIRS.flatMap((dir) =>
    readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
      .map((rel) => `${dir}/${rel}`)
      .filter((rel) => SOURCE_RE.test(rel) && !SKIP_RE.test(rel))
      .filter((rel) => readsScopedTargets(readFileSync(join(ROOT, rel), 'utf8'))),
  ).sort();
}

/** The table rows; a row naming no known stage throws, so a typo cannot read as "runs nowhere". */
function parseReaderTable(markdown: string): ReaderRow[] {
  const section = markdown.split('## Which gates read scoped Targets')[1]?.split('\n## ')[0] ?? '';
  return section.split('\n').flatMap((line) => {
    const match = ROW_RE.exec(line);
    if (!match) return [];
    const [, file, stageCell, call] = match;
    const stages = [...stageCell.matchAll(STAGE_RE)].map((m) => m[1]);
    if (!stages.length) throw new Error(`${file}: no stage among ${STAGES.join(', ')}`);
    return [{ file, stages, call }];
  });
}

const ROWS = parseReaderTable(readFileSync(join(ROOT, SKILL), 'utf8'));

describe('the scoped-Target reader table', () => {
  it('detects a loader call and a scoped-targets spawn, and ignores a mention', () => {
    expect(readsScopedTargets('const t = await scopedTargets(files, q, 6);')).toBe(true);
    expect(readsScopedTargets("spawnSync(bin, ['scoped-targets', '--files', rel])")).toBe(true);
    expect(readsScopedTargets("'scoped-targets': new URL('./scoped-targets.mts')")).toBe(false);
  });

  it('rejects a row whose stage is not a known stage', () => {
    const doc = '## Which gates read scoped Targets\n| `a.mts` | pre-push | `guard-x` | no |\n';
    expect(() => parseReaderTable(doc)).toThrow('a.mts: no stage');
  });

  it('lists exactly the files that load scoped Targets', () => {
    expect(ROWS.map((row) => row.file).sort()).toEqual(loaderFiles());
  });

  it.each(Object.entries(HOOKS))(
    'names %s for exactly the readers that hook runs',
    (hook, block) => {
      expect(block).not.toBe('');
      const mismatched = ROWS.filter(
        (row) => block.includes(row.call) !== row.stages.includes(hook),
      );
      expect(mismatched.map((row) => `${row.file}: ${row.call}`)).toEqual([]);
    },
  );
});
