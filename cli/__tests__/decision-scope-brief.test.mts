import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('../../agents-hooks/decision-scope-brief.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../../gate-engine/decisions/cli.mts', import.meta.url));

let root: string;
let n = 0;

/** A consumer repo with one scoped ruling and a stub `guard-decisions` on its node_modules/.bin. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'brief-'));
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Stub the CLI: the hook's contract with it is only "scoped-targets --files <p> prints JSON". */
function stubBin(stdout: string, status = 0) {
  const bin = join(root, 'node_modules', '.bin', 'guard-decisions');
  writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${status}\n`, { mode: 0o755 });
}

/** Stub the CLI with an arbitrary script, for failure shapes stubBin's template cannot express. */
function rawStubBin(script: string) {
  const bin = join(root, 'node_modules', '.bin', 'guard-decisions');
  writeFileSync(bin, script, { mode: 0o755 });
}

/** Stub the CLI and log each spawn's argv to argv.log, one line per call. */
function loggingStubBin(stdout: string) {
  const log = join(root, 'argv.log');
  rawStubBin(`#!/bin/sh\necho "$*" >> '${log}'\ncat <<'EOF'\n${stdout}\nEOF\n`);
}

function loggedCalls() {
  return readFileSync(join(root, 'argv.log'), 'utf8').trim().split('\n');
}

function run(
  toolInput: Record<string, string>,
  toolName = 'Edit',
  session?: string,
  env: NodeJS.ProcessEnv = {},
) {
  let sessionId = session;
  if (sessionId === undefined) {
    n += 1;
    sessionId = `s${n}`;
  }
  return spawnSync('node', [HOOK], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
    input: JSON.stringify({ tool_name: toolName, session_id: sessionId, tool_input: toolInput }),
  }).stdout.trim();
}

const GOVERNED = JSON.stringify([
  {
    slug: 'retrieval-candidate-set',
    ruling: 'Candidates come from the directory.',
    scope: 'src/**',
  },
]);

describe('decision-scope-brief', () => {
  it('briefs the governing ruling before a governed file is edited', () => {
    stubBin(GOVERNED);
    const out = JSON.parse(run({ file_path: 'src/a.ts' }));
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('retrieval-candidate-set');
    expect(out.hookSpecificOutput.additionalContext).toContain('src/a.ts');
  });

  // Advisory means advisory. Emitting `permissionDecision: "allow"` would auto-approve every edit and
  // silently strip the user's permission prompts — a far worse outcome than a missed hint — and
  // "deny" would let a decision record block ordinary work.
  it('never returns a permission decision, so it can neither block nor auto-approve a write', () => {
    stubBin(GOVERNED);
    const out = JSON.parse(run({ file_path: 'src/a.ts' }));
    expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision');
    expect(out).not.toHaveProperty('permissionDecisionReason');
  });

  it('stays silent when no ruling governs the file', () => {
    stubBin('[]');
    expect(run({ file_path: 'src/a.ts' })).toBe('');
  });

  // Repetition is how an advisory dies: re-shown on all thirty edits to one file, an agent learns to
  // skip it. One brief per (session, file).
  it('briefs a given file once per session, not on every edit', () => {
    stubBin(GOVERNED);
    const session = 'repeat-session';
    expect(run({ file_path: 'src/a.ts' }, 'Edit', session)).not.toBe('');
    expect(run({ file_path: 'src/a.ts' }, 'Edit', session)).toBe('');
    // …but a DIFFERENT file in the same session is still briefed.
    expect(run({ file_path: 'src/b.ts' }, 'Edit', session)).not.toBe('');
  });

  it('generates a fresh session for every call that omits one', () => {
    stubBin(GOVERNED);
    expect(run({ file_path: 'src/a.ts' })).not.toBe('');
    expect(run({ file_path: 'src/a.ts' })).not.toBe('');
  });

  it('ignores non-mutating tools', () => {
    stubBin(GOVERNED);
    expect(run({ file_path: 'src/a.ts' }, 'Read')).toBe('');
  });

  it('ignores paths outside the project', () => {
    stubBin(GOVERNED);
    expect(run({ file_path: '/etc/hosts' })).toBe('');
  });

  // A brief that never arrives is indistinguishable from "nothing governs this file", so for an
  // OUTAGE silence is the harmful choice. No failure mode may cost the edit either way.
  it('stays silent when the guard CLI is absent — the repo simply does not use decisions', () => {
    // Not an outage: nothing is installed to be broken, and briefing on every edit in a repo that
    // does not use decisions would be pure noise.
    expect(run({ file_path: 'src/a.ts' })).toBe('');
  });

  it('reports that retrieval did not run when the CLI errors', () => {
    // `boom` on stdout AND exit 1: the classifier must key on status, never on stdout emptiness.
    stubBin('boom', 1);
    const out = JSON.parse(run({ file_path: 'src/a.ts' }));
    expect(out.hookSpecificOutput.additionalContext).toContain('DID NOT RUN');
    expect(out.hookSpecificOutput.additionalContext).toContain('UNBRIEFED, not ungoverned');
    expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision');
  });

  it('reports that retrieval did not run when the CLI prints unparseable output', () => {
    stubBin('not json at all');
    expect(run({ file_path: 'src/a.ts' })).toContain('DID NOT RUN');
  });

  it('reports that retrieval did not run when the CLI exits 0 with no output', () => {
    // scoped-targets writes JSON on EVERY path, so exit 0 with nothing is a contract violation —
    // not the "nothing governs" answer it used to be silently folded into.
    stubBin('');
    expect(run({ file_path: 'src/a.ts' })).toContain('DID NOT RUN');
  });

  it('reports that retrieval did not run when the output parses but is not an array', () => {
    // `!Array.isArray(axes)` and `axes.length === 0` were one branch and are not one fact.
    stubBin('{"slug":"a"}');
    expect(run({ file_path: 'src/a.ts' })).toContain('DID NOT RUN');
  });

  it('notices the outage once per session, without consuming the file own brief slot', () => {
    stubBin('boom', 1);
    expect(run({ file_path: 'src/a.ts' }, 'Edit', 'sticky')).toContain('DID NOT RUN');
    expect(run({ file_path: 'src/b.ts' }, 'Edit', 'sticky')).toBe('');

    // The stamp must NOT have burned src/a.ts's slot: once the tool works again, the real brief
    // still fires for that file. Stamping `rel` on the outage path would re-create this very defect.
    stubBin(GOVERNED);
    expect(run({ file_path: 'src/a.ts' }, 'Edit', 'sticky')).toContain('retrieval-candidate-set');
  });

  it('stays silent on malformed hook input', () => {
    stubBin(GOVERNED);
    const out = spawnSync('node', [HOOK], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      input: 'not json',
    });
    expect(out.stdout.trim()).toBe('');
    expect(out.status).toBe(0);
  });

  it('caps how many axes it names, so a broadly-scoped file cannot flood the context', () => {
    stubBin(
      JSON.stringify(
        Array.from({ length: 6 }, (_, i) => ({ slug: `axis-${i}`, ruling: 'r', scope: 'src/**' })),
      ),
    );
    const ctx = JSON.parse(run({ file_path: 'src/a.ts' })).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('axis-0');
    expect(ctx).not.toContain('axis-5');
    expect(ctx).toContain('3 more');
  });
});

describe('decision-scope-brief — failure shapes and the real CLI behind it', () => {
  it('briefs normally when the CLI terminates its JSON with CRLF', () => {
    // Two recorded CRLF defects (sc-2284, sc-2473 on decision-format-parsed-not-regexed) say pin
    // the benign case: a brief that vanishes on a Windows checkout reads as "nothing governs".
    rawStubBin(`#!/bin/sh\ncat <<'EOF'\n${GOVERNED}\r\nEOF\n`);
    expect(run({ file_path: 'src/a.ts' })).toContain('retrieval-candidate-set');
  });

  it('reports that retrieval did not run when the CLI dies on a signal', () => {
    // spawnSync reports status null for a killed child — the same shape as the 10s timeout, which
    // no other test reaches. The classifier must not read null as "exit 0".
    rawStubBin('#!/bin/sh\nkill -9 $$\n');
    expect(run({ file_path: 'src/a.ts' })).toContain('DID NOT RUN');
  });

  it('reports that retrieval did not run when the CLI prints JSON null', () => {
    rawStubBin('#!/bin/sh\necho null\n');
    expect(run({ file_path: 'src/a.ts' })).toContain('DID NOT RUN');
  });

  // Wiring, not units: an outage on the CLI side must arrive as an outage on the hook side.
  it('reports the outage when the real guard-decisions cannot load its parser', () => {
    const preload = join(root, 'hide-parser.mjs');
    writeFileSync(
      preload,
      `import { registerHooks } from 'node:module';
       registerHooks({
         resolve(specifier, context, nextResolve) {
           if (specifier === 'mdast-util-from-markdown') {
             const err = new Error("Cannot find package 'mdast-util-from-markdown'");
             err.code = 'ERR_MODULE_NOT_FOUND';
             throw err;
           }
           return nextResolve(specifier, context);
         },
       });`,
    );
    rawStubBin(`#!/bin/sh\nexec node --import ${preload} ${CLI} "$@"\n`);

    expect(run({ file_path: 'src/a.ts' })).toContain('DID NOT RUN');
  });
});

describe('decision-scope-brief — what it asks the CLI to record', () => {
  it('passes --brief on the first edit, --brief-again once on the second, and nothing after', () => {
    loggingStubBin(GOVERNED);
    for (let i = 0; i < 4; i += 1) run({ file_path: 'src/a.ts' }, 'Edit', 'argv-session');
    expect(loggedCalls()).toEqual([
      'scoped-targets --files src/a.ts --brief Edit,3,320',
      expect.stringMatching(/^scoped-targets --files src\/a\.ts --brief-again Edit,\d+$/),
    ]);
  });

  it('asks afresh on every edit to an ungoverned file, since no stamp is written', () => {
    loggingStubBin('[]');
    for (let i = 0; i < 3; i += 1) run({ file_path: 'src/a.ts' }, 'Write', 'ungoverned');
    expect(loggedCalls()).toEqual(
      Array(3).fill('scoped-targets --files src/a.ts --brief Write,3,320'),
    );
  });

  it('still briefs when the stamp directory cannot be read', () => {
    stubBin(GOVERNED);
    const stamps = join(root, 'tmp', 'devkit-decision-brief');
    mkdirSync(stamps, { recursive: true });
    chmodSync(stamps, 0o000);
    try {
      const out = run({ file_path: 'src/a.ts' }, 'Edit', 'locked', { TMPDIR: join(root, 'tmp') });
      expect(out).toContain('retrieval-candidate-set');
    } finally {
      chmodSync(stamps, 0o755);
    }
  });

  it('logs the lengths it printed: each shown ruling is min(length, cap) long', () => {
    const dir = join(root, 'docs', 'decisions');
    mkdirSync(dir, { recursive: true });
    for (const [slug, ruling] of [
      ['a-short', 'Short.'],
      ['b-long', 'r'.repeat(500)],
    ]) {
      writeFileSync(
        join(dir, `${slug}.md`),
        `---\nslug: ${slug}\ncreated: 2026-01-01\n---\n\n## Target · 2026-01-01 — ${slug}\n\n` +
          `**Ruling:** ${ruling}\n**Scope:** src/**\n`,
      );
    }
    rawStubBin(`#!/bin/sh\nexec node '${CLI}' "$@"\n`);
    const sink = join(root, 'events.jsonl');
    const out = run({ file_path: 'src/a.ts' }, 'Edit', 'parity', { DEVKIT_GATE_EVENTS: sink });
    const ctx: string = JSON.parse(out).hookSpecificOutput.additionalContext;
    const printed = [...ctx.matchAll(/^- \*\*(.+?)\*\* — (.*?)…?$/gm)].map((m) => [
      m[1],
      m[2].length,
    ]);
    const row: { shown: string[]; lengths: number[]; cap: number } = JSON.parse(
      readFileSync(sink, 'utf8'),
    );
    expect(row.lengths).toContain(500);
    expect(printed).toEqual(row.lengths.map((len, i) => [row.shown.at(i), Math.min(len, row.cap)]));
  });
});
