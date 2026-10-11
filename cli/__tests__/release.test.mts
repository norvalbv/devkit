import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import release, { bumpReadmePins, nextVersion } from '../commands/release.mts';
import ship from '../commands/ship.mts';

// The mocked `bun run build` below never writes real files, so any test expected to reach the dist
// smoke checks (sc-1419: proves the stdin-hang fix's call site actually reached the build) needs this
// written first — mirrors what a real `bun run build` would produce for these two files.
function writeShipDistFixture(
  cwd: string,
  opts: { withFix?: boolean; skipReadStdinBody?: boolean } = {},
): void {
  const dir = join(cwd, 'dist', 'cli', 'lib', 'ship');
  mkdirSync(dir, { recursive: true });
  const withFix = opts.withFix ?? true;
  writeFileSync(
    join(dir, 'ship-branch.sh'),
    withFix ? 'else ship_read_stdin_body; fi\n' : 'else BODY=$(cat); fi\n',
  );
  if (!opts.skipReadStdinBody) writeFileSync(join(dir, 'read-stdin-body.sh'), '# stub\n');
}

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('../commands/ship.mts', () => ({ default: vi.fn() }));

const SHA = 'a'.repeat(40);
const RUN_URL = 'https://github.com/norvalbv/devkit/actions/runs/7';

/** How the fake gh answers: origin's tips in call order (then SHA), and the base commit's one run. */
interface FakeCi {
  tips?: string[];
  status?: string;
  conclusion?: string;
  noRuns?: boolean;
  /** The status of a newer, unfinished run of the same commit, listed first as gh lists it. */
  newer?: string;
  fail?: object;
  listFail?: object;
  /** Raw `gh run view` output in place of the well-formed page. */
  view?: string;
}

/** A fake `gh` behind the mocked execFileSync, printing what gh 2.96 prints for these three calls. */
function fakeGh(args: string[], ci: FakeCi): string {
  if (ci.fail) throw ci.fail;
  if (args[0] === 'api') return `${ci.tips?.shift() ?? SHA}\n`;
  if (ci.listFail) throw ci.listFail;
  const conclusion = ci.conclusion ?? 'success';
  if (args[1] === 'view') {
    if (ci.view !== undefined) return ci.view;
    const jobs = [{ name: 'gate', conclusion, steps: [{ name: 'Tests', conclusion }] }];
    return JSON.stringify({ url: RUN_URL, jobs });
  }
  const run = {
    databaseId: 7,
    attempt: 1,
    status: ci.status ?? 'completed',
    conclusion,
    headSha: SHA,
    createdAt: '2026-10-10T00:00:00Z',
    headBranch: 'main',
    event: 'push',
  };
  const runs = ci.newer
    ? [{ ...run, databaseId: 8, status: ci.newer, conclusion: '' }, run]
    : [run];
  return JSON.stringify(ci.noRuns ? [] : runs);
}

describe('nextVersion', () => {
  it('bumps patch/minor/major', () => {
    expect(nextVersion('0.9.0', 'patch')).toBe('0.9.1');
    expect(nextVersion('0.9.0', 'minor')).toBe('0.10.0');
    expect(nextVersion('0.9.3', 'major')).toBe('1.0.0');
  });

  it('zeroes lower components on minor/major', () => {
    expect(nextVersion('1.4.7', 'minor')).toBe('1.5.0');
    expect(nextVersion('1.4.7', 'major')).toBe('2.0.0');
  });

  it('accepts an explicit x.y.z and returns it verbatim', () => {
    expect(nextVersion('0.9.0', '2.1.4')).toBe('2.1.4');
  });

  it('throws on a bad bump keyword', () => {
    expect(() => nextVersion('0.9.0', 'huge')).toThrow(/bad bump/);
  });

  it('throws when current is not x.y.z and bump is a keyword', () => {
    expect(() => nextVersion('0.9', 'patch')).toThrow(/not x\.y\.z/);
  });
});

describe('bumpReadmePins', () => {
  it('rewrites every devkit.git#vX.Y.Z install pin', () => {
    const md = [
      'bun add -D git+ssh://git@github.com/norvalbv/devkit.git#v0.8.1',
      'bun add -g git+ssh://git@github.com/norvalbv/devkit.git#v0.8.1   # once',
    ].join('\n');
    const out = bumpReadmePins(md, '0.9.0');
    expect(out).not.toContain('#v0.8.1');
    expect(out.match(/#v0\.9\.0/g)).toHaveLength(2);
  });

  it('leaves a README with no pins unchanged', () => {
    const md = '# devkit\n\nno install pins here.';
    expect(bumpReadmePins(md, '1.2.3')).toBe(md);
  });
});

describe('release publishing', () => {
  const made: string[] = [];
  const mockExec = vi.mocked(execFileSync);
  const mockShip = vi.mocked(ship);
  let builtVersion: string;
  let ci: FakeCi;

  beforeEach(() => {
    builtVersion = '0.48.0';
    ci = {};
    mockExec.mockReset();
    mockShip.mockReset();
    mockShip.mockReturnValue(0);
    mockExec.mockImplementation((command: string, args: string[]) => {
      if (command === 'node') return `${builtVersion}\n`;
      if (command === 'gh') return fakeGh(args, ci);
      if (command !== 'git') return '';
      if (args[0] === 'status') return '';
      if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'main\n';
      if (args.join(' ') === 'rev-parse HEAD') return `${SHA}\n`;
      if (args.join(' ') === 'tag --list v0.48.0') return '';
      if (args.join(' ') === 'ls-files -- dist') {
        return 'dist/cli/index.mjs\ndist/package.json\n';
      }
      if (args.join(' ') === 'ls-files -o -i --exclude-standard -- dist') return '';
      return '';
    });
  });

  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each([
    [0, false, 'a successful publish reports success'],
    [1, true, 'a failed publish reports the failure'],
  ])('awaits ship, whose return is now a Promise (%i): %s', async (shipCode, expectFailure) => {
    // Regression guard for the managed-spawn swap (sc-2159). `devkit ship` returns Promise<number>
    // now, while every other test here mocks a BARE number that an accidental removal of `await`
    // would still satisfy. Note the exit CODE cannot catch it: release is async, so returning an
    // un-awaited Promise is flattened by the caller's own await and still yields the right number.
    // The observable damage is the branch taken — un-awaited, `publishCode !== 0` is true for a
    // Promise, so a perfectly good release announces "could not publish" and tells the user their
    // files are stranded.
    const cwd = mkdtempSync(join(tmpdir(), 'devkit-release-'));
    made.push(cwd);
    writeFileSync(
      join(cwd, 'package.json'),
      '{\n  "name": "@norvalbv/devkit",\n  "version": "0.47.1"\n}\n',
    );
    writeFileSync(
      join(cwd, 'README.md'),
      'bun add -D git+ssh://git@github.com/norvalbv/devkit.git#v0.47.1\n',
    );
    writeShipDistFixture(cwd);
    mockShip.mockReturnValue(Promise.resolve(shipCode));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await release(['minor', '--yes'], cwd)).toBe(shipCode);

    const announcedFailure = errors.mock.calls.some((c) => /could not publish/.test(String(c[0])));
    expect(announcedFailure).toBe(expectFailure);
    const announcedSuccess = logs.mock.calls.some((c) => /Opened release PR/.test(String(c[0])));
    expect(announcedSuccess).toBe(!expectFailure);
  });

  it('opens a release PR and never commits, tags, or pushes the base branch directly', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'devkit-release-'));
    made.push(cwd);
    writeFileSync(
      join(cwd, 'package.json'),
      '{\n  "name": "@norvalbv/devkit",\n  "version": "0.47.1"\n}\n',
    );
    writeFileSync(
      join(cwd, 'README.md'),
      'bun add -D git+ssh://git@github.com/norvalbv/devkit.git#v0.47.1\n',
    );
    writeShipDistFixture(cwd);

    expect(await release(['minor', '--yes'], cwd)).toBe(0);

    expect(mockShip).toHaveBeenCalledOnce();
    const [shipArgs, shipCwd] = mockShip.mock.calls[0] ?? [];
    expect(shipCwd).toBe(cwd);
    expect(shipArgs?.slice(0, 7)).toEqual([
      'release/v0.48.0',
      'release: v0.48.0',
      '--base',
      'main',
      '--body',
      expect.stringContaining('Do not tag the release branch commit'),
      '--',
    ]);
    expect(shipArgs).toEqual(
      expect.arrayContaining([
        'package.json',
        'README.md',
        'dist/cli/index.mjs',
        'dist/package.json',
      ]),
    );

    const gitCalls = mockExec.mock.calls
      .filter(([command]) => command === 'git')
      .map(([, args]) => args as string[]);
    expect(gitCalls).not.toContainEqual(['push', 'origin', 'main']);
    expect(gitCalls.some((args) => args[0] === 'push')).toBe(false);
    expect(gitCalls.some((args) => args[0] === 'commit')).toBe(false);
    expect(gitCalls.some((args) => args[0] === 'tag' && args[1] === '-a')).toBe(false);
    expect(gitCalls.some((args) => args[0] === 'restore')).toBe(false);
    expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toContain('"version": "0.48.0"');
  });

  // A published version tag is immutable: consumer lockfiles record the object it resolves to, so
  // re-cutting one orphans every recorded SHA and breaks their installs (sc-1449). These two lock
  // the only automated protection there is — tagging itself is a manual post-merge step.
  it('refuses when the tag already exists locally, before doing any release work', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'devkit-release-'));
    made.push(cwd);
    writeFileSync(
      join(cwd, 'package.json'),
      '{\n  "name": "@norvalbv/devkit",\n  "version": "0.47.1"\n}\n',
    );
    mockExec.mockImplementation((command: string, args: string[]) => {
      if (command !== 'git') return '';
      if (args[0] === 'status') return '';
      if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'main\n';
      if (args.join(' ') === 'tag --list v0.48.0') return 'v0.48.0\n';
      return '';
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await release(['minor', '--yes'], cwd)).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/tag v0\.48\.0 already exists/));
    // Nothing may have happened yet: no ship, no build, no bump written to disk.
    expect(mockShip).not.toHaveBeenCalled();
    expect(mockExec.mock.calls.some(([cmd]) => cmd === 'bun')).toBe(false);
    expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toContain('"version": "0.47.1"');
  });

  it('refuses when the tag exists only on origin, and proceeds when the remote is unreachable', async () => {
    const build = (lsRemote: () => string) => {
      mockExec.mockImplementation((command: string, args: string[]) => {
        if (command === 'node') return `${builtVersion}\n`;
        if (command === 'gh') return fakeGh(args, ci);
        if (command !== 'git') return '';
        if (args[0] === 'status') return '';
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'main\n';
        if (args.join(' ') === 'rev-parse HEAD') return `${SHA}\n`;
        if (args[0] === 'ls-remote') return lsRemote();
        return '';
      });
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // A clone that never fetched tags: `git tag --list` is empty, origin still has it.
    const remote = mkdtempSync(join(tmpdir(), 'devkit-release-'));
    made.push(remote);
    writeFileSync(
      join(remote, 'package.json'),
      '{\n  "name": "@norvalbv/devkit",\n  "version": "0.47.1"\n}\n',
    );
    build(() => 'c68a526\trefs/tags/v0.48.0\n');
    expect(await release(['minor', '--yes'], remote)).toBe(1);
    expect(mockShip).not.toHaveBeenCalled();

    // An unreachable git remote does not block: the tag check can only ever add certainty.
    const offline = mkdtempSync(join(tmpdir(), 'devkit-release-'));
    made.push(offline);
    writeFileSync(
      join(offline, 'package.json'),
      '{\n  "name": "@norvalbv/devkit",\n  "version": "0.47.1"\n}\n',
    );
    writeShipDistFixture(offline);
    build(() => {
      throw new Error('Could not resolve host: github.com');
    });
    expect(await release(['minor', '--yes'], offline)).toBe(0);
    expect(mockShip).toHaveBeenCalledOnce();
  });

  it('returns the publishing failure and keeps the release edits recoverable', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'devkit-release-'));
    made.push(cwd);
    writeFileSync(
      join(cwd, 'package.json'),
      '{\n  "name": "@norvalbv/devkit",\n  "version": "0.47.1"\n}\n',
    );
    writeShipDistFixture(cwd);
    mockShip.mockReturnValue(1);
    builtVersion = '0.47.2';
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await release(['patch', '--yes'], cwd)).toBe(1);
    expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toContain('"version": "0.47.2"');
    const gitCalls = mockExec.mock.calls
      .filter(([command]) => command === 'git')
      .map(([, args]) => args as string[]);
    expect(gitCalls.some((args) => args[0] === 'restore')).toBe(false);
  });

  it('refuses when the built dist is missing the stdin-hang fix', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'devkit-release-'));
    made.push(cwd);
    writeFileSync(
      join(cwd, 'package.json'),
      '{\n  "name": "@norvalbv/devkit",\n  "version": "0.47.1"\n}\n',
    );
    writeShipDistFixture(cwd, { withFix: false });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await release(['minor', '--yes'], cwd)).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/ship_read_stdin_body/));
    expect(mockShip).not.toHaveBeenCalled();
  });

  it('refuses when read-stdin-body.sh is missing even though ship-branch.sh carries the fix string', async () => {
    // Proves BOTH files are required — a build that dropped only the companion helper (not the
    // string this check greps for) must still fail, not pass on the ship-branch.sh check alone.
    const cwd = mkdtempSync(join(tmpdir(), 'devkit-release-'));
    made.push(cwd);
    writeFileSync(
      join(cwd, 'package.json'),
      '{\n  "name": "@norvalbv/devkit",\n  "version": "0.47.1"\n}\n',
    );
    writeShipDistFixture(cwd, { skipReadStdinBody: true });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await release(['minor', '--yes'], cwd)).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/missing from the build/));
    expect(mockShip).not.toHaveBeenCalled();
  });

  it('refuses instead of throwing uncaught when ship-branch.sh is a directory, not a file', async () => {
    // existsSync alone accepts directories — this locks in that the smoke check requires a regular
    // file and fails cleanly (not an uncaught exception) when the build produced something malformed.
    const cwd = mkdtempSync(join(tmpdir(), 'devkit-release-'));
    made.push(cwd);
    writeFileSync(
      join(cwd, 'package.json'),
      '{\n  "name": "@norvalbv/devkit",\n  "version": "0.47.1"\n}\n',
    );
    const shipDir = join(cwd, 'dist', 'cli', 'lib', 'ship');
    mkdirSync(join(shipDir, 'ship-branch.sh'), { recursive: true });
    writeFileSync(join(shipDir, 'read-stdin-body.sh'), '# stub\n');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(release(['minor', '--yes'], cwd)).resolves.toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/missing from the build/));
    expect(mockShip).not.toHaveBeenCalled();
  });

  describe('base CI', () => {
    /** A clean devkit checkout at 0.47.1 whose build would pass the dist smoke checks. */
    const checkout = () => {
      const cwd = mkdtempSync(join(tmpdir(), 'devkit-release-'));
      made.push(cwd);
      writeFileSync(
        join(cwd, 'package.json'),
        '{\n  "name": "@norvalbv/devkit",\n  "version": "0.47.1"\n}\n',
      );
      writeShipDistFixture(cwd);
      return cwd;
    };
    const shipBody = () => {
      const args = mockShip.mock.calls[0]?.[0] ?? [];
      return args[args.indexOf('--body') + 1];
    };
    const stderr = () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      return () => errors.mock.calls.map((c) => String(c[0])).join('\n');
    };
    const refusedEarly = (cwd: string) => {
      expect(mockShip).not.toHaveBeenCalled();
      expect(mockExec.mock.calls.some(([cmd]) => cmd === 'bun')).toBe(false);
      expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toContain('"version": "0.47.1"');
    };

    it('proceeds on a green base and records the run in the release PR', async () => {
      const cwd = checkout();
      vi.spyOn(console, 'log').mockImplementation(() => {});

      expect(await release(['minor', '--yes'], cwd)).toBe(0);
      expect(shipBody()).toContain(`Base CI: gate.yml passed on ${SHA} — ${RUN_URL}`);
    });

    it('refuses a red base before any test, build or bump, naming the failed step and run', async () => {
      const cwd = checkout();
      ci.conclusion = 'failure';
      const errors = stderr();

      expect(await release(['minor', '--yes'], cwd)).toBe(1);
      expect(errors()).toContain(`gate.yml failed on ${SHA} (gate › Tests) — ${RUN_URL}`);
      expect(errors()).toContain('--ci-override');
      refusedEarly(cwd);
      expect(await release(['minor', '--dry-run'], cwd)).toBe(1);
    });

    it.each([
      ['no run', { noRuns: true }, 'no-usable-run: no gate.yml run for this commit'],
      ['a cancelled run', { conclusion: 'cancelled' }, 'no-usable-run: run 7 concluded cancelled'],
    ])('refuses a base with %s as missing CI', async (_name, world, reason) => {
      const cwd = checkout();
      Object.assign(ci, world);
      const errors = stderr();

      expect(await release(['minor', '--yes'], cwd)).toBe(1);
      expect(errors()).toContain(reason);
      expect(errors()).toContain('--ci-override');
      refusedEarly(cwd);
    });

    it('decides by the newest completed run, not a newer one still running', async () => {
      const cwd = checkout();
      ci.newer = 'in_progress';
      vi.spyOn(console, 'log').mockImplementation(() => {});

      expect(await release(['minor', '--yes'], cwd)).toBe(0);
      expect(shipBody()).toContain('Base CI: gate.yml passed');
    });

    it('tells a maintainer to wait for an unfinished run rather than override it', async () => {
      const cwd = checkout();
      Object.assign(ci, { status: 'in_progress', conclusion: '' });
      const errors = stderr();

      expect(await release(['minor', '--yes'], cwd)).toBe(1);
      expect(errors()).toContain('has not finished on');
      expect(errors()).toContain('Wait for that run to finish');
      expect(errors()).not.toContain('--ci-override');
      refusedEarly(cwd);
    });

    it.each([
      ['gh is not installed', { fail: { code: 'ENOENT' } }, 'gh-missing'],
      [
        'gh is offline',
        { fail: { stderr: 'error connecting to api.github.com' } },
        'gh-failed: error connecting',
      ],
      ["HEAD is not origin's tip", { tips: ['b'.repeat(40)] }, 'Check out main at bbbb'],
      [
        'gh cannot find the workflow',
        { listFail: { stderr: 'could not find any workflows named gate.yml' } },
        'gate.yml could not be read on',
      ],
      ['gh garbles the run page', { view: 'not json' }, 'gh-failed: gh run view 7 returned JSON'],
    ])('refuses when %s, even with --ci-override', async (_name, world, said) => {
      const cwd = checkout();
      Object.assign(ci, world);
      const errors = stderr();

      expect(await release(['minor', '--yes', '--ci-override', 'flaky'], cwd)).toBe(1);
      expect(errors()).toContain(said);
      refusedEarly(cwd);
    });

    it('refuses to publish when origin moved while the release built', async () => {
      const cwd = checkout();
      ci.tips = [SHA, 'b'.repeat(40)];
      const errors = stderr();
      vi.spyOn(console, 'log').mockImplementation(() => {});

      expect(await release(['minor', '--yes'], cwd)).toBe(1);
      expect(errors()).toContain('nothing was published');
      expect(mockShip).not.toHaveBeenCalled();
    });

    it('releases a red base under --ci-override and records the reason, sha and run', async () => {
      const cwd = checkout();
      ci.conclusion = 'failure';
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const reason = 'main red: Linux-only flake';

      expect(await release(['minor', '--ci-override', reason, '--yes'], cwd)).toBe(0);
      expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toContain('"version": "0.48.0"');
      expect(shipBody()).toContain('## Base CI override');
      expect(shipBody()).toContain(`gate.yml failed on ${SHA} (gate › Tests) — ${RUN_URL}`);
      expect(shipBody()).toContain(`Reason given with --ci-override: ${reason}`);
    });

    it('does not record an override the green base did not need', async () => {
      const cwd = checkout();
      const logs = vi.spyOn(console, 'log').mockImplementation(() => {});

      expect(await release(['minor', '--ci-override=unneeded', '--yes'], cwd)).toBe(0);
      expect(shipBody()).not.toContain('unneeded');
      expect(logs.mock.calls.flat().join('\n')).toContain('--ci-override is not recorded');
    });

    it('requires a reason with --ci-override', async () => {
      const cwd = checkout();
      const errors = stderr();

      expect(await release(['minor', '--ci-override', ' ', '--yes'], cwd)).toBe(1);
      expect(await release(['minor', '--ci-override=', '--yes'], cwd)).toBe(1);
      expect(errors()).toContain('--ci-override needs a reason');
      await expect(release(['minor', '--yes', '--ci-override'], cwd)).rejects.toThrow(/argument/);
      refusedEarly(cwd);
    });

    it('reads the workflow guard.config.json names for baseline-status', async () => {
      const cwd = checkout();
      writeFileSync(
        join(cwd, 'guard.config.json'),
        JSON.stringify({ baselineStatus: { workflow: 'ci.yml' } }),
      );
      vi.spyOn(console, 'log').mockImplementation(() => {});

      expect(await release(['minor', '--yes'], cwd)).toBe(0);
      const list = mockExec.mock.calls.find(([cmd, args]) => cmd === 'gh' && args?.[1] === 'list');
      expect(list?.[1]).toEqual(expect.arrayContaining(['--workflow', 'ci.yml']));
      expect(shipBody()).toContain('Base CI: ci.yml passed');
    });
  });
});
