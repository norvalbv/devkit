import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INHERITED_RUN_ENV,
  SCRUBBED_ENV,
  SHIP_EXPORTED_ENV,
  SUITE_GIT_IDENTITY,
} from '../../vitest.setup.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const SETUP = path.join(REPO, 'vitest.setup.mjs');
// Every ship script, so a new one's exports are checked without anyone listing it.
const SHIP_SCRIPTS = readdirSync(path.join(REPO, 'cli/lib/ship'))
  .filter((f) => f.endsWith('.sh'))
  .map((f) => `cli/lib/ship/${f}`);

const read = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8');

/** Every DEVKIT_/GUARD_ name a shell script `export`s, including inline `then export X=…`. */
function exportedNames(source: string): string[] {
  // A `#` opens a comment only at line start or after whitespace; `${#var}` is a length, not one.
  const code = source.replace(/(^|\s)#.*$/gm, '$1');
  const names: string[] = [];
  for (const [, tail = ''] of code.matchAll(
    /(?:^|[;&|]|\b(?:then|do|else))\s*export\s+([^;&|\n]*)/gm,
  )) {
    if (tail.startsWith('-n')) continue; // `export -n` un-exports
    for (const token of tail.split(/\s+/)) {
      const name = token.match(/^([A-Z][A-Z0-9_]*)(?:=|$)/)?.[1];
      if (name) names.push(name);
    }
  }
  return [...new Set(names)].filter((n) => n.startsWith('DEVKIT_') || n.startsWith('GUARD_'));
}

/** A full outer-ship environment, valued as ship-branch.sh would actually value it. */
const SHIP_ENV = {
  DEVKIT_RUN_MODE: 'ship',
  DEVKIT_REVIEW_GUARDS: 'comments',
  DEVKIT_REVIEW_PROGRESS: '/tmp/outer/progress.json',
  DEVKIT_SHIP: '1',
  DEVKIT_SHIP_BASE_SHA: 'a'.repeat(40),
  DEVKIT_SHIP_BRANCH: 'outer/ship-branch',
  DEVKIT_SHIP_DRY_GATES: '1',
  DEVKIT_SHIP_DRY_REVIEWERS: '1',
  DEVKIT_SHIP_FROM_BRANCH: '1',
  DEVKIT_SHIP_ID: 'outer-ship-id',
  DEVKIT_SHIP_INTENT_RECORDED: '1',
  DEVKIT_SHIP_MODE: 'ship',
  DEVKIT_SHIP_PATHS: 'src/a.ts\nsrc/b.ts',
  DEVKIT_SHIP_PR_BASE_SHA: 'c'.repeat(40),
  DEVKIT_SHIP_REPO: 'benordlabs/devkit',
  DEVKIT_SHIP_RESUMED: '0',
  DEVKIT_SHIP_ROOT: '/outer/ship/worktree',
  DEVKIT_SHIP_SOURCE_HEAD: 'b'.repeat(40),
  DEVKIT_TELEMETRY_VERSION: '9.9.9',
  FRINK_AI_STRICT: '1',
  GUARD_AI_STRICT: '1',
  GUARD_DECISIONS_DIR: '/elsewhere/docs/decisions',
};

/** Loads vitest.setup.mjs in a clean node process and reports the env it leaves behind. */
function envAfterSetup(extra: Record<string, string>): Record<string, string | undefined> {
  const stdout = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(pathToFileURL(SETUP).href)});
       process.stdout.write(JSON.stringify(process.env));`,
    ],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...extra } },
  );
  return JSON.parse(stdout);
}

describe('vitest.setup.mjs scrubs inherited gate policy', () => {
  it('matches the authority list cli/lib/ship/review-target.sh unsets', () => {
    // Two scrubs of the same vocabulary, one in shell and one here. A name in only one list is a
    // hole in whichever path uses the shorter one.
    const sh = read('cli/lib/ship/review-target.sh');
    const body = sh.match(/^for name in \\\n([\s\S]*?)\ndo$/m)?.[1];
    expect(body).toBeDefined();
    const names = body?.match(/\b[A-Z][A-Z0-9_]+\b/g) ?? [];
    expect([...new Set(names)].sort()).toEqual([...INHERITED_RUN_ENV].sort());
  });

  it('covers every policy name the ship scripts actually export', () => {
    // review-target.sh guards a review ENTRYPOINT, so its list is not a superset of what a ship
    // exports downstream — the delta is the half that reaches the suite unscrubbed.
    const exported = [...new Set(SHIP_SCRIPTS.flatMap((f) => exportedNames(read(f))))];
    expect(exported.length).toBeGreaterThan(10);
    for (const name of exported) expect(SCRUBBED_ENV, name).toContain(name);
  });

  it('reads exports that follow a shell keyword or operator, and skips commented ones', () => {
    const script = [
      'if x; then export DEVKIT_A=1; fi',
      'n=${#v}; export DEVKIT_B=1',
      'true && export DEVKIT_C=1',
      '  export DEVKIT_I=1',
      'export DEVKIT_D DEVKIT_E',
      '# export DEVKIT_F=1',
      'x # export DEVKIT_G=1',
      'export -n DEVKIT_H',
    ].join('\n');
    expect(exportedNames(script).sort()).toEqual([
      'DEVKIT_A',
      'DEVKIT_B',
      'DEVKIT_C',
      'DEVKIT_D',
      'DEVKIT_E',
      'DEVKIT_I',
    ]);
  });

  it('reads the real inline and sourced-library exports, not only synthetic ones', () => {
    // reship.sh exports its PR base only inside `then`, and telemetry.sh is sourced, never listed:
    // a parser or script-set regression that drops either still passes on the other scripts' names.
    expect(exportedNames(read('cli/lib/ship/reship.sh'))).toContain('DEVKIT_SHIP_PR_BASE_SHA');
    expect(SHIP_SCRIPTS.flatMap((f) => exportedNames(read(f)))).toContain(
      'DEVKIT_TELEMETRY_VERSION',
    );
  });

  it('leaves no scrubbed name in a process launched from a ship environment', () => {
    const env = envAfterSetup(SHIP_ENV);
    for (const name of SCRUBBED_ENV) {
      // DEVKIT_GATE_EVENTS is scrubbed and then reassigned; the point is that it is no longer the
      // inherited value, which is what would let a test ship write to the developer's real sink.
      if (name === 'DEVKIT_GATE_EVENTS') continue;
      expect(env[name], name).toBeUndefined();
    }
  });

  it('clears every name of the ship fixture, not only the ones the list already knows', () => {
    // Iterating SCRUBBED_ENV cannot catch a name missing from SCRUBBED_ENV; the fixture is the
    // independent side, so a ship variable absent from the list fails here as well.
    const env = envAfterSetup(SHIP_ENV);
    for (const name of Object.keys(SHIP_ENV)) {
      if (name === 'DEVKIT_GATE_EVENTS') continue; // reassigned to a per-worker temp sink by design
      expect(env[name], name).toBeUndefined();
    }
  });

  it('scrubs the ship state qavis-advisory and completeness read at runtime', () => {
    // shipMode() branches on DEVKIT_SHIP_ROOT and then runs git against it; verdictBranch() scopes
    // a sticky verdict to DEVKIT_SHIP_BRANCH. Inherited, both answer for the OUTER ship.
    const env = envAfterSetup(SHIP_ENV);
    for (const name of [
      'DEVKIT_SHIP_ROOT',
      'DEVKIT_SHIP_BRANCH',
      'DEVKIT_SHIP_FROM_BRANCH',
      'DEVKIT_SHIP_PATHS',
      'DEVKIT_SHIP_REPO',
    ]) {
      expect(env[name], name).toBeUndefined();
    }
  });

  it('declares each name once, in exactly one provenance list', () => {
    expect(SCRUBBED_ENV).toEqual([...new Set(SCRUBBED_ENV)]);
    const overlap = SHIP_EXPORTED_ENV.filter((n: string) => INHERITED_RUN_ENV.includes(n));
    expect(overlap).toEqual([]);
  });

  it('applies to the e2e suite through the same setup file', () => {
    // vitest.e2e.config.mjs is a separate config; if it ever stops sharing this file the e2e
    // workers silently regain the leak, and no other test would notice.
    expect(read('vitest.config.mjs')).toContain("setupFiles: ['./vitest.setup.mjs']");
    expect(read('vitest.e2e.config.mjs')).toContain("setupFiles: ['./vitest.setup.mjs']");
  });

  it('redirects the inherited gate-events sink instead of honouring it', () => {
    const env = envAfterSetup({ ...SHIP_ENV, DEVKIT_GATE_EVENTS: '/real/telemetry.jsonl' });
    expect(env.DEVKIT_GATE_EVENTS).not.toBe('/real/telemetry.jsonl');
    expect(env.DEVKIT_GATE_EVENTS).toMatch(/devkit-test-gate-events-\d+\.jsonl$/);
    expect(env.DEVKIT_NO_TELEMETRY).toBe('1');
  });

  it("drops inherited `git -c` config so a fixture repo's own core.hooksPath applies", () => {
    // A ship hook runs under `git -c core.hooksPath=/dev/null`; inherited, that silently skips
    // every fixture hook and the test times out waiting for a marker the hook never writes.
    const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-suite-git-config-'));
    // Legacy GIT_CONFIG redirects every `git config` read to one file, hiding the repo's own.
    const legacy = path.join(root, 'legacy.gitconfig');
    writeFileSync(legacy, '[core]\n\thooksPath = /dev/null\n');
    const inherited = {
      GIT_CONFIG: legacy,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_PARAMETERS: "'core.hookspath'='/dev/null'",
    };
    try {
      const env = {
        ...envAfterSetup(inherited),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      };
      for (const name of ['GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'])
        expect(env[name], name).toBeUndefined();
      execFileSync('git', ['init', '-q', root], { env });
      execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: root, env });
      const hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: root,
        env,
        encoding: 'utf8',
      }).trim();
      expect(hooksPath).toBe('.husky/_');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the deliberate invocation knobs the scrub must not reach', () => {
    // SHIP_COMMIT_TIMEOUT and DEVKIT_PREFLIGHT_TIMEOUT are inputs a caller chose, not inherited
    // policy — a scrub that widened into a GUARD_*/DEVKIT_* prefix rule would silently eat them.
    const env = envAfterSetup({
      ...SHIP_ENV,
      SHIP_COMMIT_TIMEOUT: '42',
      DEVKIT_PREFLIGHT_TIMEOUT: '7',
      DEVKIT_PREFLIGHT_HEARTBEAT: '5',
    });
    expect(env.SHIP_COMMIT_TIMEOUT).toBe('42');
    expect(env.DEVKIT_PREFLIGHT_TIMEOUT).toBe('7');
    expect(env.DEVKIT_PREFLIGHT_HEARTBEAT).toBe('5');
  });
});

describe('vitest.setup.mjs pins a git identity', () => {
  it('sets every identity var, overriding one the launcher exported', () => {
    const env = envAfterSetup({
      GIT_AUTHOR_NAME: 'Outer',
      GIT_COMMITTER_EMAIL: 'outer@example.com',
    });
    for (const [name, value] of Object.entries(SUITE_GIT_IDENTITY))
      expect(env[name], name).toBe(value);
  });

  it('lets a fixture commit on a runner with no git identity configured', () => {
    // The CI condition: no ~/.gitconfig, no system config. Without the pinned identity this commit
    // fails with "Author identity unknown", which is what kept main's gate red.
    const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-suite-identity-'));
    try {
      const env = {
        ...envAfterSetup({}),
        HOME: path.join(root, 'home'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      };
      const repo = path.join(root, 'repo');
      execFileSync('git', ['init', '-q', repo], { env });
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'root'], { cwd: repo, env });
      const author = execFileSync('git', ['log', '-1', '--format=%an <%ae>'], {
        cwd: repo,
        env,
        encoding: 'utf8',
      }).trim();
      expect(author).toBe(
        `${SUITE_GIT_IDENTITY.GIT_AUTHOR_NAME} <${SUITE_GIT_IDENTITY.GIT_AUTHOR_EMAIL}>`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
