import { execSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDetectJudgeInput,
  depChangedKeys,
  detectSmells,
  gateVerdict,
  parseVerdict,
  smellSources,
} from '../detect.mts';

const DETECT = fileURLToPath(new URL('../detect.mts', import.meta.url));

// Boundaries are now CONFIG-driven (cfg.boundaries), not a hardcoded const — the pure helper takes
// them as its 2nd arg. A consumer opts into these via guard.config.json; the gate tests below write
// one. The default is [] (no boundaries → the cross-boundary smell never fires).
const BOUNDARIES = ['src/main/', 'socket-server/', 'vercel-serverless/'];

const entry = (o) => ({ status: 'M', path: 'x', added: 0, deleted: 0, depChanged: false, ...o });

describe('detectSmells', () => {
  it('flags a dependency change in package.json', () => {
    expect(
      detectSmells([entry({ status: 'M', path: 'package.json', depChanged: true })], BOUNDARIES),
    ).toContain('dep-change');
  });

  it('does not flag a package.json edit that left dependencies untouched', () => {
    expect(
      detectSmells([entry({ status: 'M', path: 'package.json', depChanged: false })], BOUNDARIES),
    ).toEqual([]);
  });

  it('flags a cross-trust-boundary change (≥2 boundaries)', () => {
    const s = detectSmells(
      [entry({ path: 'src/main/foo.ts' }), entry({ path: 'socket-server/src/bar.ts' })],
      BOUNDARIES,
    );
    expect(s).toContain('cross-boundary-move');
  });

  it('does NOT flag a cross-boundary change when boundaries are unconfigured (default [])', () => {
    // The parameterization invariant: with no configured boundaries the smell can never fire.
    expect(
      detectSmells([
        entry({ path: 'src/main/foo.ts' }),
        entry({ path: 'socket-server/src/bar.ts' }),
      ]),
    ).toEqual([]);
  });

  it('does not flag a single-boundary change', () => {
    expect(
      detectSmells(
        [entry({ path: 'src/main/foo.ts' }), entry({ path: 'src/main/baz.ts' })],
        BOUNDARIES,
      ),
    ).toEqual([]);
  });

  it('flags a large legacy deletion', () => {
    expect(
      detectSmells([entry({ status: 'D', path: 'src/old.ts', deleted: 240 })], BOUNDARIES),
    ).toContain('legacy-deletion');
  });

  it('does not flag a small deletion', () => {
    expect(
      detectSmells([entry({ status: 'D', path: 'src/old.ts', deleted: 12 })], BOUNDARIES),
    ).toEqual([]);
  });

  it('flags a module-replace (big delete + new file, same basename, different dir)', () => {
    const s = detectSmells(
      [
        entry({ status: 'D', path: 'src/lib/transport.ts', deleted: 80 }),
        entry({ status: 'A', path: 'src/net/transport.ts', added: 90 }),
      ],
      BOUNDARIES,
    );
    expect(s).toContain('module-replace');
  });

  it('ignores lockfile-only churn', () => {
    expect(
      detectSmells(
        [entry({ status: 'M', path: 'bun.lock', added: 200, deleted: 200 })],
        BOUNDARIES,
      ),
    ).toEqual([]);
    expect(
      detectSmells(
        [entry({ status: 'M', path: 'package-lock.json', added: 50, deleted: 50 })],
        BOUNDARIES,
      ),
    ).toEqual([]);
  });

  it('a package.json + lockfile dep bump still flags only via the real dep change', () => {
    const s = detectSmells(
      [
        entry({ status: 'M', path: 'package.json', depChanged: true }),
        entry({ status: 'M', path: 'bun.lock', added: 9, deleted: 3 }),
      ],
      BOUNDARIES,
    );
    expect(s).toEqual(['dep-change']);
  });
});

// The Stop-hook seen-set re-arms iff a never-seen (label, contributing-file) pair appears. These
// pure tests are load-bearing: the hook is just `grep -vxF` plumbing over smellSources' output.
describe('smellSources (seen-set pairs)', () => {
  const pairs = (e, b = BOUNDARIES) => smellSources(e, b).map((s) => `${s.label}\t${s.path}`);

  it('emits one dep-change pair per CHANGED dependency NAME, not per package.json (C2)', () => {
    // Two distinct dep decisions on the same package.json stay distinguishable by name.
    expect(
      smellSources([entry({ path: 'package.json', depKeys: ['lodash'] })], BOUNDARIES),
    ).toEqual([{ label: 'dep-change', path: 'lodash' }]);
  });

  it('re-arms on a NEW pair, never on the cumulative set (anti-nag + new-decision)', () => {
    // Turn 5 — decision #1: a lodash bump.
    const t5 = pairs([entry({ path: 'package.json', depKeys: ['lodash'] })]);
    // Same decision, later turn: also touched an unrelated file (not a smell source). Pairs are
    // byte-identical → already in the seen-set → grep -vxF finds nothing → NO re-nudge.
    const t9 = pairs([
      entry({ path: 'package.json', depKeys: ['lodash'] }),
      entry({ path: 'src/renderer/whatever.tsx' }),
    ]);
    expect(t9).toEqual(t5);
    // Turn 30 — decision #2: a distinct legacy deletion. Exactly one NEW pair; #1 stays snoozed.
    const t30 = pairs([
      entry({ path: 'package.json', depKeys: ['lodash'] }),
      entry({ status: 'D', path: 'src/main/old-module.ts', deleted: 150 }),
    ]);
    expect(t30.filter((p) => !t5.includes(p))).toEqual(['legacy-deletion\tsrc/main/old-module.ts']);
  });

  it('a distinct second dep bump is a fresh pair (the dep-collapse ceiling is lifted)', () => {
    const first = pairs([entry({ path: 'package.json', depKeys: ['lodash'] })]);
    const second = pairs([entry({ path: 'package.json', depKeys: ['lodash', 'axios'] })]);
    expect(second.filter((p) => !first.includes(p))).toEqual(['dep-change\taxios']);
  });

  it('its distinct labels equal detectSmells (one source of truth)', () => {
    const e = [
      entry({ path: 'src/main/foo.ts' }),
      entry({ path: 'socket-server/bar.ts' }),
      entry({ status: 'D', path: 'src/old.ts', deleted: 240 }),
    ];
    expect([...new Set(smellSources(e, BOUNDARIES).map((s) => s.label))].sort()).toEqual(
      detectSmells(e, BOUNDARIES).sort(),
    );
  });
});

describe('depChangedKeys', () => {
  it('returns the dep names whose spec differs (added, removed, or version-bumped)', () => {
    expect(
      depChangedKeys(
        { dependencies: { a: '1', b: '1' } },
        { dependencies: { a: '1', b: '2' }, devDependencies: { c: '1' } },
      ).sort(),
    ).toEqual(['b', 'c']);
  });

  it('is empty when no dependency spec changed (a non-dep package.json edit)', () => {
    expect(
      depChangedKeys({ dependencies: { a: '1' } }, { dependencies: { a: '1' }, name: 'y' }),
    ).toEqual([]);
  });
});

describe('gateVerdict', () => {
  const smells = ['dep-change'];
  it('blocks on a smell with no record and no bypass', () => {
    expect(gateVerdict({ bypass: false, decisionStaged: false, smells })).toBe(1);
  });
  it('passes when a decision is staged', () => {
    expect(gateVerdict({ bypass: false, decisionStaged: true, smells })).toBe(0);
  });
  it('passes on bypass (GUARD_NO_LOG)', () => {
    expect(gateVerdict({ bypass: true, decisionStaged: false, smells })).toBe(0);
  });
  it('passes when there are no smells', () => {
    expect(gateVerdict({ bypass: false, decisionStaged: false, smells: [] })).toBe(0);
  });
});

// The evidence extractor: the judge must see the smell-tripping files' hunks and NEVER the
// routine haystack — a buried decision cannot be sliced away, and churn cannot dilute attention.
describe('buildDetectJudgeInput', () => {
  const depEntry = entry({ path: 'package.json', depChanged: true, depKeys: ['prisma'] });
  const churnEntry = entry({ path: 'src/generated/fixtures.ts', added: 300, deleted: 300 });
  const seg = (p, body) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${body}\n`;

  it('extracts ONLY smell-contributing segments; routine churn is omitted, not appended', () => {
    const diff =
      seg('src/generated/fixtures.ts', '+churn'.repeat(50)) +
      seg('package.json', '-"prisma"\n+"drizzle-orm"');
    const input = buildDetectJudgeInput(diff, [churnEntry, depEntry]);
    expect(input).toContain('drizzle-orm'); // the decision decider is present…
    expect(input).not.toContain('churn'); // …the haystack is not
    expect(input).toContain('[1 routine changed-file segment(s) omitted');
  });

  it('the file-list header carries every changed file, omitted ones included', () => {
    const diff = seg('package.json', '+x');
    const input = buildDetectJudgeInput(diff, [churnEntry, depEntry]);
    expect(input).toContain('M\tsrc/generated/fixtures.ts\t+300/-300');
    expect(input).toContain('M\tpackage.json');
  });

  it('a many-file commit line-caps the header with an explicit "+N more" — total input stays bounded', () => {
    const many = Array.from({ length: 200 }, (_, i) => entry({ path: `src/f${i}.ts` }));
    const input = buildDetectJudgeInput(seg('package.json', '+x'), [...many, depEntry]);
    expect(input).toContain('…and 141 more changed files');
    expect(input.length).toBeLessThan(12000); // runDetectJudge's slice can never bite
  });

  it('a buried decision survives: evidence is positional-independent', () => {
    // 20k of churn FIRST, the dep hunk LAST — the naive-prefix failure shape.
    const diff =
      seg('src/generated/fixtures.ts', 'x'.repeat(20000)) +
      seg('package.json', '+"drizzle-orm": "^0.36.0"');
    const input = buildDetectJudgeInput(diff, [churnEntry, depEntry]);
    expect(input).toContain('drizzle-orm');
    expect(input.length).toBeLessThan(12000);
  });

  it('consumer git config cannot blind the extractor: noprefix and mnemonicPrefix formats still match', () => {
    // diff.noprefix=true → "diff --git package.json package.json"; mnemonicPrefix → "c/… i/…".
    const noprefix =
      'diff --git package.json package.json\n--- package.json\n+++ package.json\n+"drizzle-orm"\n';
    const mnemonic =
      'diff --git c/package.json i/package.json\n--- c/package.json\n+++ i/package.json\n+"drizzle-orm"\n';
    for (const diff of [noprefix, mnemonic]) {
      const input = buildDetectJudgeInput(diff, [depEntry]);
      expect(input).toContain('drizzle-orm');
      expect(input).not.toContain('no evidence segments could be extracted');
    }
  });

  it('a smelled path never substring-matches a longer path (a.ts vs data.ts)', () => {
    const shortDel = entry({ status: 'D', path: 'a.ts', deleted: 150 });
    const input = buildDetectJudgeInput(seg('src/data.ts', '+unrelated'), [
      shortDel,
      entry({ path: 'src/data.ts' }),
    ]);
    expect(input).not.toContain('+unrelated'); // data.ts is not evidence for the a.ts smell
  });

  it('caps one giant smelled segment so a second smelled file still fits', () => {
    const bigDel = entry({ status: 'D', path: 'src/old/huge.ts', deleted: 900 });
    const diff = seg('src/old/huge.ts', 'y'.repeat(30000)) + seg('package.json', '+"pg": "^8"');
    const input = buildDetectJudgeInput(diff, [bigDel, depEntry]);
    expect(input).toContain('"pg"'); // second smelled file present despite the giant first
    expect(input.length).toBeLessThan(10000);
  });

  it('the total cap is HARD, and a cap-dropped SMELL segment is named INCOMPLETE — never lumped with routine omissions', () => {
    // Three legacy-deletion smells of 4k+ each: the first two fill EVIDENCE_TOTAL_CAP exactly,
    // the third must be reported as dropped smell evidence (fail-safe trigger), not "routine".
    const dels = ['src/a/one.ts', 'src/b/two.ts', 'src/c/three.ts'].map((p) =>
      entry({ status: 'D', path: p, deleted: 500 }),
    );
    const diff = dels.map((d) => seg(d.path, 'z'.repeat(6000))).join('');
    const input = buildDetectJudgeInput(diff, dels);
    expect(input).toContain('SMELL-file segment(s) dropped by the evidence cap');
    expect(input).toContain('INCOMPLETE');
    expect(input).toContain('[0 routine changed-file segment(s) omitted');
    expect(input.length).toBeLessThan(12000); // hard ceiling holds even at exhaustion
  });

  it('lockfile deletions are never evidence and cannot eat the budget (mirrors smellSources)', () => {
    const lockDel = entry({ status: 'D', path: 'apps/a/package-lock.json', deleted: 3000 });
    const diff =
      seg('apps/a/package-lock.json', 'l'.repeat(9000)) + seg('package.json', '+"drizzle-orm"');
    const input = buildDetectJudgeInput(diff, [lockDel, depEntry]);
    expect(input).toContain('drizzle-orm'); // the real decision keeps the budget
    expect(input).not.toContain('lll'); // lockfile churn never reaches the model
  });

  it('an unrelated mid-size deletion (no module-replace counterpart, under legacy floor) is not evidence', () => {
    const midDel = entry({ status: 'D', path: 'src/tmp/scratch.ts', deleted: 70 }); // >50, <100, no A twin
    const diff = seg('src/tmp/scratch.ts', '-scratch') + seg('package.json', '+"pg"');
    const input = buildDetectJudgeInput(diff, [midDel, depEntry]);
    expect(input).not.toContain('-scratch');
    expect(input).toContain('"pg"');
  });

  it('module-replace: both the ADDED file and its big-deletion counterpart are evidence', () => {
    const del = entry({ status: 'D', path: 'src/lib/transport.ts', deleted: 80 });
    const add = entry({ status: 'A', path: 'src/net/transport.ts', added: 90 });
    const diff =
      seg('src/lib/transport.ts', '-old impl') + seg('src/net/transport.ts', '+new impl');
    const input = buildDetectJudgeInput(diff, [del, add]);
    expect(input).toContain('-old impl');
    expect(input).toContain('+new impl');
  });

  it('cross-boundary evidence flows through the boundaries argument', () => {
    const a = entry({ path: 'api/auth.ts', added: 10, deleted: 2 });
    const b = entry({ path: 'worker/auth.ts', added: 12, deleted: 3 });
    const diff = seg('api/auth.ts', '+moved check') + seg('worker/auth.ts', '+receives check');
    const withB = buildDetectJudgeInput(diff, [a, b], ['api/', 'worker/']);
    expect(withB).toContain('+moved check');
    expect(withB).toContain('+receives check');
    const withoutB = buildDetectJudgeInput(diff, [a, b]); // no boundaries → no smell → no evidence
    expect(withoutB).not.toContain('+moved check');
    expect(withoutB).toContain('no evidence segments could be extracted');
  });

  it('zero extractable evidence warns explicitly — the fail-safe instruction engages', () => {
    const weird = 'diff --git "a/sp ace.ts" "b/sp ace.ts"\n+z\n';
    const input = buildDetectJudgeInput(weird, [depEntry]);
    expect(input).toContain('no evidence segments could be extracted');
  });
});

describe('parseVerdict', () => {
  it('clears on a confident ROUTINE (case/space-insensitive)', () => {
    expect(parseVerdict('routine\n')).toBe('ROUTINE');
  });
  it('returns DECISION on a confident DECISION', () => {
    expect(parseVerdict('DECISION')).toBe('DECISION');
  });
  it('never returns ROUTINE when both words appear (ambiguous → DECISION, block stands)', () => {
    const v = parseVerdict('This looks ROUTINE but is arguably a DECISION');
    expect(v).not.toBe('ROUTINE'); // the safety invariant: ambiguity can never clear a block
    expect(v).toBe('DECISION');
  });
  it('returns null on garbage or empty (→ regex block stands)', () => {
    expect(parseVerdict('maybe?')).toBeNull();
    expect(parseVerdict('')).toBeNull();
  });
});

// Exercises the git-reading wrappers (gatherEntries/decisionStaged) + dispatch that the pure
// tests above can't reach — a real staged diff in a throwaway repo. The gate resolves its config
// (decisionsDir, boundaries, noLog/noLlm) from the repo cwd, never the package dir (W-3).
describe('--gate (integration, real git repo)', () => {
  let repo;
  const git = (args) => execSync(`git ${args}`, { cwd: repo, encoding: 'utf8' });
  // GUARD_DECISION_NO_LLM forces the deterministic regex floor so tests never make a real,
  // non-deterministic `claude -p` call. The LLM path can only DOWNGRADE a block, so the floor
  // is exactly what these assertions verify.
  const gate = (env = {}) =>
    spawnSync('node', [DETECT, '--gate'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GUARD_DECISION_NO_LLM: '1', ...env },
    }).status;
  const scan = (args = []) =>
    spawnSync('node', [DETECT, 'scan', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env },
    }).stdout.trim();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'detect-'));
    git('init -q');
    git('config user.email t@t.t');
    git('config user.name t');
    writeFileSync(
      join(repo, 'package.json'),
      '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0" }\n}\n',
    );
    writeFileSync(join(repo, 'keep.ts'), 'export const x = 1;\n');
    git('add .');
    git('commit -qm base');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('blocks (1) on a staged dependency change with no decision', () => {
    writeFileSync(
      join(repo, 'package.json'),
      '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0", "b": "2.0.0" }\n}\n',
    );
    git('add package.json');
    expect(gate()).toBe(1);
  });

  it('passes (0) with GUARD_NO_LOG=1', () => {
    writeFileSync(
      join(repo, 'package.json'),
      '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0", "b": "2.0.0" }\n}\n',
    );
    git('add package.json');
    expect(gate({ GUARD_NO_LOG: '1' })).toBe(0);
  });

  it('passes (0) with the legacy FRINK_NO_LOG=1 alias', () => {
    writeFileSync(
      join(repo, 'package.json'),
      '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0", "b": "2.0.0" }\n}\n',
    );
    git('add package.json');
    expect(gate({ FRINK_NO_LOG: '1' })).toBe(0);
  });

  it('passes (0) when a decision record is staged alongside the smell', () => {
    writeFileSync(
      join(repo, 'package.json'),
      '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0", "b": "2.0.0" }\n}\n',
    );
    mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'decisions', 'dep-x.md'), '# x\n');
    git('add .');
    expect(gate()).toBe(0);
  });

  it('passes (0) on lockfile-only churn', () => {
    writeFileSync(join(repo, 'bun.lock'), 'lockfile v2\n');
    git('add bun.lock');
    expect(gate()).toBe(0);
  });

  it('blocks (1) on a large legacy deletion', () => {
    writeFileSync(
      join(repo, 'big.ts'),
      Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n'),
    );
    git('add big.ts');
    git('commit -qm big');
    git('rm -q big.ts');
    expect(gate()).toBe(1);
  });

  it('scan --working sees an UNSTAGED smell that the staged scan misses (Stop-hook path)', () => {
    writeFileSync(
      join(repo, 'package.json'),
      '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0", "b": "2.0.0" }\n}\n',
    );
    // deliberately NOT staged
    expect(scan()).toBe(''); // cached scan: nothing staged
    expect(scan(['--working'])).toContain('dep-change'); // working scan: sees the unstaged change
  });

  it('scan --working --files emits (label, dep-name) pairs for the Stop-hook seen-set', () => {
    writeFileSync(
      join(repo, 'package.json'),
      '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0", "b": "2.0.0" }\n}\n',
    );
    // --files surfaces the changed dependency NAME (b), not "package.json" — so a later, distinct
    // dep decision is a fresh pair rather than colliding with this one.
    expect(scan(['--working', '--files'])).toBe('dep-change\tb');
  });

  // The LLM downgrade path (runDetectJudge via execJudge), with a stub `claude` on PATH. Pins the
  // isolation argv (hooks off, read-only, no session persistence) and the outage-warning contract:
  // a dark judge must WARN on stderr, never change an exit code, and never dirty stdout.
  describe('LLM downgrade (stubbed claude on PATH)', () => {
    const stubClaude = (script) => {
      const bin = join(repo, 'fakebin');
      mkdirSync(bin, { recursive: true });
      const fake = join(bin, 'claude');
      writeFileSync(
        fake,
        `#!/bin/sh\necho "$*" >> "${join(repo, 'calls.log')}"\ncat >/dev/null\n${script}`,
      );
      chmodSync(fake, 0o755);
      return bin;
    };
    const gateStubbed = (script, extraEnv = {}) =>
      spawnSync('node', [DETECT, '--gate'], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          // A NO_LLM knob inherited from the runner's shell would short-circuit judgeWithClaude
          // before the stub ever runs — these tests exist to exercise the stubbed claude path.
          GUARD_DECISION_NO_LLM: '',
          FRINK_DECISION_NO_LLM: '',
          PATH: `${stubClaude(script)}:${process.env.PATH}`,
          ...extraEnv,
        },
      });
    const stageDepChange = () => {
      writeFileSync(
        join(repo, 'package.json'),
        '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0", "b": "2.0.0" }\n}\n',
      );
      git('add package.json');
    };

    it('a confident ROUTINE downgrades the regex block (0), judged in isolation', () => {
      stageDepChange();
      const r = gateStubbed('echo ROUTINE\n');
      expect(r.status).toBe(0);
      const argv = execSync('cat calls.log', { cwd: repo, encoding: 'utf8' });
      expect(argv).toContain('--disallowedTools *'); // pure-text judge: no tools
      expect(argv).toContain('disableAllHooks'); // host hooks never fire in the judge
      expect(argv).toContain('--no-session-persistence'); // no transcript pollution
    });

    it('a judge OUTAGE is never cached: the next run re-judges instead of serving a bogus ROUTINE', () => {
      stageDepChange();
      expect(gateStubbed('exit 3\n').status).toBe(1); // outage → block stands, nothing earned
      const calls = () => execSync('cat calls.log', { cwd: repo, encoding: 'utf8' }).trim();
      const afterOutage = calls();
      const r2 = gateStubbed('echo ROUTINE\n');
      expect(r2.status).toBe(0);
      expect(calls()).not.toBe(afterOutage); // second run SPAWNED — no cache entry from the outage
    });

    it('a package.json under a $(…)-named dir never reaches a shell (argv `git show` regression)', () => {
      // Both git-show routes carry the crafted path: HEAD:<path> (base) and :<path> (staged).
      const dir = join(repo, 'evil$(touch INJECTED)');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{\n  "name": "x",\n  "dependencies": {}\n}\n');
      git('add .');
      git('commit -qm crafted-base');
      writeFileSync(
        join(dir, 'package.json'),
        '{\n  "name": "x",\n  "dependencies": { "b": "2.0.0" }\n}\n',
      );
      git('add .');
      const r = gateStubbed('echo DECISION\n'); // judge refuses to downgrade → block
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('dep-change'); // the crafted path was PARSED, not dropped
      expect(existsSync(join(repo, 'INJECTED'))).toBe(false);
      expect(existsSync(join(dir, 'INJECTED'))).toBe(false);
    });

    it('an earned ROUTINE is cached: an identical re-run clears with ZERO judge spawns', () => {
      stageDepChange();
      expect(gateStubbed('echo ROUTINE\n').status).toBe(0);
      const calls = () => execSync('cat calls.log', { cwd: repo, encoding: 'utf8' }).trim();
      const afterFirst = calls();
      const r2 = gateStubbed('echo ROUTINE\n');
      expect(r2.status).toBe(0);
      expect(r2.stderr).toContain('cached ROUTINE');
      expect(calls()).toBe(afterFirst); // no second spawn
    });

    it('a crashing judge warns on stderr, block stands (1), stdout stays clean', () => {
      stageDepChange();
      const r = gateStubbed('exit 3\n');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('decision-smell: claude judge unavailable');
      expect(r.stderr).toContain('UNVERIFIED'); // outage never reads as a judge-confirmed smell
      expect(r.stdout).toBe('');
    });

    it('a crashing judge under GUARD_AI_STRICT (ship) exits 3, never a confirmed-smell 1', () => {
      stageDepChange();
      const r = gateStubbed('exit 3\n', { GUARD_AI_STRICT: '1' });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('decision smells (unverified)');
    });

    it('an empty-output judge warns on stderr, block stands (1)', () => {
      stageDepChange();
      const r = gateStubbed('exit 0\n');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('decision-smell: claude judge returned no output');
    });
  });
});
