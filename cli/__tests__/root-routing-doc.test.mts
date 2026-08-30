/**
 * Mechanism coverage (ancestor walk, case-exactness, capping) lives in
 * gate-engine/review/__tests__/claude-md.test.mts; this suite covers devkit's OWN root docs.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  collectGoverningClaudeMd,
  renderGoverningClaudeMd,
} from '../../gate-engine/review/claude-md.mts';
import {
  referencedRepoPathCandidates,
  resolvesCaseExact,
} from '../../gate-engine/markdown/referenced-paths.mts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ROUTING_DOCS = ['CLAUDE.md', 'AGENTS.md'] as const;

/** The KEYWORD arm of conventions-reviewer's bar (agents/conventions-reviewer.md:34-35). Its other
 * arm — a flat imperative like "use X, not Y" — has no mechanical detector here. */
const DIRECTIVE_RE = /\b(?:must|never|always|required|forbidden)\b/i;

/** CLAUDE_MD_SEGMENT_CAP in gate-engine/review/claude-md.mts — past it the routing tail is cut
 * before the judge reads it. */
const SEGMENT_CAP = 12_000;

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const tmp: string[] = [];
afterAll(() => {
  for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('root routing docs exist with the exact filename each harness looks for', () => {
  const rootEntries = readdirSync(ROOT);

  it.each(ROUTING_DOCS)('%s is present at the repo root, exact case', (doc) => {
    expect(rootEntries).toContain(doc);
  });
});

describe('every path the routing docs name still resolves', () => {
  it.each(ROUTING_DOCS)('%s names no dangling path', (doc) => {
    const dangling = referencedRepoPathCandidates(read(doc)).filter(
      (path) => !resolvesCaseExact(ROOT, path),
    );
    expect(dangling, `${doc} names paths that do not resolve from the repo root`).toEqual([]);
  });

  it('CLAUDE.md names enough paths for that check to mean something', () => {
    expect(referencedRepoPathCandidates(read('CLAUDE.md')).length).toBeGreaterThanOrEqual(10);
  });
});

describe('the routing docs stay descriptive, so the conventions gate stays quiet', () => {
  it.each(ROUTING_DOCS)('%s carries no unhedged directive keyword', (doc) => {
    const offenders = read(doc)
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => DIRECTIVE_RE.test(text));
    expect(
      offenders,
      `${doc} is fed to conventions-reviewer as governing rules; an unhedged directive here can ` +
        'block any commit in this repo. Paraphrase rather than quoting a ruling verbatim.',
    ).toEqual([]);
  });

  it('the directive scan is case-insensitive and word-bounded', () => {
    expect(DIRECTIVE_RE.test('- **MUST run impact analysis before editing any symbol.**')).toBe(
      true,
    );
    expect(DIRECTIVE_RE.test('this must be recorded')).toBe(true);
    expect(DIRECTIVE_RE.test('Always regenerate the hook')).toBe(true);
    expect(DIRECTIVE_RE.test('mustard and nevertheless and alwaysOn')).toBe(false);
  });

  it('the directive scan exempts neither fenced blocks nor block quotes', () => {
    // conventions-reviewer reads the whole file, so a directive quoted from a decision record is
    // as quotable against a diff as one written natively.
    expect(DIRECTIVE_RE.test('```\nrecords are never hand-edited\n```')).toBe(true);
    expect(DIRECTIVE_RE.test('> **Ruling:** paths must resolve consumer-cwd-relative')).toBe(true);
  });

  it.each(ROUTING_DOCS)('%s uses no numbered <rule id= markers', (doc) => {
    expect(read(doc)).not.toContain('<rule id=');
  });
});

describe('CLAUDE.md still carries the routing content it exists to carry', () => {
  const claudeMd = (): string => read('CLAUDE.md');

  it('names the decisions directory as the store and INDEX.md as a derived view', () => {
    const text = claudeMd();
    expect(text).toContain('docs/decisions/');
    expect(text).toContain('docs/decisions/INDEX.md');
    expect(text).toMatch(/derived|view/i);
    expect(text).toContain('docs/decisions/decision-retrieval-candidate-set.md');
  });

  it('gives a runnable retrieval command for this repo', () => {
    expect(claudeMd()).toContain('node gate-engine/decisions/cli.mts query');
    expect(claudeMd()).toContain('node gate-engine/decisions/cli.mts show');
  });

  it('states the record shape and where records are written', () => {
    const text = claudeMd();
    for (const field of ['Context', 'Ruling', 'Consequences', 'Vision-fit', 'Scope']) {
      expect(text, `record shape lost the ${field} field`).toContain(field);
    }
    expect(text).toContain('skills/decisions/SKILL.md');
  });

  it('keeps each load-bearing premise tied to a source a reader can open', () => {
    // Each premise is a claim an incoming agent cannot infer from one file, so each carries the
    // file or record that substantiates it — a premise without its source is the drift this guards.
    const text = claudeMd();
    for (const source of [
      'guard.config.json',
      'cli/lib/fs-helpers.mts',
      'docs/decisions/synced-assets-layout-agnostic.md',
      'docs/decisions/devkit-gates-repo-not-harness.md',
      'docs/decisions/devkit-self-dogfood.md',
      'docs/decisions/published-version-tags-immutable.md',
    ]) {
      expect(text, `premise source ${source} is no longer cited`).toContain(source);
    }
  });

  it('states both halves of W-3, not just the consumer-cwd half', () => {
    // The half-stated form shipped once and was caught in review: packageDir() resolves devkit's
    // own templates/ and skills/ from import.meta.url, never the consumer cwd.
    const text = claudeMd();
    expect(text).toMatch(/consumer'?s cwd/i);
    expect(text).toContain('packageDir()');
    expect(text).toContain('import.meta.url');
  });
});

describe('CLAUDE.md and AGENTS.md stay one canonical doc plus one pointer', () => {
  it('AGENTS.md points at CLAUDE.md', () => {
    expect(read('AGENTS.md')).toContain('CLAUDE.md');
  });

  it('AGENTS.md is a pointer, not a second copy that can drift', () => {
    const canonical = read('CLAUDE.md');
    const pointer = read('AGENTS.md');
    expect(pointer).not.toEqual(canonical);
    expect(pointer.length).toBeLessThan(canonical.length / 2);
  });

  it('CLAUDE.md fits inside the judge segment cap, uncut', () => {
    expect(read('CLAUDE.md').length).toBeLessThan(SEGMENT_CAP);
  });
});

describe('wiring: devkit files now have a governing CLAUDE.md', () => {
  // Seeded into a throwaway repo with the REAL docs, staged: collectGoverningClaudeMd reads the
  // stage-0 blob, so asserting against this checkout would only measure local git state.
  function stagedCopyOfTheRealDocs(): string {
    const r = mkdtempSync(join(tmpdir(), 'routing-doc-'));
    tmp.push(r);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: r, stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q');
    for (const doc of ROUTING_DOCS) writeFileSync(join(r, doc), read(doc));
    mkdirSync(join(r, 'cli'), { recursive: true });
    writeFileSync(join(r, 'cli', 'index.mts'), 'export {};\n');
    git('add', '-A');
    return r;
  }

  it('a source file under a review root collects exactly the root doc', () => {
    const governing = collectGoverningClaudeMd(stagedCopyOfTheRealDocs(), 'cli/index.mts');
    expect(governing.map((g) => g.path)).toEqual(['CLAUDE.md']);
    expect(governing[0]?.scope).toBe('');
    expect(governing[0]?.content).toBe(read('CLAUDE.md'));
  });

  it('the rendered brief stops claiming no governing file exists', () => {
    const rendered = renderGoverningClaudeMd(stagedCopyOfTheRealDocs(), ['cli/index.mts']);
    expect(rendered).not.toContain('none found');
    expect(rendered).toContain('CLAUDE.md');
    expect(rendered).toContain('repo root — governs everything');
  });

  it('AGENTS.md is not picked up as a governing rule surface', () => {
    // Only CLAUDE.md is probed, which is why the pointer needs no directive budget of its own.
    const rendered = renderGoverningClaudeMd(stagedCopyOfTheRealDocs(), ['cli/index.mts']);
    expect(rendered).not.toContain('AGENTS.md');
  });
});
