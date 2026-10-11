/**
 * Brief and read telemetry, through the real `guard-decisions` bin in a temp consumer: which call
 * writes which row, and that no row ever changes what the call prints.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EVENT_BUDGET } from '../../judge/odb-probe.mts';

const CLI = fileURLToPath(new URL('../cli.mts', import.meta.url));
const SESSION = 'read-telemetry-session';
const LONG_RULING = `Long ruling. ${'x'.repeat(400)}`;
const BRIEF = ['scoped-targets', '--files', 'src/a.ts', '--brief', 'Edit,3,320'];
const ENVELOPE_KEYS = new Set([
  'ship_id',
  'run_mode',
  'repo',
  'branch',
  'source',
  'devkit_version',
  'parent_session_id',
  'ts',
]);

/** Preloaded before the entry links, so the parser fails where a missing install does. */
const HIDE_MDAST = `data:text/javascript,${encodeURIComponent(`
  import { registerHooks } from 'node:module';
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'mdast-util-from-markdown') {
        const err = new Error("Cannot find package 'mdast-util-from-markdown'");
        err.code = 'ERR_MODULE_NOT_FOUND';
        throw err;
      }
      return nextResolve(specifier, context);
    },
  });
`)}`;

let root: string;
let sink: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'read-telemetry-'));
  sink = join(root, 'events.jsonl');
  writeFileSync(join(root, 'guard.config.json'), '{"decisionsDir":"docs/decisions"}\n');
  mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeAxis(slug: string, ruling: string) {
  writeFileSync(
    join(root, 'docs', 'decisions', `${slug}.md`),
    `---\nslug: ${slug}\ncreated: 2026-01-01\n---\n\n## Target · 2026-01-01 — ${slug}\n\n` +
      `**Ruling:** ${ruling}\n**Scope:** src/**\n`,
  );
}

/** Six axes govern src/a.ts, so the hook's MAX_AXES of 3 hides three; one ruling runs past 320. */
function sixAxes() {
  for (let i = 0; i < 6; i += 1) writeAxis(`axis-${i}`, i === 0 ? LONG_RULING : `Ruling ${i}.`);
}

function cli(args: string[], env: NodeJS.ProcessEnv = {}, preload?: string) {
  return spawnSync('node', [...(preload ? ['--import', preload] : []), CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      CLAUDE_CODE_SESSION_ID: SESSION,
      DECISIONS_NO_EMBED: '1',
      DEVKIT_GATE_EVENTS: sink,
      DEVKIT_NO_TELEMETRY: undefined,
      DEVKIT_AGENT_RUN_ID: undefined,
      ...env,
    },
  });
}

/** One sink line: the fields asserted on directly, plus whatever the envelope adds. */
interface Row {
  type: string;
  file?: string;
}

function rows(): Row[] {
  if (!existsSync(sink)) return [];
  return readFileSync(sink, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('brief rows from scoped-targets', () => {
  it('records the brief the hook prints, and leaves stdout byte-identical', () => {
    sixAxes();
    const plain = cli(['scoped-targets', '--files', 'src/a.ts']);
    expect(rows()).toEqual([]);

    const briefed = cli(BRIEF);
    expect(briefed.stdout).toBe(plain.stdout);
    const blocks: { slug: string; ruling: string }[] = JSON.parse(plain.stdout);
    const slugs = blocks.map((b) => b.slug);
    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      type: 'brief_shown',
      file: 'src/a.ts',
      tool: 'Edit',
      shown: slugs.slice(0, 3),
      lengths: blocks.slice(0, 3).map((b) => b.ruling.length),
      hidden: slugs.slice(3),
      hidden_count: 3,
      cap: 320,
      max_axes: 3,
      run_mode: 'agent',
      parent_session_id: SESSION,
    });
    expect(all[0]).not.toHaveProperty('commit_tree');
    expect(all[0]).not.toHaveProperty('run_origin');
    expect(blocks.map((b) => b.ruling)).toContain(LONG_RULING);
  });

  it('writes nothing for an ungoverned file or a malformed --brief, and stdout does not move', () => {
    sixAxes();
    const ungoverned = cli(['scoped-targets', '--files', 'lib/b.ts']).stdout;
    expect(cli(['scoped-targets', '--files', 'lib/b.ts', '--brief', 'Edit,3,320']).stdout).toBe(
      ungoverned,
    );
    const governed = cli(['scoped-targets', '--files', 'src/a.ts']).stdout;
    for (const spec of ['Edit,3', 'Edit,0,320', 'Ed1t,3,320']) {
      expect(cli(['scoped-targets', '--files', 'src/a.ts', '--brief', spec]).stdout).toBe(governed);
    }
    expect(rows()).toEqual([]);
  });

  it('records a return to a briefed file without retrieving or printing anything', () => {
    sixAxes();
    // Retrieval would trip over this directory and exit 2, so a clean exit proves it never ran.
    mkdirSync(join(root, 'docs', 'decisions', 'broken.md'));
    const again = cli(['scoped-targets', '--files', 'src/a.ts', '--brief-again', 'Edit,42']);
    expect([again.status, again.stdout]).toEqual([0, '']);
    for (const bad of ['Edit,-1', 'Edit,x', 'Edit']) {
      expect(cli(['scoped-targets', '--files', 'src/a.ts', '--brief-again', bad]).stdout).toBe('');
    }
    expect(rows()).toMatchObject([
      {
        type: 'brief_edited_again',
        file: 'src/a.ts',
        tool: 'Edit',
        secs_since_brief: 42,
        run_mode: 'agent',
        parent_session_id: SESSION,
      },
    ]);
  });

  it('tells an unloadable engine apart from a retrieval error', () => {
    sixAxes();
    const unloadable = cli(BRIEF, {}, HIDE_MDAST);
    expect([unloadable.status, unloadable.stdout]).toEqual([1, '']);
    mkdirSync(join(root, 'docs', 'decisions', 'broken.md'));
    const broken = cli(BRIEF);
    expect([broken.status, broken.stdout]).toEqual([2, '[]']);
    expect(rows()).toMatchObject([
      {
        type: 'brief_unavailable',
        file: 'src/a.ts',
        reason: 'unloadable',
        dependency: 'mdast-util-from-markdown',
      },
      { type: 'brief_unavailable', file: 'src/a.ts', reason: 'error', run_mode: 'agent' },
    ]);
  });

  it('stays inside the event budget for a broad Scope and a 600-byte path', () => {
    for (let i = 0; i < 60; i += 1)
      writeAxis(`axis-${String(i).padStart(2, '0')}-${'s'.repeat(40)}`, 'r');
    const file = `src/${'p'.repeat(596)}`;
    expect(cli(['scoped-targets', '--files', file, '--brief', 'Edit,3,320']).status).toBe(0);
    const [row] = rows();
    expect(row).toMatchObject({ type: 'brief_shown', hidden_count: 57 });
    expect(row).not.toHaveProperty('hidden');
    expect(Buffer.byteLength(String(row.file))).toBeLessThan(Buffer.byteLength(file));
    const payload = Object.entries(row).filter(([k]) => !ENVELOPE_KEYS.has(k));
    expect(Buffer.byteLength(JSON.stringify(Object.fromEntries(payload)))).toBeLessThanOrEqual(
      EVENT_BUDGET,
    );
  });
});

describe('decision_read from show and query', () => {
  it('logs a successful show or query, and nothing for a failed show', () => {
    sixAxes();
    expect(cli(['show', 'axis-1']).status).toBe(0);
    expect(cli(['show', 'missing']).status).toBe(1);
    expect(cli(['query', 'x']).status).toBe(0);
    expect(rows()).toMatchObject([
      { type: 'decision_read', command: 'show', slugs: ['axis-1'], run_mode: 'agent' },
      { type: 'decision_read', command: 'query', top: 5, parent_session_id: SESSION },
    ]);
  });

  it('writes no file at all with telemetry off and no sink', () => {
    sixAxes();
    const off = { DEVKIT_NO_TELEMETRY: '1', DEVKIT_GATE_EVENTS: undefined };
    cli(BRIEF, off);
    cli(['scoped-targets', '--files', 'src/a.ts', '--brief-again', 'Edit,1'], off);
    cli(['show', 'axis-1'], off);
    cli(['query', 'x'], off);
    expect(existsSync(join(root, '.devkit'))).toBe(false);
    expect(existsSync(sink)).toBe(false);
  });
});
