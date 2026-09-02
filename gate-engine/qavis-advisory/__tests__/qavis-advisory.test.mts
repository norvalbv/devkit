import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AdvisoryDeps, qavisOnPath, type RouteResult, runQavisAdvisory } from '../check.mts';

const ENV_KEYS = [
  'GUARD_AI_STRICT',
  'GUARD_QAVIS_OK',
  'GUARD_NO_QAVIS_ADVISORY',
  'DEVKIT_SHIP_ROOT',
  'DEVKIT_SHIP_PATHS',
  'DEVKIT_SHIP_BRANCH',
  'DEVKIT_SHIP_BASE_SHA',
  'DEVKIT_SHIP_FROM_BRANCH',
  'DEVKIT_SHIP_SOURCE_HEAD',
  'DEVKIT_SHIP_QA',
  'PATH',
  'QAVIS_CONTRACT_RECEIPT',
  'QAVIS_CONTRACT_REPO',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

const deps = (route: RouteResult, hasRecipe = true): AdvisoryDeps => ({
  hasRecipe: () => hasRecipe,
  route: () => route,
});
const advise = deps({ verdict: 'ADVISE' });
const silent = deps({ verdict: 'SILENT' });
const stderr = (): string =>
  (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((c: unknown[]) => String(c[0]))
    .join('\n');

describe('runQavisAdvisory exit contract', () => {
  it('no recipe → 0, and never shells qavis (zero-weight for non-qavis repos)', () => {
    const route = vi.fn((): RouteResult => ({ verdict: 'ADVISE' }));
    expect(runQavisAdvisory('/r', { hasRecipe: () => false, route })).toBe(0);
    expect(route).not.toHaveBeenCalled();
    expect(stderr()).toBe(''); // a non-qavis repo hears nothing at all
  });

  it('SILENT → 0', () => {
    expect(runQavisAdvisory('/r', silent)).toBe(0);
  });

  it('ADVISE on a normal commit → 0 (advisory only, never blocks)', () => {
    expect(runQavisAdvisory('/r', advise)).toBe(0);
  });

  it('ADVISE under a strict ship → 3 (block until QA or override)', () => {
    process.env.GUARD_AI_STRICT = '1';
    expect(runQavisAdvisory('/r', advise)).toBe(3);
  });

  it('the emitted remediation runs forced vision and its receipt clears the next strict gate', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'qavis-advisory-contract-'));
    const binDir = mkdtempSync(path.join(tmpdir(), 'qavis-advisory-bin-'));
    const receipt = path.join(repo, 'pass-receipt');
    const qavis = path.join(binDir, 'qavis');
    writeFileSync(
      qavis,
      `#!/usr/bin/env node
const { existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const receipt = process.env.QAVIS_CONTRACT_RECEIPT;
const route = ['route', '--staged', '--gate', '--repo', process.env.QAVIS_CONTRACT_REPO];
const qa = ['qa', '--staged', '--route', 'vision', '--repo', '.'];
if (JSON.stringify(args) === JSON.stringify(route)) {
  process.stdout.write(existsSync(receipt) ? 'SILENT\\n' : 'ADVISE\\n');
  process.exit(0);
}
if (JSON.stringify(args) === JSON.stringify(qa)) {
  writeFileSync(receipt, 'pass');
  process.exit(0);
}
process.exit(2);
`,
    );
    chmodSync(qavis, 0o755);
    process.env.GUARD_AI_STRICT = '1';
    process.env.PATH = [binDir, saved.PATH].filter(Boolean).join(path.delimiter);
    process.env.QAVIS_CONTRACT_RECEIPT = receipt;
    process.env.QAVIS_CONTRACT_REPO = repo;

    expect(runQavisAdvisory(repo, { hasRecipe: () => true })).toBe(3);
    const command = stderr().match(/Run:\s+(qavis qa.*?)\s+\(a pass writes/)?.[1];
    expect(command).toBeDefined();
    const [executable, ...args] = command?.split(/\s+/) ?? [];
    execFileSync(executable as string, args, { cwd: repo });

    expect(existsSync(receipt)).toBe(true);
    expect(runQavisAdvisory(repo, { hasRecipe: () => true })).toBe(0);
  });

  it('GUARD_QAVIS_OK short-circuits ADVISE under strict → 0, never shells qavis', () => {
    process.env.GUARD_AI_STRICT = '1';
    process.env.GUARD_QAVIS_OK = '1';
    const route = vi.fn((): RouteResult => ({ verdict: 'ADVISE' }));
    expect(runQavisAdvisory('/r', { hasRecipe: () => true, route })).toBe(0);
    expect(route).not.toHaveBeenCalled();
  });

  it('GUARD_NO_QAVIS_ADVISORY disables entirely → 0', () => {
    process.env.GUARD_AI_STRICT = '1';
    process.env.GUARD_NO_QAVIS_ADVISORY = '1';
    expect(runQavisAdvisory('/r', advise)).toBe(0);
  });
});

// A recipe repo EXPECTS qavis, so a skipped advisory is an anomaly worth a line — but never an
// exit code. Silence here is what let the gate sit dead and look identical to "nothing to QA".
describe('runQavisAdvisory reports a fail-open skip', () => {
  const missing = deps({ verdict: null, skip: 'qavis not on PATH' });

  it('qavis absent → 0 (fail-open) and says so on stderr', () => {
    expect(runQavisAdvisory('/r', missing)).toBe(0);
    expect(stderr()).toContain('qavis-advisory: skipped — qavis not on PATH.');
    expect(stderr()).toContain('GUARD_NO_QAVIS_ADVISORY=1');
  });

  it('qavis absent under a strict ship → STILL 0, and still warns', () => {
    process.env.GUARD_AI_STRICT = '1';
    expect(runQavisAdvisory('/r', missing)).toBe(0);
    expect(stderr()).toContain('qavis not on PATH');
  });

  it('route errored → 0, echoing the reason', () => {
    const r = deps({ verdict: null, skip: 'qavis route failed: boom' });
    expect(runQavisAdvisory('/r', r)).toBe(0);
    expect(stderr()).toContain('qavis route failed: boom');
  });

  it('unparseable verdict → 0, echoing what it printed', () => {
    const r = deps({ verdict: null, skip: 'qavis route printed no verdict ("MAYBE")' });
    expect(runQavisAdvisory('/r', r)).toBe(0);
    expect(stderr()).toContain('printed no verdict ("MAYBE")');
  });

  it.each([['SILENT'], ['ADVISE']] as const)('%s does not print a skip line', (verdict) => {
    runQavisAdvisory('/r', deps({ verdict }));
    expect(stderr()).not.toContain('skipped —');
  });
});

describe('qavisOnPath', () => {
  it('finds an EXECUTABLE qavis in a PATH entry, and reports false when no entry has one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qavis-path-'));
    const empty = mkdtempSync(path.join(tmpdir(), 'qavis-empty-'));
    writeFileSync(path.join(dir, 'qavis'), '');
    chmodSync(path.join(dir, 'qavis'), 0o755);

    expect(qavisOnPath({ PATH: [empty, dir].join(path.delimiter) })).toBe(true);
    expect(qavisOnPath({ PATH: empty })).toBe(false);
    expect(qavisOnPath({})).toBe(false);
  });

  it('a non-executable file (or a directory) named qavis is NOT a healthy install', () => {
    const noExec = mkdtempSync(path.join(tmpdir(), 'qavis-noexec-'));
    writeFileSync(path.join(noExec, 'qavis'), '');
    chmodSync(path.join(noExec, 'qavis'), 0o644);
    const dirNamed = mkdtempSync(path.join(tmpdir(), 'qavis-dir-'));
    mkdirSync(path.join(dirNamed, 'qavis'));

    expect(qavisOnPath({ PATH: noExec })).toBe(false);
    expect(qavisOnPath({ PATH: dirNamed })).toBe(false);
  });
});

// sc-2487: under ship this gate runs in an ephemeral worktree; the caller's own index is empty, so
// the remedy must stage the shipped paths in the CALLER'S checkout and QA there.
describe('the printed remedy runs where the operator is', () => {
  it('on a plain commit it is the index-relative form', () => {
    runQavisAdvisory('/r', advise);
    expect(stderr()).toContain('Run:  qavis qa --staged --route vision --repo .');
    expect(stderr()).not.toContain('devkit ship --resume');
  });

  it('under ship it stages exactly the shipped paths in ROOT, quoted, leaves other staging alone, and names the resume', () => {
    const b64 = (p: string): string => Buffer.from(p, 'utf8').toString('base64');
    process.env.DEVKIT_SHIP_ROOT = '/Users/me/Personal and learning/app';
    // A colon and a newline inside filenames must survive the env round trip.
    process.env.DEVKIT_SHIP_PATHS = `${b64('src/renderer/App.tsx')}:${b64("docs/it's:a\nb.md")}:`;
    process.env.DEVKIT_SHIP_BRANCH = 'me/sc-1/$(thing)';
    runQavisAdvisory('/wt', advise);
    const root = "'/Users/me/Personal and learning/app'";
    expect(stderr()).toContain(
      `Run:  git -C ${root} add -- './src/renderer/App.tsx' $'./docs/it\\'s:a\\x0ab.md' && qavis qa --staged --route vision --repo ${root}`,
    );
    expect(stderr()).not.toContain('restore --staged -- .'); // never clears the caller's own staging
    expect(stderr()).toContain("then: devkit ship --resume 'me/sc-1/$(thing)'");
    expect(stderr()).toContain('note: the receipt attests the staged set');
  });

  it('a --from-branch ship keys the receipt on the committed range, not an empty index', () => {
    process.env.DEVKIT_SHIP_ROOT = '/repo';
    process.env.DEVKIT_SHIP_FROM_BRANCH = '1';
    process.env.DEVKIT_SHIP_BASE_SHA = 'abc123';
    runQavisAdvisory('/wt', advise);
    expect(stderr()).toContain("Run:  qavis qa --diff 'abc123' --route vision --repo '/repo'");
    expect(stderr()).not.toContain('git -C');
  });

  it('DEVKIT_SHIP_QA=1: the advisory runs qavis on the gate tree itself and clears when the re-asked gate is SILENT', () => {
    process.env.GUARD_AI_STRICT = '1';
    process.env.DEVKIT_SHIP_QA = '1';
    const seen: string[] = [];
    let covered = false;
    const rc = runQavisAdvisory('/wt', {
      hasRecipe: () => true,
      route: () => ({ verdict: covered ? 'SILENT' : 'ADVISE' }),
      qa: (cwd) => {
        seen.push(cwd);
        covered = true; // the run recorded a pass on this tree
        return 0;
      },
    });
    expect(seen).toEqual(['/wt']); // driven where the gate evaluates, not in the caller's checkout
    expect(rc).toBe(0);
    expect(stderr()).toContain('cleared by the qavis result recorded on this tree');
    expect(stderr()).not.toContain('no qavis QA on this staged tree');
  });

  it('DEVKIT_SHIP_QA=1: an uncovered tree after the self-run still blocks under strict, with the remedy', () => {
    process.env.GUARD_AI_STRICT = '1';
    process.env.DEVKIT_SHIP_QA = '1';
    const rc = runQavisAdvisory('/wt', {
      hasRecipe: () => true,
      route: () => ({ verdict: 'ADVISE' }),
      qa: () => 0,
    });
    expect(rc).toBe(3);
    expect(stderr()).toContain('qavis exited 0 and this tree is still not covered');
    expect(stderr()).toContain('Run:  qavis qa --staged');
  });

  it('a checkout that forked before the base moved gets NO local command — only the self-run resume, the pushed-head run and the recorded bypass', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'qavis-advisory-drift-'));
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'fork',
    ]);
    process.env.DEVKIT_SHIP_ROOT = root;
    process.env.DEVKIT_SHIP_BASE_SHA = '0'.repeat(40); // the base is not this HEAD
    process.env.DEVKIT_SHIP_PATHS = Buffer.from('a.tsx').toString('base64') + ':';
    process.env.GUARD_AI_STRICT = '1';
    expect(runQavisAdvisory('/wt', advise)).toBe(3);
    expect(stderr()).not.toContain('git -C'); // no command that cannot clear the gate
    expect(stderr()).not.toContain('qavis qa --staged');
    expect(stderr()).toContain('no receipt minted there can attest it');
    expect(stderr()).toContain('DEVKIT_SHIP_QA=1 devkit ship --resume');
    expect(stderr()).toContain(`qavis qa --pr <n> --annotate description --repo '${root}'`);
    expect(stderr()).toContain('GUARD_QAVIS_OK=1');
  });

  it('quotes a non-UTF-8 filename byte for byte (ANSI-C form) instead of re-encoding it', () => {
    process.env.DEVKIT_SHIP_ROOT = '/repo';
    process.env.DEVKIT_SHIP_PATHS = `${Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x6d, 0x64]).toString('base64')}:`; // caf\xe9.md in Latin-1
    runQavisAdvisory('/wt', advise);
    expect(stderr()).toContain("add -- $'./caf\\xe9.md' &&");
  });

  it('under ship with no recorded paths it still points at ROOT rather than the worktree', () => {
    process.env.DEVKIT_SHIP_ROOT = '/repo';
    runQavisAdvisory('/wt', advise);
    expect(stderr()).toContain("Run:  qavis qa --staged --route vision --repo '/repo'");
    expect(stderr()).not.toContain('git -C');
  });

  it('a colon-prefixed filename is staged as a file path, never as pathspec magic', () => {
    process.env.DEVKIT_SHIP_ROOT = '/repo';
    process.env.DEVKIT_SHIP_PATHS = `${Buffer.from(':(glob)trap.tsx').toString('base64')}:`;
    runQavisAdvisory('/wt', advise);
    expect(stderr()).toContain("add -- './:(glob)trap.tsx' &&");
  });
  it('DEVKIT_SHIP_QA=1: a re-check outage after the self-run fails OPEN (exit 0) and names the skip, even under strict', () => {
    process.env.GUARD_AI_STRICT = '1';
    process.env.DEVKIT_SHIP_QA = '1';
    let asked = 0;
    const rc = runQavisAdvisory('/wt', {
      hasRecipe: () => true,
      route: () =>
        asked++ === 0 ? { verdict: 'ADVISE' } : { verdict: null, skip: 'qavis route failed: boom' },
      qa: () => 0,
    });
    expect(rc).toBe(0);
    expect(stderr()).toContain('skipped — qavis route failed: boom');
    expect(stderr()).not.toContain('still not covered');
  });

  it("DEVKIT_SHIP_QA=1: the self-run's receipt is copied back into the caller's checkout when the caller had none to link", () => {
    process.env.DEVKIT_SHIP_QA = '1';
    const root = mkdtempSync(path.join(tmpdir(), 'qavis-advisory-root-'));
    const wt = mkdtempSync(path.join(tmpdir(), 'qavis-advisory-wt-'));
    process.env.DEVKIT_SHIP_ROOT = root;
    let covered = false;
    const rc = runQavisAdvisory(wt, {
      hasRecipe: () => true,
      route: () => ({ verdict: covered ? 'SILENT' : 'ADVISE' }),
      qa: (cwd) => {
        mkdirSync(path.join(cwd, '.qavis'), { recursive: true });
        writeFileSync(path.join(cwd, '.qavis', 'receipt.json'), '{"verdict":"pass"}\n');
        covered = true;
        return 0;
      },
    });
    expect(rc).toBe(0);
    expect(existsSync(path.join(root, '.qavis', 'receipt.json'))).toBe(true);
    expect(readFileSync(path.join(root, '.qavis', 'receipt.json'), 'utf8')).toBe(
      '{"verdict":"pass"}\n',
    );
  });
  it("DEVKIT_SHIP_QA=1: a receipt that cannot be copied back (the caller's path is a directory) is a warning, never an exit code", () => {
    process.env.GUARD_AI_STRICT = '1';
    process.env.DEVKIT_SHIP_QA = '1';
    const root = mkdtempSync(path.join(tmpdir(), 'qavis-advisory-root-'));
    const wt = mkdtempSync(path.join(tmpdir(), 'qavis-advisory-wt-'));
    mkdirSync(path.join(root, '.qavis', 'receipt.json'), { recursive: true }); // a directory where the file goes
    process.env.DEVKIT_SHIP_ROOT = root;
    let covered = false;
    const rc = runQavisAdvisory(wt, {
      hasRecipe: () => true,
      route: () => ({ verdict: covered ? 'SILENT' : 'ADVISE' }),
      qa: (cwd) => {
        mkdirSync(path.join(cwd, '.qavis'), { recursive: true });
        writeFileSync(path.join(cwd, '.qavis', 'receipt.json'), '{"verdict":"pass"}\n');
        covered = true;
        return 0;
      },
    });
    expect(rc).toBe(0);
    expect(stderr()).toContain('could not copy the receipt back');
    expect(stderr()).toContain('cleared by the qavis result recorded on this tree');
  });
  it('DEVKIT_SHIP_QA=1: a receipt the caller minted meanwhile is never overwritten by the copy-back', () => {
    process.env.DEVKIT_SHIP_QA = '1';
    const root = mkdtempSync(path.join(tmpdir(), 'qavis-advisory-root-'));
    const wt = mkdtempSync(path.join(tmpdir(), 'qavis-advisory-wt-'));
    process.env.DEVKIT_SHIP_ROOT = root;
    let covered = false;
    runQavisAdvisory(wt, {
      hasRecipe: () => true,
      route: () => ({ verdict: covered ? 'SILENT' : 'ADVISE' }),
      qa: (cwd) => {
        mkdirSync(path.join(cwd, '.qavis'), { recursive: true });
        writeFileSync(path.join(cwd, '.qavis', 'receipt.json'), '{"verdict":"pass"}\n');
        mkdirSync(path.join(root, '.qavis'), { recursive: true });
        writeFileSync(
          path.join(root, '.qavis', 'receipt.json'),
          '{"verdict":"regress","theirs":true}\n',
        ); // landed during the drive
        covered = true;
        return 0;
      },
    });
    expect(readFileSync(path.join(root, '.qavis', 'receipt.json'), 'utf8')).toContain(
      '"theirs":true',
    );
  });
  it('a --from-branch ship whose caller HEAD moved past the pinned source head is drifted: no --diff remedy', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'qavis-advisory-src-'));
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'one',
    ]);
    process.env.DEVKIT_SHIP_ROOT = root;
    process.env.DEVKIT_SHIP_FROM_BRANCH = '1';
    process.env.DEVKIT_SHIP_BASE_SHA = 'abc123';
    process.env.DEVKIT_SHIP_SOURCE_HEAD = '0'.repeat(40); // ship pinned a head this checkout no longer has
    process.env.GUARD_AI_STRICT = '1';
    expect(runQavisAdvisory('/wt', advise)).toBe(3);
    expect(stderr()).not.toContain('qavis qa --diff');
    expect(stderr()).toContain('no receipt minted there can attest it');
  });
});
