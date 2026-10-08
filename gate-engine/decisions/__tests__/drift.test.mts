import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findDrift, findPartialDrift, repoFiles, runDrift } from '../drift.mts';
import { resolveSupersession } from '../recall/supersession.mts';

/** A Target block with a Scope — the only shape drift cares about. */
const target = (slug: string, scope: string) => `---
slug: ${slug}
created: 2026-01-01
---

# ${slug}

## Target · 2026-01-01 — ${slug}

**Context:** forcing failure.
**Ruling:** the ruling.
**Consequences:**
- Positive: value.
- Negative: cost.
**Scope:** ${scope}
**Source:** manual
`;

describe('decision drift (scope no longer resolves)', () => {
  let root: string;
  let decisions: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dk-drift-'));
    decisions = join(root, 'docs', 'decisions');
    mkdirSync(decisions, { recursive: true });
    mkdirSync(join(root, 'src', 'live'), { recursive: true });
    writeFileSync(join(root, 'src', 'live', 'kept.mts'), 'export const a = 1;\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports an axis whose glob matches nothing, and stays silent for one that matches', () => {
    writeFileSync(join(decisions, 'alive.md'), target('alive', 'src/live/**'));
    writeFileSync(join(decisions, 'rotted.md'), target('rotted', 'src/moved-away/**'));

    const drifted = findDrift(root, decisions);
    expect(drifted.map((d) => d.slug)).toEqual(['rotted']);
    expect(drifted[0].globs).toEqual(['src/moved-away/**']);
  });

  // The real-world cause: the repo migrated .mjs -> .mts and every scope naming a .mjs file stopped
  // matching. The ruling is still correct and still readable; it is simply no longer loaded.
  it('catches the extension-migration case', () => {
    writeFileSync(join(decisions, 'migrated.md'), target('migrated', 'src/live/kept.mjs'));
    expect(findDrift(root, decisions).map((d) => d.slug)).toEqual(['migrated']);
  });

  // The other real cause, and the one that bit during this story: a file moved one directory down.
  it('catches the moved-file case, and goes green once the Scope is corrected', () => {
    const file = join(decisions, 'moved.md');
    writeFileSync(file, target('moved', 'src/kept.mts'));
    expect(findDrift(root, decisions)).toHaveLength(1);

    writeFileSync(file, target('moved', 'src/live/kept.mts')); // the fix a human would make
    expect(findDrift(root, decisions)).toEqual([]);
  });

  it('a partially-live scope list is NOT drift — the gate still fires on the live glob', () => {
    writeFileSync(join(decisions, 'partial.md'), target('partial', 'src/gone/**,src/live/**'));
    expect(findDrift(root, decisions)).toEqual([]);
  });

  // The `rescope` CLI verb's shape: an append-only note tagged `**Scope:**`, under the axis's
  // current section. drift resolves the EFFECTIVE scope (the rescope note, when present, over the
  // Target's own stale field) — the same resolution check-alignment's gate uses at commit time.
  it('a rescoped axis stops being reported by drift, and the original Target Scope survives untouched', () => {
    const file = join(decisions, 'rehomed.md');
    const original = target('rehomed', 'src/moved-away/**');
    writeFileSync(file, original);
    expect(findDrift(root, decisions).map((d) => d.slug)).toEqual(['rehomed']);

    const rescoped = `${original}- 2026-02-01 — **Scope:** src/live/** — directory renamed\n`;
    writeFileSync(file, rescoped);
    expect(findDrift(root, decisions)).toEqual([]);
    expect(runDrift(root, decisions)).toBe(0);

    // Append-only: the ORIGINAL Target's Scope line is still there, verbatim — a rescope never
    // rewrites the ruling, only adds a dated correction on top of it.
    const written = readFileSync(file, 'utf8');
    expect(written).toContain('**Scope:** src/moved-away/**');
    expect(written).toContain('- 2026-02-01 — **Scope:** src/live/** — directory renamed');
  });

  it('an axis with no Scope is out of scope for this check, not drifted', () => {
    const noScope = target('unscoped', 'x').replace(/^\*\*Scope:\*\*.*$/m, '');
    writeFileSync(join(decisions, 'unscoped.md'), noScope);
    expect(findDrift(root, decisions)).toEqual([]);
  });

  // Fail-open on a tree we cannot read: reporting every axis as drifted because the walk found
  // nothing would be a wall of false positives, which is how a gate gets switched off.
  it('concludes nothing when there are no files to match against', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dk-drift-empty-'));
    writeFileSync(join(decisions, 'rotted.md'), target('rotted', 'src/nope/**'));
    expect(findDrift(empty, decisions)).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });

  it('skips node_modules so a scope matching only vendored code still counts as drifted', () => {
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'x.mts'), 'export const x = 1;\n');
    expect(repoFiles(root).some((f) => f.includes('node_modules'))).toBe(false);

    writeFileSync(join(decisions, 'vendored.md'), target('vendored', 'node_modules/**'));
    expect(findDrift(root, decisions).map((d) => d.slug)).toEqual(['vendored']);
  });

  it('runDrift exits 1 on drift and 0 when clean', () => {
    writeFileSync(join(decisions, 'alive.md'), target('alive', 'src/live/**'));
    expect(runDrift(root, decisions)).toBe(0);

    writeFileSync(join(decisions, 'rotted.md'), target('rotted', 'src/gone/**'));
    expect(runDrift(root, decisions)).toBe(1);
  });

  // No generated hook judges a Target, so a drifted scope costs loading, not enforcement.
  it('reports a drifted ruling as no longer loaded by scope, never as no longer enforced', () => {
    writeFileSync(join(decisions, 'rotted.md'), target('rotted', 'src/gone/**'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    runDrift(root, decisions);
    const printed = error.mock.calls.flat().join('\n');
    error.mockRestore();
    expect(printed).toContain('NO LONGER LOADED BY SCOPE');
    expect(printed).not.toMatch(/enforced/i);
  });

  it('runDrift returns the could-not-run code for a missing root', () => {
    expect(runDrift(join(root, 'no-such-dir'), decisions)).toBe(2);
  });

  it('reports only the dead glob of a partially-live scope, and never a wholly dead axis twice', () => {
    writeFileSync(join(decisions, 'partial.md'), target('partial', 'src/gone.mts,src/live/**'));
    writeFileSync(join(decisions, 'rotted.md'), target('rotted', 'src/nope/**'));
    expect(findPartialDrift(root, decisions)).toEqual([
      { slug: 'partial', deadGlobs: ['src/gone.mts'] },
    ]);
    expect(findDrift(root, decisions).map((d) => d.slug)).toEqual(['rotted']);
  });

  // matchScope treats a bare directory name as an exact path, so it never covers the files inside.
  it('reports a bare directory glob as dead', () => {
    writeFileSync(join(decisions, 'bare.md'), target('bare', 'src/live,src/live/**'));
    expect(findPartialDrift(root, decisions)).toEqual([{ slug: 'bare', deadGlobs: ['src/live'] }]);
  });

  it('walks a dot-directory a scope names, and still skips the ones none name', () => {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'gate.yml'), 'on: push\n');
    mkdirSync(join(root, '.venv'), { recursive: true });
    writeFileSync(join(root, '.venv', 'x.py'), '\n');
    writeFileSync(join(decisions, 'ci.md'), target('ci', '.github/workflows/gate.yml,src/live/**'));
    expect(findPartialDrift(root, decisions)).toEqual([]);
    expect(repoFiles(root, undefined, new Set(['.github']))).not.toContain('.venv/x.py');
  });

  it('walks a dot-directory a scope names below the root, and a dot-file a glob names', () => {
    mkdirSync(join(root, 'src', '.storybook'), { recursive: true });
    writeFileSync(join(root, 'src', '.storybook', 'main.ts'), '\n');
    writeFileSync(join(root, 'src', '.env.example'), '\n');
    const scope = 'src/.storybook/**,src/.env.example,src/live/**';
    writeFileSync(join(decisions, 'nested.md'), target('nested', scope));
    expect(findPartialDrift(root, decisions)).toEqual([]);
  });

  // A walk cut short at the file cap never saw the rest of the tree, so it cannot call a glob dead.
  it('concludes no partial drift when the walk hit its file cap', () => {
    // Whichever top-level dir the walk reads first, the other glob was simply never reached.
    writeFileSync(join(decisions, 'capped.md'), target('capped', 'docs/**,src/**'));
    expect(findPartialDrift(root, decisions, 1)).toEqual([]);
    expect(findPartialDrift(root, decisions)).toEqual([]);
  });

  it('concludes no partial drift on an empty tree', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dk-drift-empty-'));
    writeFileSync(join(decisions, 'partial.md'), target('partial', 'src/gone.mts,src/live/**'));
    expect(findPartialDrift(empty, decisions)).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });

  it('prints partial drift as report-only: runDrift still exits 0', () => {
    writeFileSync(join(decisions, 'partial.md'), target('partial', 'src/gone.mts,src/live/**'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = runDrift(root, decisions);
    const printed = error.mock.calls.flat().join('\n');
    const logged = log.mock.calls.flat().join('\n');
    error.mockRestore();
    log.mockRestore();
    expect(code).toBe(0);
    expect(printed).toContain('Dead: src/gone.mts');
    expect(logged).not.toContain('✓');
  });
});

// A Target block with a Supersedes field — no Scope, since scope-glob rot is a separate axis of
// drift (findDrift above); these fixtures exercise only the new checks.
const supersedingTarget = (slug: string, date: string, ruling: string, supersedes?: string) => `---
slug: ${slug}
created: ${date}
---

# ${slug}

## Target · ${date} — ${ruling}

**Context:** forcing failure.
**Ruling:** ${ruling}
**Consequences:**
- Positive: value.
- Negative: cost.
${supersedes ? `**Supersedes:** ${supersedes}\n` : ''}**Source:** manual
`;

describe('decision drift (Supersedes resolution)', () => {
  let root: string;
  let decisions: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dk-drift-supersedes-'));
    decisions = join(root, 'docs', 'decisions');
    mkdirSync(decisions, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('an unresolvable Supersedes id is reported by drift', () => {
    writeFileSync(
      join(decisions, 'bad.md'),
      supersedingTarget('bad', '2026-06-14', 'r', 'nope#target:2026-06-13'),
    );
    expect(resolveSupersession(decisions).unresolved.map((u) => u.slug)).toEqual(['bad']);
    expect(runDrift(root, decisions)).toBe(1);
  });

  it('a cross-axis reference resolves and clears drift — the superseded axis is not treated as live', () => {
    writeFileSync(
      join(decisions, 'older.md'),
      supersedingTarget('older', '2026-06-13', 'via npx-skills'),
    );
    writeFileSync(
      join(decisions, 'newer.md'),
      supersedingTarget('newer', '2026-06-14', 'NOT npx-skills', 'older#target:2026-06-13'),
    );
    const { unresolved, supersededBy } = resolveSupersession(decisions);
    expect(unresolved).toEqual([]);
    expect(supersededBy.get('older')).toBe('newer#target:2026-06-14');
    expect(runDrift(root, decisions)).toBe(0);
  });

  // Ambiguity reports only where Supersedes is IN USE. Here the axis declares it on one block and
  // leaves an older one live alongside the newest — partial adoption, a genuine inconsistency.
  // An axis declaring it NOWHERE is the legacy positional case and is deliberately not flagged;
  // see the dedicated describe block below for why (it was a 100% false-positive rate).
  it('an axis that uses Supersedes but leaves a block dangling is flagged, and blocks drift', () => {
    // Partial adoption: the 2026-03-01 block retires 2026-01-01, but 2026-05-01 declares nothing,
    // so TWO blocks are live and the file cannot say which. That is a real inconsistency.
    const blk = (date: string, extra = '') =>
      `\n## Target \u00b7 ${date} \u2014 r${date}\n\n**Context:** c\n**Ruling:** r${date}\n` +
      `**Consequences:**\n- Positive: p\n- Negative: n\n${extra}**Source:** manual\n`;
    writeFileSync(
      join(decisions, 'ambiguous.md'),
      supersedingTarget('ambiguous', '2026-01-01', 'first') +
        blk('2026-03-01', '**Supersedes:** target:2026-01-01\n') +
        blk('2026-05-01'),
    );
    expect(resolveSupersession(decisions).multipleLive).toEqual([
      { slug: 'ambiguous', ids: ['target:2026-03-01', 'target:2026-05-01'] },
    ]);
    expect(runDrift(root, decisions)).toBe(1);
  });
});

// Scope globs are always authored repo-root-relative with forward slashes. A filesystem walk yields
// OS-native separators, so without normalization every scoped axis misreports as drifted on Windows.
describe('path separators', () => {
  it('emits forward-slash repo-relative paths regardless of platform', () => {
    const root = mkdtempSync(join(tmpdir(), 'dk-sep-'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'c.mts'), 'export const c = 1;\n');

    const files = repoFiles(root);
    expect(files).toContain('a/b/c.mts');
    expect(files.some((f) => f.includes('\\'))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

// Every axis predating the Supersedes field has several Target blocks and declares none; the rule
// for those is positional (last block current). Flagging them reported 5 of 5 multi-Target axes on
// the real corpus — a 100% false-positive rate, which is how a check gets switched off for good.
describe('supersession ambiguity only applies where the field is in use', () => {
  let root: string;
  let decisions: string;
  const twoTargets = (slug: string, second: string) => `---
slug: ${slug}
created: 2026-01-01
---

# ${slug}

## Target · 2026-01-01 — first

**Context:** c.
**Ruling:** first ruling.
**Scope:** src/live/**

## Target · 2026-02-01 — second

**Context:** c.
**Ruling:** second ruling.
${second}**Scope:** src/live/**
`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dk-amb-'));
    decisions = join(root, 'docs', 'decisions');
    mkdirSync(decisions, { recursive: true });
    mkdirSync(join(root, 'src', 'live'), { recursive: true });
    writeFileSync(join(root, 'src', 'live', 'k.mts'), 'export const k = 1;\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a legacy axis declaring no Supersedes is NOT ambiguous', () => {
    writeFileSync(join(decisions, 'legacy.md'), twoTargets('legacy', ''));
    expect(runDrift(root, decisions)).toBe(0);
  });
});

// Two Target blocks CAN share a date (the real corpus has fallow-gate-owned-by-fallow with two
// dated 2026-07-25). With a bare `target:<date>` id both blocks answer to one name, so a block's
// Supersedes could resolve to ITSELF: the live ruling reads as superseded by itself, the live set
// collapses to zero, the >1 ambiguity guard never fires, and drift exits 0 on the exact corruption
// it exists to catch.
describe('same-day Target blocks get distinct ids', () => {
  let root: string;
  let decisions: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dk-sameday-'));
    decisions = join(root, 'docs', 'decisions');
    mkdirSync(decisions, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const blk = (date: string, extra = '') =>
    `\n## Target · ${date} — r\n\n**Context:** c\n**Ruling:** r\n` +
    `**Consequences:**\n- Positive: p\n- Negative: n\n${extra}**Source:** manual\n`;

  it('the second block on a date is addressable, and superseding it is not self-reference', () => {
    writeFileSync(
      join(decisions, 'sameday.md'),
      supersedingTarget('sameday', '2026-07-25', 'first') +
        blk('2026-07-25', '**Supersedes:** target:2026-07-25\n'),
    );
    const { unresolved, multipleLive, supersededBy } = resolveSupersession(decisions);
    // The 2nd block retires the 1st. It must NOT be recorded as superseding itself.
    expect(unresolved).toEqual([]);
    expect(multipleLive).toEqual([]);
    expect(supersededBy.get('sameday')).toBeNull(); // the newest block is live
    expect(runDrift(root, decisions)).toBe(0);
  });

  it('a reference to the ~2 occurrence resolves rather than reading as dangling', () => {
    writeFileSync(
      join(decisions, 'a.md'),
      supersedingTarget('a', '2026-07-25', 'first') + blk('2026-07-25'),
    );
    writeFileSync(
      join(decisions, 'b.md'),
      supersedingTarget('b', '2026-08-01', 'newer', 'a#target:2026-07-25~2'),
    );
    expect(resolveSupersession(decisions).unresolved).toEqual([]);
  });
});
