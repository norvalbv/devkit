/** The two synced base-drift hooks, driven the way a harness drives them: real stdin, real spawn. */
import { spawnSync } from 'node:child_process';
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
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const BRIEF = fileURLToPath(new URL('../../agents-hooks/base-drift-brief.mjs', import.meta.url));
const SESSION = fileURLToPath(
  new URL('../../agents-hooks/base-drift-session.mjs', import.meta.url),
);

const made: string[] = [];
let root: string;
let markerHome: string;

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const mk = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** The base-status payload shape these tests hand the hooks, incl. deliberately malformed ones. */
interface CannedReport {
  schema: number;
  base?: { kind: string; base: string; ref: string; source: string; sha: string };
  silent?: null | string;
  overlap?: { path: string; status: string; matched: string; commit: null; rearm: string }[];
  rendered?: Partial<Record<'session' | 'edit' | 'ship' | 'status', string>>;
}

/** A `devkit` on the hook's resolution path that prints one canned base-status payload. */
function stubDevkit(canned: CannedReport | null): void {
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const script =
    canned === null
      ? '#!/bin/sh\nexit 1\n'
      : `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(canned)}\nJSON\n`;
  writeFileSync(join(bin, 'devkit'), script);
  chmodSync(join(bin, 'devkit'), 0o755);
}

/** Like stubDevkit, but appends every argument of each call to `sink`. */
function stubDevkitRecordingAll(canned: CannedReport, sink: string[][]): void {
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const log = join(root, 'calls.log');
  writeFileSync(
    join(bin, 'devkit'),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\nprintf '\\n' >> '${log}'\ncat <<'JSON'\n${JSON.stringify(canned)}\nJSON\n`,
  );
  chmodSync(join(bin, 'devkit'), 0o755);
  recorders.set(log, sink);
}

/** Like stubDevkit, but appends the `--`-separated paths of each call to `sink`. */
function stubDevkitRecording(canned: CannedReport, sink: string[][]): void {
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const log = join(root, 'calls.log');
  writeFileSync(
    join(bin, 'devkit'),
    `#!/bin/sh\nseen=0\nfor a in "$@"; do\n  if [ "$seen" = "1" ]; then printf '%s\\n' "$a" >> '${log}'; fi\n  if [ "$a" = "--" ]; then seen=1; fi\ndone\nprintf '\\n' >> '${log}'\ncat <<'JSON'\n${JSON.stringify(canned)}\nJSON\n`,
  );
  chmodSync(join(bin, 'devkit'), 0o755);
  recorders.set(log, sink);
}

const recorders = new Map<string, string[][]>();

/** Drain any recorded invocation into its sink. Called after each hook run. */
function drainRecorders(): void {
  for (const [log, sink] of recorders) {
    if (!existsSync(log)) continue;
    for (const block of readFileSync(log, 'utf8').split('\n\n')) {
      const paths = block.split('\n').filter(Boolean);
      if (paths.length > 0) sink.push(paths);
    }
    rmSync(log, { force: true });
  }
}

function payload({
  rendered = { session: 'SESSION TEXT', edit: 'EDIT TEXT', ship: '', status: '' },
  rearm = 'a'.repeat(16),
  sha = 'basesha1',
  overlap,
}: {
  rendered?: CannedReport['rendered'];
  rearm?: string;
  sha?: string;
  overlap?: string[];
} = {}) {
  return {
    schema: 1,
    base: { kind: 'resolved', base: 'main', ref: 'refs/remotes/origin/main', source: 'main', sha },
    silent: null,
    overlap: (overlap ?? ['a.mts']).map((path, index) => ({
      path,
      status: 'M',
      matched: path,
      // A distinct token per path, the way the core mints them.
      rearm: overlap ? `${path}-token`.padEnd(16, '0') : rearm,
      commit: null,
      index,
    })),
    rendered,
  };
}

/** The tool payload shapes these hooks are driven with: providers vary in both key and depth. */
interface ToolInput {
  file_path?: string;
  path?: string;
  target_file?: string;
  target_path?: string;
  edits?: { file_path?: string; old_string?: string; new_string?: string }[];
}

/** The harness payloads these hooks are driven with — a PreToolUse call or a SessionStart event. */
interface HookInput {
  hook_event_name?: string;
  source?: string;
  tool_name?: string;
  session_id?: string;
  cursor_version?: string;
  tool_input?: ToolInput;
}

const runHook = (hook: string, input: HookInput) => {
  const out = spawnSync(process.execPath, [hook], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, TMPDIR: markerHome },
    input: JSON.stringify(input),
  }).stdout.trim();
  drainRecorders();
  return out;
};

const context = (raw: string) => (raw ? JSON.parse(raw).hookSpecificOutput.additionalContext : '');

beforeEach(() => {
  recorders.clear();
  root = mk('bd-hook-root-');
  // A private TMPDIR per test, so one test's dedup markers cannot silence another's.
  markerHome = mk('bd-hook-tmp-');
});

describe('base-drift-brief (PreToolUse)', () => {
  const edit = (file: string, session = 's1', tool = 'Edit') => ({
    tool_name: tool,
    session_id: session,
    tool_input: { file_path: file },
  });

  it('emits an advisory — and never a permissionDecision — for a drifted path', () => {
    stubDevkit(payload());
    const raw = runHook(BRIEF, edit('a.mts'));
    expect(context(raw)).toBe('EDIT TEXT');
    // Returning `allow` here would strip the user's own permission prompts; returning `deny` would
    // block an edit over an advisory. Neither may ever appear.
    expect(raw).not.toContain('permissionDecision');
  });

  it('fires for Write and MultiEdit too — Cursor projects this hook onto Write', () => {
    stubDevkit(payload());
    for (const tool of ['Write', 'MultiEdit']) {
      expect(context(runHook(BRIEF, edit('a.mts', `sess-${tool}`, tool)))).toBe('EDIT TEXT');
    }
  });

  it("answers Cursor in ITS envelope, not Claude's, or the advisory is dropped", () => {
    stubDevkit(payload());
    const raw = runHook(BRIEF, {
      cursor_version: '1.0',
      tool_name: 'Write',
      session_id: 'cursor-1',
      tool_input: { path: 'a.mts' },
    });
    const parsed = JSON.parse(raw);
    expect(parsed.agent_message).toBe('EDIT TEXT');
    expect(parsed.hookSpecificOutput).toBeUndefined();
    // Never a permission verdict: `deny` would block an edit over an advisory, and `allow` would
    // strip the user's own permission prompts.
    expect(parsed.permission).toBeUndefined();
  });

  it('finds a MultiEdit-shaped path nested below the top level', () => {
    // Providers disagree about depth as well as key name; a top-level-only read would treat these
    // calls as having no path and go silent on exactly the edits it exists to warn about.
    stubDevkit(payload());
    const nested = {
      tool_name: 'MultiEdit',
      session_id: 'nested-1',
      tool_input: { edits: [{ file_path: 'a.mts', old_string: 'x', new_string: 'y' }] },
    };
    expect(context(runHook(BRIEF, nested))).toBe('EDIT TEXT');
  });

  it('checks EVERY file a MultiEdit touches, not just the first', () => {
    // Warning about one file of a multi-file call leaves the rest of that same call unchecked.
    const seen: string[][] = [];
    stubDevkitRecording(payload(), seen);
    const multi = {
      tool_name: 'MultiEdit',
      session_id: 'multi-1',
      tool_input: {
        edits: [{ file_path: 'a.mts' }, { file_path: 'b.mts' }, { file_path: 'a.mts' }],
      },
    };
    expect(context(runHook(BRIEF, multi))).toBe('EDIT TEXT');
    // Both distinct paths reach base-status; the duplicate is collapsed.
    const passed = seen.at(-1) ?? [];
    expect(passed).toContain('a.mts');
    expect(passed).toContain('b.mts');
    expect(passed.filter((p) => p === 'a.mts')).toHaveLength(1);
  });

  it('dedups PER PATH, so a later single-file edit of a briefed path stays quiet', () => {
    // An aggregate token would mint a different key per file-combination, repeating the advisory
    // for a path the session has already been told about.
    stubDevkit(payload({ overlap: ['a.mts', 'b.mts'] }));
    const multi = {
      tool_name: 'MultiEdit',
      session_id: 'perpath',
      tool_input: { edits: [{ file_path: 'a.mts' }, { file_path: 'b.mts' }] },
    };
    expect(context(runHook(BRIEF, multi))).toBe('EDIT TEXT');

    // Both paths are now claimed, so either one alone is silent…
    stubDevkit(payload({ overlap: ['a.mts'] }));
    expect(
      runHook(BRIEF, {
        tool_name: 'Edit',
        session_id: 'perpath',
        tool_input: { file_path: 'a.mts' },
      }),
    ).toBe('');
    // …while a path never briefed still speaks.
    stubDevkit(payload({ overlap: ['c.mts'] }));
    expect(
      context(
        runHook(BRIEF, {
          tool_name: 'Edit',
          session_id: 'perpath',
          tool_input: { file_path: 'c.mts' },
        }),
      ),
    ).toBe('EDIT TEXT');
  });

  it('rides the shared TTL window rather than fetching on every edit', () => {
    // Omitting the flag makes base-status FORCE a fetch, which on the pre-edit path means one
    // network round trip per keystroke-level edit instead of one per window per clone.
    const seen: string[][] = [];
    stubDevkitRecordingAll(payload(), seen);
    runHook(BRIEF, { tool_name: 'Edit', session_id: 'ttl-1', tool_input: { file_path: 'a.mts' } });
    expect((seen.at(-1) ?? []).join(' ')).toContain('--cached-ok');
  });

  it('ignores a tool that does not write a file', () => {
    stubDevkit(payload());
    expect(
      runHook(BRIEF, { tool_name: 'Read', session_id: 's1', tool_input: { file_path: 'a.mts' } }),
    ).toBe('');
    expect(runHook(BRIEF, { tool_name: 'Edit', session_id: 's1', tool_input: {} })).toBe('');
  });

  it('briefs once per (session, path, base sha) and again once the base MOVES', () => {
    stubDevkit(payload({ rearm: 'first'.padEnd(16, '0') }));
    expect(context(runHook(BRIEF, edit('a.mts')))).toBe('EDIT TEXT');
    expect(runHook(BRIEF, edit('a.mts'))).toBe('');

    // A second move of the base yields a new rearm token, which must re-arm the same file.
    stubDevkit(payload({ rearm: 'second'.padEnd(16, '0') }));
    expect(context(runHook(BRIEF, edit('a.mts')))).toBe('EDIT TEXT');
  });

  it('keeps sessions independent — one briefed session does not silence another', () => {
    stubDevkit(payload());
    expect(context(runHook(BRIEF, edit('a.mts', 'session-a')))).toBe('EDIT TEXT');
    expect(context(runHook(BRIEF, edit('a.mts', 'session-b')))).toBe('EDIT TEXT');
  });

  it('says nothing when the report is silent', () => {
    stubDevkit(payload({ rendered: { session: '', edit: '', ship: '', status: '' } }));
    expect(runHook(BRIEF, edit('a.mts'))).toBe('');
  });

  it('fails open when devkit is absent, fails, or answers with nonsense', () => {
    // No stub at all: nothing on the resolution path.
    expect(runHook(BRIEF, edit('a.mts'))).toBe('');
    stubDevkit(null);
    expect(runHook(BRIEF, edit('a.mts', 's-fail'))).toBe('');
    stubDevkit({ schema: 99, rendered: { edit: 'FROM THE FUTURE' } });
    expect(runHook(BRIEF, edit('a.mts', 's-schema'))).toBe('');
  });

  it('fails open on unparseable stdin', () => {
    stubDevkit(payload());
    const run = spawnSync(process.execPath, [BRIEF], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, TMPDIR: markerHome },
      input: 'not json at all',
    });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('');
  });
});

describe('base-drift-session (SessionStart)', () => {
  const start = (session = 's1', source = 'startup') => ({
    hook_event_name: 'SessionStart',
    session_id: session,
    source,
  });

  it('emits the whole-repo brief once per session at startup', () => {
    stubDevkit(payload());
    expect(context(runHook(SESSION, start()))).toBe('SESSION TEXT');
    expect(runHook(SESSION, start())).toBe('');
  });

  it('briefs on an UNKNOWN source rather than assuming context survived', () => {
    stubDevkit(payload());
    const unsourced = { hook_event_name: 'SessionStart', session_id: 'no-source' };
    expect(context(runHook(SESSION, unsourced))).toBe('SESSION TEXT');
    expect(context(runHook(SESSION, unsourced))).toBe('SESSION TEXT');
  });

  it('briefs again after a resume once the base has MOVED', () => {
    // The session key folds in the base sha, so a compact/resume against an unchanged base stays
    // quiet while one against a moved base re-briefs.
    stubDevkit(payload({ sha: 'sha-one' }));
    expect(context(runHook(SESSION, start('resumed')))).toBe('SESSION TEXT');
    expect(runHook(SESSION, start('resumed'))).toBe('');
    stubDevkit(payload({ sha: 'sha-two' }));
    expect(context(runHook(SESSION, start('resumed')))).toBe('SESSION TEXT');
  });

  it('briefs again after a compact, which DROPS the earlier brief from context', () => {
    // `compact` is in the matcher precisely so the brief can be re-asserted. A stamp keyed only on
    // the session and base SHA would make the startup brief silence every later compaction.
    stubDevkit(payload());
    expect(context(runHook(SESSION, { ...start('long-run'), source: 'startup' }))).toBe(
      'SESSION TEXT',
    );
    expect(runHook(SESSION, { ...start('long-run'), source: 'startup' })).toBe('');
    // Every compaction drops the brief again, so every compaction re-asserts it — deduping these
    // would silence exactly the event the matcher lists them for.
    for (const source of ['compact', 'clear', 'compact', 'compact']) {
      expect(context(runHook(SESSION, { ...start('long-run'), source }))).toBe('SESSION TEXT');
    }
  });

  it('fails open when devkit is absent', () => {
    expect(runHook(SESSION, start())).toBe('');
  });
});
