import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ancestorDirs, collectGoverningClaudeMd, renderGoverningClaudeMd } from '../claude-md.mts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), 'claude-md-'));
  dirs.push(r);
  return r;
}

describe('ancestorDirs — pure ordering', () => {
  it('a root-level file has only the repo root as its ancestor', () => {
    expect(ancestorDirs('README.md')).toEqual(['']);
  });

  it('a nested file returns every level, root FIRST, its own dir LAST', () => {
    expect(ancestorDirs('packages/foo/src/bar.ts')).toEqual([
      '',
      'packages',
      'packages/foo',
      'packages/foo/src',
    ]);
  });

  it('a leading slash never produces a spurious empty segment', () => {
    expect(ancestorDirs('/packages/foo/bar.ts')).toEqual(['', 'packages', 'packages/foo']);
  });

  it('an empty string (boundary input git would never actually stage) degrades to just the repo root, never throws', () => {
    expect(ancestorDirs('')).toEqual(['']);
  });
});

describe('collectGoverningClaudeMd — repo-tracked scoping', () => {
  it('collects the root CLAUDE.md for a root-level file', () => {
    const r = repo();
    writeFileSync(join(r, 'CLAUDE.md'), '# root rules');
    expect(collectGoverningClaudeMd(r, 'a.ts')).toEqual([
      { path: 'CLAUDE.md', scope: '', content: '# root rules' },
    ]);
  });

  it('a file with no governing CLAUDE.md anywhere returns empty', () => {
    const r = repo();
    expect(collectGoverningClaudeMd(r, 'a.ts')).toEqual([]);
  });

  it('root + nested BOTH apply, root first — never stops at the first hit', () => {
    const r = repo();
    mkdirSync(join(r, 'packages', 'foo'), { recursive: true });
    writeFileSync(join(r, 'CLAUDE.md'), '# root rules');
    writeFileSync(join(r, 'packages', 'foo', 'CLAUDE.md'), '# foo rules');
    const out = collectGoverningClaudeMd(r, 'packages/foo/src/bar.ts');
    expect(out.map((f) => f.path)).toEqual(['CLAUDE.md', 'packages/foo/CLAUDE.md']);
    expect(out[0].content).toBe('# root rules');
    expect(out[1].content).toBe('# foo rules');
    expect(out[1].scope).toBe('packages/foo');
  });

  it('a SIBLING directory CLAUDE.md never governs a file under a different directory (the AC scoping requirement)', () => {
    const r = repo();
    mkdirSync(join(r, 'packages', 'foo'), { recursive: true });
    mkdirSync(join(r, 'packages', 'bar'), { recursive: true });
    writeFileSync(join(r, 'packages', 'foo', 'CLAUDE.md'), '# foo-only rules');
    const out = collectGoverningClaudeMd(r, 'packages/bar/baz.ts');
    expect(out).toEqual([]);
  });

  it('never reads $HOME — a decoy CLAUDE.md at the process HOME must never appear', () => {
    const r = repo();
    const home = repo(); // a second tmpdir standing in for $HOME
    writeFileSync(
      join(home, 'CLAUDE.md'),
      '# personal global rules — must never leak into the gate',
    );
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(collectGoverningClaudeMd(r, 'a.ts')).toEqual([]);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  // Cross-platform correctness, not just cosmetic: macOS/Windows filesystems are case-insensitive
  // by default, so a naive `existsSync(".../CLAUDE.md")` matches a file actually named
  // `claude.md` on those platforms but NOT on case-sensitive Linux (most CI runners, most prod
  // containers) — the SAME repo would silently gate differently depending on which OS ran it.
  // `collectGoverningClaudeMd` lists the directory and compares the exact string instead, so this
  // must hold identically regardless of the test machine's own filesystem case sensitivity.
  it('a lowercase claude.md is NEVER recognized — exact case only, deterministic on every OS', () => {
    const r = repo();
    writeFileSync(join(r, 'claude.md'), '# lowercase — must not count as CLAUDE.md');
    expect(collectGoverningClaudeMd(r, 'a.ts')).toEqual([]);
  });

  it('a directory literally named CLAUDE.md (pathological) is skipped, never crashes', () => {
    const r = repo();
    mkdirSync(join(r, 'CLAUDE.md'), { recursive: true }); // a directory, not a file
    expect(() => collectGoverningClaudeMd(r, 'a.ts')).not.toThrow();
    expect(collectGoverningClaudeMd(r, 'a.ts')).toEqual([]);
  });

  it('staging CLAUDE.md itself is governed by itself — self-reference is sane, not a crash', () => {
    const r = repo();
    writeFileSync(join(r, 'CLAUDE.md'), '# rules, currently being edited');
    expect(collectGoverningClaudeMd(r, 'CLAUDE.md')).toEqual([
      { path: 'CLAUDE.md', scope: '', content: '# rules, currently being edited' },
    ]);
  });
});

describe('renderGoverningClaudeMd — dedupe + capped rendering', () => {
  it('no governing files renders an explicit none-found note, never a blank/silent block', () => {
    const r = repo();
    expect(renderGoverningClaudeMd(r, ['a.ts'])).toContain('none found');
  });

  it('dedupes a shared governing file across many staged files into ONE rendered block', () => {
    const r = repo();
    writeFileSync(join(r, 'CLAUDE.md'), '# root rules');
    const out = renderGoverningClaudeMd(r, ['a.ts', 'b.ts', 'sub/c.ts']);
    expect(out.match(/# root rules/g)?.length).toBe(1);
    expect(out).toContain('CLAUDE.md (scope: (repo root — governs everything))');
  });

  it("states each file's own scope so nested rules are never mistaken for repo-wide", () => {
    const r = repo();
    mkdirSync(join(r, 'packages', 'foo'), { recursive: true });
    writeFileSync(join(r, 'packages', 'foo', 'CLAUDE.md'), '# foo rules');
    const out = renderGoverningClaudeMd(r, ['packages/foo/x.ts']);
    expect(out).toContain('packages/foo/CLAUDE.md (scope: packages/foo)');
  });

  it('a huge governing file is capped + named, never silently truncated without a marker', () => {
    const r = repo();
    writeFileSync(join(r, 'CLAUDE.md'), '# root\n'.repeat(20000)); // well past the segment cap
    const out = renderGoverningClaudeMd(r, ['a.ts']);
    expect(out).toContain('[TRUNCATED: CLAUDE.md');
    expect(out).toContain('Read `CLAUDE.md` directly');
  });

  it('an EMPTY file list (boundary: selectReviewers never calls this with zero files, but the function must not misbehave if something else does) renders the same none-found note', () => {
    const r = repo();
    writeFileSync(join(r, 'CLAUDE.md'), '# root rules');
    expect(renderGoverningClaudeMd(r, [])).toContain('none found');
  });

  it('many SMALL governing files that collectively exceed the total budget OMIT the later ones by name — not just one huge file truncated', () => {
    const r = repo();
    // 8 packages × 9KB each = 72KB > the 60KB total cap, each individually well under the 12KB
    // per-segment cap. The greedy budget fills files 0-5 whole, straddles one boundary file with
    // an ordinary TRUNCATE, then OMITS everything after — proving OMISSION triggers from many
    // small files exhausting the shared budget, not only from one oversized file (the other test
    // above), and that later files are named, never silently dropped.
    const files: string[] = [];
    for (let i = 0; i < 8; i++) {
      mkdirSync(join(r, `pkg${i}`), { recursive: true });
      writeFileSync(join(r, `pkg${i}`, 'CLAUDE.md'), `# pkg${i} rule\n`.repeat(750));
      files.push(`pkg${i}/x.ts`);
    }
    const out = renderGoverningClaudeMd(r, files);
    expect(out).toContain('OMITTED: pkg7/CLAUDE.md');
    expect(out).toContain('Read `pkg7/CLAUDE.md` directly');
    // the first file rides in full — the budget is exhausted in FILE ORDER, not applied blindly
    expect(out).toContain('# pkg0 rule');
    expect(out).not.toContain('OMITTED: pkg0/CLAUDE.md');
  });
});
