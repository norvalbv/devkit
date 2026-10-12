import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import config from '../../vitest.config.mjs';
import { testSpawnSync } from './_helpers.mts';
import ModernBashSkipReporter, {
  countModernBashSkips,
  formatModernBashSkipLine,
  MODERN_BASH_SKIP_NOTE,
} from './_modern-bash.mts';

function moduleWithSkips(...notes: (string | undefined)[]) {
  return { children: { allTests: () => notes.map((note) => ({ result: () => ({ note }) })) } };
}

afterEach(() => vi.restoreAllMocks());

const reportRunEnd = (module: ReturnType<typeof moduleWithSkips>) =>
  new ModernBashSkipReporter().onTestRunEnd([module]);

describe('bash >= 4 skip reporter', () => {
  it('counts only skips carrying the bash >= 4 note, across modules', () => {
    const modules = [
      moduleWithSkips(MODERN_BASH_SKIP_NOTE, undefined, 'some other reason'),
      moduleWithSkips(MODERN_BASH_SKIP_NOTE),
    ];

    expect(countModernBashSkips(modules)).toBe(2);
  });

  it('prints exactly one summary line naming the count and both remedies', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    reportRunEnd(moduleWithSkips(MODERN_BASH_SKIP_NOTE));

    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith(formatModernBashSkipLine(1));
    expect(formatModernBashSkipLine(1)).toMatch(
      /1 tests need bash >= 4.*brew install bash.*test:linux-bash/,
    );
  });

  it('stays silent when no bash >= 4 test skipped', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    reportRunEnd(moduleWithSkips('some other reason'));

    expect(errors).not.toHaveBeenCalled();
  });
});

const REPO = path.resolve(import.meta.dirname, '../..');
const MODULE = path.join(REPO, 'cli/__tests__/_modern-bash.mts');

let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'modern-bash-')));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('bash >= 4 skip reporter inside a real vitest run', () => {
  // Fakes above model only the slice we read; this pins vitest's real TestModule/result().note shape
  // and the root config's registration of the module.
  it('counts noted skips from a real run, ignoring a plain it.skip', () => {
    expect(config.test?.reporters).toContain('./cli/__tests__/_modern-bash.mts');
    writeFileSync(
      path.join(scratch, 'fx.test.mts'),
      [
        "import { it } from 'vitest';",
        `import { MODERN_BASH_SKIP_NOTE } from ${JSON.stringify(MODULE)};`,
        "it.for([1, 2])('noted $0', (_n, { skip }) => skip(true, MODERN_BASH_SKIP_NOTE));",
        "it.skip('plain', () => {});",
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(scratch, 'vitest.config.mjs'),
      `export default { test: { include: ['fx.test.mts'], reporters: ['default', ${JSON.stringify(MODULE)}] } };\n`,
    );

    const result = testSpawnSync(
      process.execPath,
      [path.join(REPO, 'node_modules/vitest/vitest.mjs'), 'run', '--root', scratch],
      { cwd: scratch, encoding: 'utf8', env: { ...process.env, CI: '1' } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.split(formatModernBashSkipLine(2)).length - 1).toBe(1);
  });
});

/** Runs the container script against a `docker` stub that records its argv, one arg per line. */
function linuxBash(args: string[], dockerInfoStatus = 0) {
  const bin = path.join(scratch, 'bin');
  mkdirSync(bin);
  const argv = path.join(scratch, 'docker-argv');
  writeFileSync(
    path.join(bin, 'docker'),
    `#!/bin/sh\n[ "$1" = info ] && exit ${dockerInfoStatus}\nprintf '%s\\n' "$@" > "${argv}"\n`,
    { mode: 0o755 },
  );
  const result = testSpawnSync('bash', [path.join(REPO, 'scripts/test-linux-bash.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const forwarded = existsSync(argv) ? readFileSync(argv, 'utf8').split('\n') : [];
  return { ...result, forwarded };
}

describe('test:linux-bash', () => {
  it('refuses to run the whole suite when given no files', () => {
    const result = linuxBash([]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: bun run test:linux-bash <test file>/);
    expect(result.forwarded).toEqual([]);
  });

  it('names the remedy instead of a docker error when Docker is not running', () => {
    const result = linuxBash(['cli/__tests__/x.test.mts'], 1);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Docker is not running.*open -a Docker/);
    expect(result.forwarded).toEqual([]);
  });

  // The checkout is mounted at /work, so a host-absolute path names nothing inside the container.
  it('forwards checkout-absolute and relative file paths as checkout-relative ones', () => {
    const result = linuxBash([
      path.join(REPO, 'cli/__tests__/review-gate-supervisor.test.mts'),
      'cli/__tests__/ship-branch-resume-scope.test.mts',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.forwarded.slice(-3, -1)).toEqual([
      'cli/__tests__/review-gate-supervisor.test.mts',
      'cli/__tests__/ship-branch-resume-scope.test.mts',
    ]);
  });
});
