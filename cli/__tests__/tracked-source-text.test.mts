// git diffs a file it classifies binary as "Binary files differ", hiding every change from review.
// A literal NUL is the usual cause; its `\x00` escape keeps the same runtime string (sc-2285).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** Text sources only: a tracked image or font is binary by nature and is not this test's concern. */
const TEXT_SOURCES = [
  '*.mts',
  '*.ts',
  '*.mjs',
  '*.js',
  '*.cjs',
  '*.json',
  '*.md',
  '*.sh',
  '*.yml',
  '*.yaml',
];

// Generated copies of sc-2285's sources: stale until the release rebuilds dist/ and the
// self-upgrade sync rewrites the hook projections. Tolerated, not required — regenerated, they pass.
const STALE_UNTIL_REGENERATED = new Set([
  'dist/gate-engine/review/overrides.mjs',
  'dist/agents-hooks/decision-scope-brief.mjs',
  '.claude/hooks/decision-scope-brief.mjs',
  '.cursor/hooks/decision-scope-brief.mjs',
]);

/**
 * git's own verdict on the INDEX blob (`i/` column), never the worktree: the committed bytes are what
 * a reviewer diffs, and the index is unaffected by core.autocrlf or an unstaged edit.
 */
function indexEol(): { path: string; binary: boolean }[] {
  const out = execFileSync('git', ['-C', root, 'ls-files', '--eol', '-z', '--', ...TEXT_SOURCES], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return { path: line.slice(tab + 1), binary: line.startsWith('i/-text') };
    });
}

describe('tracked text sources', () => {
  it('are never classified binary by git, so their diffs stay reviewable', () => {
    const files = indexEol();
    const binary = files
      .filter((file) => file.binary && !STALE_UNTIL_REGENERATED.has(file.path))
      .map((file) => file.path);
    expect(binary).toEqual([]);
    // A walk over zero files would pass vacuously — pin that the pathspec actually matched.
    expect(files.length).toBeGreaterThan(500);
  });
});
