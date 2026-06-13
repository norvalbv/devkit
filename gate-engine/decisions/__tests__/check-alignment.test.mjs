import { execSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gateExit,
  judge,
  loadScopedTargets,
  matchScope,
  parseAlignVerdict,
  parseDepthVerdict,
} from '../check-alignment.mjs';

const GATE = fileURLToPath(new URL('../check-alignment.mjs', import.meta.url));

// Stub `claude` on PATH so the real execFileSync spawn → parse path runs without an LLM. Scripts
// read stdin first, can branch on "$*" (model flag, prompt content) and log argv via $CLAUDE_STUB_LOG.
const stubClaude = (repo, script) => {
  const bin = join(repo, 'fakebin');
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, 'claude');
  writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\n${script}`);
  chmodSync(fake, 0o755);
  return bin;
};

// A decision file with a scoped Target (the gate's input).
const scopedTargetMd = (slug, scope, ruling = 'r', vision = 'v') =>
  `---\nslug: ${slug}\ncreated: 2026-01-01\n---\n\n# ${slug}\n\n` +
  `## Target · 2026-01-01 — ${ruling}\n\n**Context:** ${slug} broke\n**Ruling:** ${ruling}\n` +
  `**Consequences:**\n- Positive: value protected\n- Negative: cost paid\n` +
  `**Vision-fit:** ${vision}\n**Scope:** ${scope}\n`;

describe('matchScope', () => {
  it('** matches nested; * stays within one segment', () => {
    expect(matchScope(['src/a/b.ts'], ['src/**'])).toBe(true);
    expect(matchScope(['src/a/b.ts'], ['src/*.ts'])).toBe(false);
    expect(matchScope(['src/x.ts'], ['src/*.ts'])).toBe(true);
  });
  it('matches against ANY of several globs; no overlap → false', () => {
    expect(matchScope(['vercel-serverless/x.ts'], ['src/**', 'vercel-serverless/**'])).toBe(true);
    expect(matchScope(['README.md'], ['src/**'])).toBe(false);
  });
  it('? matches exactly one non-slash char (not zero, not a slash)', () => {
    expect(matchScope(['src/a1.ts'], ['src/a?.ts'])).toBe(true);
    expect(matchScope(['src/a.ts'], ['src/a?.ts'])).toBe(false); // ? needs a char
    expect(matchScope(['src/a/b.ts'], ['src/a?b.ts'])).toBe(false); // ? ≠ slash
  });
});

describe('parseAlignVerdict', () => {
  it('VERDICT line wins over verdict words in the rationale; last line wins', () => {
    expect(
      parseAlignVerdict('It could ALIGN, but the flag flip moves away.\nVERDICT: CONTRADICT'),
    ).toBe('CONTRADICT');
    expect(parseAlignVerdict('verdict: align')).toBe('ALIGN');
    expect(parseAlignVerdict('VERDICT: CONTRADICT\nOn reflection…\nVERDICT: UNCLEAR')).toBe(
      'UNCLEAR',
    );
  });
  it('markdown-dressed VERDICT lines (bold, bullet) still parse — a model that formats must not silently lose its block', () => {
    expect(parseAlignVerdict('Might CONTRADICT at first glance.\n**VERDICT: ALIGN**')).toBe(
      'ALIGN',
    );
    expect(parseAlignVerdict('Could ALIGN, but no.\n- VERDICT: **CONTRADICT**')).toBe('CONTRADICT');
  });
  it('no VERDICT line → strict single-word fallback (case/punct-insensitive)', () => {
    expect(parseAlignVerdict('CONTRADICT')).toBe('CONTRADICT');
    expect(parseAlignVerdict('align.')).toBe('ALIGN');
    expect(parseAlignVerdict('UNCLEAR')).toBe('UNCLEAR');
  });
  it('ambiguous / empty / unknown → null', () => {
    expect(parseAlignVerdict('ALIGN but actually CONTRADICT')).toBeNull();
    expect(parseAlignVerdict('')).toBeNull();
    expect(parseAlignVerdict('maybe')).toBeNull();
  });
});

describe('parseDepthVerdict', () => {
  it('confident single word; ambiguous/empty → null', () => {
    expect(parseDepthVerdict('PASS')).toBe('PASS');
    expect(parseDepthVerdict('thin.')).toBe('THIN');
    expect(parseDepthVerdict('PASS but THIN')).toBeNull();
    expect(parseDepthVerdict('')).toBeNull();
  });
});

describe('gateExit', () => {
  it('blocks ONLY on a confident CONTRADICT', () => {
    expect(gateExit('CONTRADICT')).toBe(1);
    expect(gateExit('ALIGN')).toBe(0);
    expect(gateExit('UNCLEAR')).toBe(0);
    expect(gateExit(null)).toBe(0);
  });
});

describe('loadScopedTargets', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'align-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns only axes whose current Target declares a Scope', () => {
    writeFileSync(
      join(dir, 'scoped.md'),
      scopedTargetMd('scoped', 'src/main/**', 'keep it generic', 'vis'),
    );
    // no Scope line → excluded
    writeFileSync(
      join(dir, 'noscope.md'),
      '---\nslug: noscope\ncreated: 2026-01-01\n---\n\n# noscope\n\n## Target · 2026-01-01 — r2\n\n**Vision / target:** v2\n**Vision-fit:** f\n**Ruling:** r2\n',
    );
    writeFileSync(join(dir, 'INDEX.md'), '# Decision Index\n');
    const got = loadScopedTargets(dir);
    expect(got).toHaveLength(1);
    expect(got[0].slug).toBe('scoped');
    expect(got[0].scopeGlobs).toEqual(['src/main/**']);
    expect(got[0].ruling).toBe('keep it generic');
    expect(got[0].vision).toBe('vis');
  });
});

describe('--gate (integration, real git repo)', () => {
  let repo;
  const git = (a) => execSync(`git ${a}`, { cwd: repo, encoding: 'utf8' });
  // GUARD_DECISION_NO_LLM → judge returns null → fail-safe pass; exercises scope-match + git reads.
  // The gate resolves decisionsDir/noLog/noLlm from the repo cwd (W-3), so the gate runs with cwd=repo.
  const gate = (env = {}) =>
    spawnSync('node', [GATE, '--gate'], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GUARD_DECISIONS_DIR: join(repo, 'docs', 'decisions'),
        GUARD_DECISION_NO_LLM: '1',
        ...env,
      },
    }).status;

  const gateWithStub = (bin, extraEnv = {}) =>
    spawnSync('node', [GATE, '--gate'], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GUARD_DECISIONS_DIR: join(repo, 'docs', 'decisions'),
        PATH: `${bin}:${process.env.PATH}`, // our stub wins; git still resolves from the tail
        ...extraEnv,
      },
    });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'align-gate-'));
    git('init -q');
    git('config user.email t@t.t');
    git('config user.name t');
    mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
    writeFileSync(
      join(repo, 'docs', 'decisions', 'ax.md'),
      scopedTargetMd('ax', 'src/**', 'stay generic'),
    );
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'keep.ts'), 'export const x = 1;\n');
    git('add .');
    git('commit -qm base');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('in-scope change with NO_LLM → no judgement → passes (0)', () => {
    writeFileSync(join(repo, 'src', 'new.ts'), 'export const y = 2;\n');
    git('add src/new.ts');
    expect(gate()).toBe(0);
  });

  it('no scoped target matches the staged files → passes (0)', () => {
    writeFileSync(join(repo, 'README.md'), 'docs\n');
    git('add README.md');
    expect(gate()).toBe(0);
  });

  it('GUARD_NO_LOG bypasses (0)', () => {
    writeFileSync(join(repo, 'src', 'new.ts'), 'export const y = 2;\n');
    git('add src/new.ts');
    expect(gate({ GUARD_NO_LOG: '1' })).toBe(0);
  });

  it('a CONTRADICT confirmed through the cascade blocks the commit (exit 1, end-to-end)', () => {
    // The stub answers CONTRADICT for BOTH calls — haiku flags, opus confirms → block.
    const bin = stubClaude(repo, 'echo CONTRADICT\n');
    writeFileSync(join(repo, 'src', 'rogue.ts'), 'export const y = 2;\n');
    git('add src/rogue.ts');
    const r = gateWithStub(bin);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('CONTRADICTS target "ax"');
  });

  it('claude erroring entirely (e.g. a Cursor-only machine) fails open (0)', () => {
    const bin = stubClaude(repo, 'exit 3\n');
    writeFileSync(join(repo, 'src', 'new.ts'), 'export const y = 2;\n');
    git('add src/new.ts');
    expect(gateWithStub(bin).status).toBe(0);
  });

  it('opus crashing after a haiku CONTRADICT fails open (0) — a half-cascade never blocks', () => {
    const bin = stubClaude(
      repo,
      'case "$*" in\n  *"--model haiku"*) printf "VERDICT: CONTRADICT\\n";;\n  *) exit 3;;\nesac\n',
    );
    writeFileSync(join(repo, 'src', 'rogue.ts'), 'export const y = 2;\n');
    git('add src/rogue.ts');
    expect(gateWithStub(bin).status).toBe(0);
  });

  it('targets judge independently: ALIGN on one never masks a CONTRADICT on another', () => {
    // Second axis over the same scope; the stub keys its verdict on each target's ruling text.
    writeFileSync(
      join(repo, 'docs', 'decisions', 'bx.md'),
      scopedTargetMd('bx', 'src/**', 'use queues everywhere'),
    );
    git('add docs/decisions/bx.md');
    git('commit -qm bx');
    const bin = stubClaude(
      repo,
      'case "$*" in\n  *"use queues everywhere"*) printf "VERDICT: CONTRADICT\\n";;\n' +
        '  *) printf "VERDICT: ALIGN\\n";;\nesac\n',
    );
    writeFileSync(join(repo, 'src', 'rogue.ts'), 'export const y = 2;\n');
    git('add src/rogue.ts');
    const r = gateWithStub(bin);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('CONTRADICTS target "bx"');
    expect(r.stderr).not.toContain('target "ax"');
  });

  it('a staged filename containing a space survives the diffstat shell-out (0, not fail-open 2)', () => {
    const bin = stubClaude(repo, 'printf "VERDICT: ALIGN\\n"\n');
    writeFileSync(join(repo, 'src', 'my file.ts'), 'export const y = 2;\n');
    git('add "src/my file.ts"');
    expect(gateWithStub(bin).status).toBe(0);
  });

  it('a staged decision .md with NO_LLM → no depth judgement → passes (0)', () => {
    writeFileSync(
      join(repo, 'docs', 'decisions', 'fresh.md'),
      scopedTargetMd('fresh', 'src/x/**', 'r'),
    );
    git('add docs/decisions/fresh.md');
    expect(gate()).toBe(0);
  });

  it('a THIN depth verdict warns (0) by default; GUARD_DEPTH_HARD escalates to a block (1)', () => {
    const bin = join(repo, 'fakebin');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'claude');
    writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho THIN\n'); // stub: every judge → THIN
    chmodSync(fake, 0o755);
    writeFileSync(
      join(repo, 'docs', 'decisions', 'shallow.md'),
      scopedTargetMd('shallow', 'src/other/**', 'restate the prior ruling'), // scope avoids the alignment pass
    );
    git('add docs/decisions/shallow.md');
    const env = {
      ...process.env,
      GUARD_DECISIONS_DIR: join(repo, 'docs', 'decisions'),
      PATH: `${bin}:${process.env.PATH}`,
    };
    const warn = spawnSync('node', [GATE, '--gate'], { cwd: repo, encoding: 'utf8', env });
    expect(warn.status).toBe(0); // warn-only by default
    expect(warn.stderr).toContain('reads THIN');
    const hard = spawnSync('node', [GATE, '--gate'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...env, GUARD_DEPTH_HARD: '1' },
    });
    expect(hard.status).toBe(1); // escalated
    expect(hard.stderr).toContain('shallow');
  });
});

// The cascade mechanics, exercised in-process via the exported judge(). `judge` takes the repo cwd
// explicitly (3rd arg) and resolves config (noLlm) from it, so no DECISIONS_ROOT / import-time env
// dance is needed — each test just points judge at its own temp repo with a PATH-stubbed claude.
describe('judge cascade (in-process, stubbed claude on PATH)', () => {
  let repo;
  let savedPath;
  let log;
  const target = { ruling: 'stay generic', vision: 'v' };
  const sh = (a) => execSync(a, { cwd: repo, encoding: 'utf8' });
  const useStub = (script) => {
    process.env.PATH = `${stubClaude(repo, script)}:${savedPath}`;
    process.env.CLAUDE_STUB_LOG = log;
  };
  const calls = () => readFileSync(log, 'utf8');

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'align-judge-'));
    log = join(repo, 'calls.log');
    savedPath = process.env.PATH;
    sh('git init -q && git config user.email t@t.t && git config user.name t');
    writeFileSync(join(repo, 'base.ts'), 'export const x = 1;\n');
    sh('git add . && git commit -qm base');
    writeFileSync(join(repo, 'rogue.ts'), 'export const y = 2;\n');
    sh('git add rogue.ts');
    delete process.env.GUARD_DECISION_NO_LLM;
    delete process.env.FRINK_DECISION_NO_LLM;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    delete process.env.CLAUDE_STUB_LOG;
    delete process.env.GUARD_DECISION_NO_LLM;
    rmSync(repo, { recursive: true, force: true });
  });

  it('a non-CONTRADICT first verdict resolves on the haiku call alone (no escalation)', () => {
    useStub('echo "$*" >> "$CLAUDE_STUB_LOG"\nprintf "Cannot determine.\\nVERDICT: UNCLEAR\\n"\n');
    expect(judge(['rogue.ts'], target, repo)).toBe('UNCLEAR');
    expect(calls().match(/--model haiku/g)).toHaveLength(1);
    expect(calls()).not.toContain('--model opus');
  });

  it('haiku CONTRADICT escalates exactly once; opus confirms → CONTRADICT', () => {
    useStub('echo "$*" >> "$CLAUDE_STUB_LOG"\nprintf "VERDICT: CONTRADICT\\n"\n');
    expect(judge(['rogue.ts'], target, repo)).toBe('CONTRADICT');
    expect(calls().match(/--model haiku/g)).toHaveLength(1);
    expect(calls().match(/--model opus/g)).toHaveLength(1);
  });

  it('opus overturn wins, and its prompt embeds the full haiku transcript (rubber-ducky handoff)', () => {
    useStub(
      'echo "$*" >> "$CLAUDE_STUB_LOG"\ncase "$*" in\n' +
        '  *"--model haiku"*) printf "Flag flip departs from the ruling.\\nVERDICT: CONTRADICT\\n";;\n' +
        '  *) printf "Re-checked the hunks: a normal rollout step.\\nVERDICT: ALIGN\\n";;\nesac\n',
    );
    expect(judge(['rogue.ts'], target, repo)).toBe('ALIGN');
    expect(calls()).toContain('first-pass reviewer');
    expect(calls()).toContain('Flag flip departs from the ruling.');
  });

  it('a crashing haiku → null (fail-open), no escalation attempted', () => {
    useStub('echo "$*" >> "$CLAUDE_STUB_LOG"\nexit 3\n');
    expect(judge(['rogue.ts'], target, repo)).toBeNull();
    expect(calls()).not.toContain('--model opus');
  });

  it('GUARD_DECISION_NO_LLM short-circuits to null before any spawn', () => {
    useStub('echo "$*" >> "$CLAUDE_STUB_LOG"\nprintf "VERDICT: CONTRADICT\\n"\n');
    process.env.GUARD_DECISION_NO_LLM = '1';
    expect(judge(['rogue.ts'], target, repo)).toBeNull();
    expect(existsSync(log)).toBe(false);
  });
});
