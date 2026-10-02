import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { conventionWaiverLens, parseConventionFindings } from '../evidence/conventions.mts';
import { responseContractFor } from '../contracts/registry.mts';
import type { GroundingSource } from '../contracts/conventions-grounding.mts';
import { applyOverrideValve, fingerprint, reconcile } from '../overrides.mts';
import { REVIEWERS, type Reviewer, type ReviewerSelection } from '../reviewers.mts';
import type { ReviewOutcome } from '../runtime.mts';

// sc-3324: the model re-anchors the SAME finding on a different line run-to-run (observed :668,
// :605, :603, :606 on one unchanged diff), so the waiver lens must not carry the offending line.

const transcript = (rule: string, offending: string) =>
  `VIOLATION: ${rule}\nOFFENDING: ${offending}\nVERDICT: FAIL — cited rule`;

const lensOf = (raw: string) => parseConventionFindings(raw).map(conventionWaiverLens);

const SIZE_RULE = 'Keep files under 500 lines. — CLAUDE.md:12';

describe('conventionWaiverLens', () => {
  it('is the same when only the offending anchor line and its quote drift', () => {
    const run1 = lensOf(transcript(SIZE_RULE, 'export function a() { — src/flows.ts:668'));
    const run2 = lensOf(transcript(SIZE_RULE, 'const b = 1; — src/flows.ts:605'));
    expect(run1).toHaveLength(1);
    expect(run2).toEqual(run1);
    const fpOf = (lenses: string[]) =>
      lenses.map((lens) => fingerprint('conventions-reviewer', lens, 'DIFF'));
    expect(fpOf(run2)).toEqual(fpOf(run1));
  });

  it('differs for a different rule on the same file', () => {
    const a = lensOf(transcript(SIZE_RULE, 'x — src/flows.ts:10'));
    const b = lensOf(transcript('Never use console.log. — CLAUDE.md:20', 'x — src/flows.ts:10'));
    expect(a).not.toEqual(b);
  });

  it('differs for the same rule in a different file', () => {
    const a = lensOf(transcript(SIZE_RULE, 'x — src/a.ts:10'));
    const b = lensOf(transcript(SIZE_RULE, 'x — src/b.ts:10'));
    expect(a).not.toEqual(b);
  });

  it('differs for the same rule line in a different CLAUDE.md', () => {
    const a = lensOf(transcript('rule — CLAUDE.md:12', 'x — src/a.ts:10'));
    const b = lensOf(transcript('rule — packages/ui/CLAUDE.md:12', 'x — src/a.ts:10'));
    expect(a).not.toEqual(b);
  });

  it('keeps two lineless rules from the same CLAUDE.md distinct', () => {
    const a = lensOf(
      transcript('Components must not accept className. — CLAUDE.md', 'x — a.tsx:1'),
    );
    const b = lensOf(transcript('Components must be default exports. — CLAUDE.md', 'x — a.tsx:1'));
    expect(a).toHaveLength(1);
    expect(a).not.toEqual(b);
  });

  it('keys a lineless rule on its text, not its whitespace or casing', () => {
    const a = lensOf(
      transcript('Components must not accept className. — CLAUDE.md', 'x — a.tsx:1'),
    );
    const b = lensOf(
      transcript('components   must NOT accept className. — CLAUDE.md', 'y — a.tsx:9'),
    );
    expect(b).toEqual(a);
  });

  it('ignores the free-text parenthetical the model attaches to a rule location', () => {
    // Observed shape: `CLAUDE.md (repo root):2-3`. The parenthetical is model prose that can vary
    // between runs; the rule's file and line are the identity.
    const a = lensOf(transcript('rule — CLAUDE.md (repo root):2-3', 'x — src/a.ts:4'));
    const b = lensOf(transcript('rule — CLAUDE.md (root):2', 'x — src/a.ts:9'));
    expect(b).toEqual(a);
  });

  it('keys every backtick + parenthetical decoration of one rule location identically', () => {
    const lens = (loc: string) => lensOf(transcript(`rule — ${loc}`, 'x — src/a.ts:4'));
    const plain = lens('CLAUDE.md:2');
    for (const loc of [
      'CLAUDE.md (repo root):2',
      '`CLAUDE.md`:2',
      '`CLAUDE.md` (repo root):2',
      '`CLAUDE.md (repo root)`:2',
      'CLAUDE.md (`repo root`):2',
      '`./CLAUDE.md` (root):2',
    ])
      expect(lens(loc)).toEqual(plain);
  });

  it('is shell-safe for rule locations carrying spaces and parentheses', () => {
    for (const rule of ['rule — CLAUDE.md (repo root):2', 'rule text here — CLAUDE.md (section)']) {
      const [lens] = lensOf(transcript(rule, 'x — src/a.ts:4'));
      expect(lens).toMatch(/^[\w@./:#+-]+$/);
    }
  });

  it('treats a Windows-separated or ./-prefixed rule file as the same CLAUDE.md', () => {
    const a = lensOf(transcript('rule — docs/CLAUDE.md:3', 'x — src/a.ts:4'));
    const b = lensOf(transcript('rule — docs\\CLAUDE.md:3', 'x — src/a.ts:40'));
    const c = lensOf(transcript('rule — ./docs/CLAUDE.md:3', 'x — src/a.ts:7'));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('canonicalizes OFFENDING spellings of one file on the ungrounded fallback path too', () => {
    const a = lensOf(transcript(SIZE_RULE, 'x — src/a.ts:4'));
    expect(lensOf(transcript(SIZE_RULE, 'x — ./src/a.ts:9'))).toEqual(a);
    expect(lensOf(transcript(SIZE_RULE, 'x — src\\a.ts:9'))).toEqual(a);
    expect(lensOf(transcript(SIZE_RULE, 'x — `src/a.ts`:9'))).toEqual(a);
  });

  it('never drops an interior backtick — `src/`a`.ts` is another file than `src/a.ts`', () => {
    const a = lensOf(transcript(SIZE_RULE, 'x — src/a.ts:4'));
    expect(lensOf(transcript(SIZE_RULE, 'x — src/`a`.ts:4'))).not.toEqual(a);
    const rule = (loc: string) => lensOf(transcript(`rule — ${loc}`, 'x — src/a.ts:4'));
    expect(rule('d`x`/CLAUDE.md:2')).not.toEqual(rule('dx/CLAUDE.md:2'));
  });

  it('never strips a parenthetical from the OFFENDING path — `a (copy).ts` is another file', () => {
    const a = lensOf(transcript(SIZE_RULE, 'x — src/a.ts:4'));
    const b = lensOf(transcript(SIZE_RULE, 'x — src/a (copy).ts:4'));
    expect(b).not.toEqual(a);
  });

  it('keeps a rule-line range keyed on its start line', () => {
    const a = lensOf(transcript('rule — CLAUDE.md:3-4', 'x — src/a.ts:4'));
    const b = lensOf(transcript('rule — CLAUDE.md:3', 'x — src/a.ts:8'));
    expect(b).toEqual(a);
  });

  it('round-trips through the waive CLI target split on the first colon', async () => {
    const { parseWaiveTarget } = await import('../valve/waive.mts');
    const [lens] = lensOf(transcript('rule — CLAUDE.md (repo root):2', 'x — src/a.ts:4'));
    expect(parseWaiveTarget(`conventions-reviewer:${lens}`)).toEqual({
      reviewer: 'conventions-reviewer',
      lens,
    });
  });
});

describe('conventions blockingLenses contract (grounded, registry wiring)', () => {
  const contract = responseContractFor('conventions-v1');
  // A new 50-line file wholly added by the change, so every quote below grounds at its cited line.
  const lines = Array.from({ length: 50 }, (_, i) => `const v${i + 1} = ${i + 1};`);
  const source: GroundingSource = {
    reviewedFiles: ['src/flows.ts'],
    readStaged: (f) => (f === 'src/flows.ts' ? `${lines.join('\n')}\n` : null),
    readHead: () => null,
    readDiff: (f) =>
      f === 'src/flows.ts'
        ? [
            'diff --git a/src/flows.ts b/src/flows.ts',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/src/flows.ts',
            `@@ -0,0 +1,${lines.length} @@`,
            ...lines.map((l) => `+${l}`),
            '',
          ].join('\n')
        : '',
  };
  const lensesFor = (raw: string) => contract?.blockingLenses(raw, source) ?? [];

  it('emits the line-free lens, identical across runs that anchor on different lines', () => {
    const run1 = lensesFor(transcript(SIZE_RULE, 'const v10 = 10; — src/flows.ts:10'));
    const run2 = lensesFor(transcript(SIZE_RULE, 'const v40 = 40; — src/flows.ts:40'));
    expect(run1).toEqual(['src/flows.ts@CLAUDE.md:12']);
    expect(run2).toEqual(run1);
  });

  it('folds two grounded same-rule findings in one file into ONE blocking lens', () => {
    const raw =
      `VIOLATION: ${SIZE_RULE}\nOFFENDING: const v10 = 10; — src/flows.ts:10\n` +
      `VIOLATION: ${SIZE_RULE}\nOFFENDING: const v40 = 40; — src/flows.ts:40\n` +
      'VERDICT: FAIL — size';
    expect(lensesFor(raw)).toEqual(['src/flows.ts@CLAUDE.md:12']);
  });

  it('keeps two different rules that cite the SAME offending path:line as two lenses', () => {
    const raw =
      `VIOLATION: ${SIZE_RULE}\nOFFENDING: const v10 = 10; — src/flows.ts:10\n` +
      'VIOLATION: Never use console.log. — CLAUDE.md:20\nOFFENDING: const v10 = 10; — src/flows.ts:10\n' +
      'VERDICT: FAIL — two rules';
    expect(lensesFor(raw)).toEqual(['src/flows.ts@CLAUDE.md:12', 'src/flows.ts@CLAUDE.md:20']);
  });

  it('keys ./-prefixed and Windows-separated OFFENDING spellings of one file identically', () => {
    const canonical = lensesFor(transcript(SIZE_RULE, 'const v10 = 10; — src/flows.ts:10'));
    expect(lensesFor(transcript(SIZE_RULE, 'const v10 = 10; — ./src/flows.ts:10'))).toEqual(
      canonical,
    );
    expect(lensesFor(transcript(SIZE_RULE, 'const v10 = 10; — src\\flows.ts:10'))).toEqual(
      canonical,
    );
  });

  it('still drops an ungrounded pair before it can mint a lens', () => {
    expect(lensesFor(transcript(SIZE_RULE, 'not in the file at all — src/flows.ts:10'))).toEqual(
      [],
    );
  });
});

describe('applyOverrideValve — conventions waiver across anchor drift (sc-3324)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const table: readonly Reviewer[] = REVIEWERS;
  const conventions = table.find((r) => r.name === 'conventions-reviewer');
  if (!conventions) throw new Error('conventions-reviewer is not registered');
  const sel: ReviewerSelection = { reviewer: conventions, files: ['src/flows.ts'] };
  const outcome = (raw: string): ReviewOutcome => ({
    name: 'conventions-reviewer',
    status: 'fail',
    reason: 'cited rule',
    escalated: false,
    transcript: raw,
  });
  /** Record the waiver a dev would copy from run 1's FAIL output; returns its fingerprint. */
  const waiveRun1 = (cwd: string, raw: string): string => {
    const [lens] = lensOf(raw);
    if (!lens) throw new Error('run 1 produced no lens');
    const fp = fingerprint('conventions-reviewer', lens, 'DIFF-UNCHANGED');
    reconcile(cwd, 'conventions-reviewer', [lens], 'DIFF-UNCHANGED', 'T', {
      [`OVERRIDE_${fp}_RATIONALE`]: 'size rule measures pre-existing length',
    });
    return fp;
  };
  const io = { readState: () => null, stagedDiff: () => 'DIFF-UNCHANGED' };

  it('a waiver recorded on run N passes run N+1 when only the anchor line moved', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'conv-waive-'));
    dirs.push(cwd);
    const fp = waiveRun1(cwd, transcript(SIZE_RULE, 'export function a() { — src/flows.ts:668'));

    const res2 = outcome(transcript(SIZE_RULE, 'const b = 1; — src/flows.ts:605'));
    applyOverrideValve(sel, res2, cwd, io);
    expect(res2.status).toBe('pass');
    expect(res2.waivers?.map((w) => w.fingerprint)).toEqual([fp]);
    expect(res2.blocking).toBeUndefined();
  });

  it('the same waiver does not pass a different rule in the same file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'conv-waive-'));
    dirs.push(cwd);
    waiveRun1(cwd, transcript(SIZE_RULE, 'a — src/flows.ts:668'));

    const res2 = outcome(
      transcript('Never use console.log. — CLAUDE.md:20', 'b — src/flows.ts:605'),
    );
    applyOverrideValve(sel, res2, cwd, io);
    expect(res2.status).toBe('fail');
    expect(res2.reason).toContain(
      'guard-review waive conventions-reviewer:src/flows.ts@CLAUDE.md:20',
    );
  });

  it('a waiver for one rule does not pass a second rule cited at the same path:line', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'conv-waive-'));
    dirs.push(cwd);
    waiveRun1(cwd, transcript(SIZE_RULE, 'a — src/flows.ts:668'));
    const res = outcome(
      `VIOLATION: ${SIZE_RULE}\nOFFENDING: a — src/flows.ts:668\n` +
        'VIOLATION: Never use console.log. — CLAUDE.md:20\nOFFENDING: a — src/flows.ts:668\n' +
        'VERDICT: FAIL — two rules',
    );
    applyOverrideValve(sel, res, cwd, io);
    expect(res.status).toBe('fail');
    expect(res.waivers).toHaveLength(1);
    expect(res.reason).toContain('src/flows.ts@CLAUDE.md:20');
    // The structured twin of the prose (sc-3212): the digest lists this without parsing `reason`.
    const lens = 'src/flows.ts@CLAUDE.md:20';
    expect(res.blocking).toEqual([
      { lens, fp: fingerprint('conventions-reviewer', lens, 'DIFF-UNCHANGED') },
    ]);
  });

  it('prefers the contract-validated lenses the cascade already computed', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'conv-waive-'));
    dirs.push(cwd);
    const res = outcome(transcript(SIZE_RULE, 'a — src/flows.ts:668'));
    res.blockingLenses = ['src/other.ts@CLAUDE.md:1'];
    applyOverrideValve(sel, res, cwd, io);
    expect(res.status).toBe('fail');
    expect(res.reason).toContain('src/other.ts@CLAUDE.md:1');
    expect(res.reason).not.toContain('src/flows.ts');
  });
});

describe('blockingNote — a waive command the dev can paste', () => {
  it('leaves a shell-safe conventions lens bare', async () => {
    const { blockingNote } = await import('../overrides.mts');
    const note = blockingNote('conventions-reviewer', [
      { lens: 'src/a.ts@CLAUDE.md:12', fp: 'a1b2c3d4e5f6' },
    ]);
    expect(note).toContain(
      'guard-review waive conventions-reviewer:src/a.ts@CLAUDE.md:12 a1b2c3d4e5f6',
    );
  });

  it('single-quotes a lens whose offending path holds spaces or quotes', async () => {
    const { blockingNote } = await import('../overrides.mts');
    const note = blockingNote('conventions-reviewer', [
      { lens: "docs/it's here.ts@CLAUDE.md:12", fp: 'a1b2c3d4e5f6' },
    ]);
    expect(note).toContain(
      "guard-review waive 'conventions-reviewer:docs/it'\\''s here.ts@CLAUDE.md:12' a1b2c3d4e5f6",
    );
  });
});

describe('parseConventionFindings — ruleQuote', () => {
  it('carries the verbatim VIOLATION quote', () => {
    const [f] = parseConventionFindings(transcript(SIZE_RULE, 'x — src/a.ts:4'));
    expect(f?.ruleQuote).toBe('Keep files under 500 lines.');
  });
});

describe('shellWord — the one quoting rule every pasteable command shares', () => {
  it('leaves a plain word bare, including % and a mid-word #', async () => {
    const { shellWord } = await import('../valve/shell-word.mts');
    expect(shellWord('correctness-reviewer:src/a%b.ts@CLAUDE.md:1#L2')).toBe(
      'correctness-reviewer:src/a%b.ts@CLAUDE.md:1#L2',
    );
  });

  it('quotes a leading # (a shell comment), spaces and quotes', async () => {
    const { shellWord } = await import('../valve/shell-word.mts');
    expect(shellWord('#notes.md')).toBe("'#notes.md'");
    expect(shellWord("it's here.ts")).toBe("'it'\\''s here.ts'");
  });
});
