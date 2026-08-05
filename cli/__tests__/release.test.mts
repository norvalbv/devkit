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

  beforeEach(() => {
    builtVersion = '0.48.0';
    mockExec.mockReset();
    mockShip.mockReset();
    mockShip.mockReturnValue(0);
    mockExec.mockImplementation((command: string, args: string[]) => {
      if (command === 'node') return `${builtVersion}\n`;
      if (command !== 'git') return '';
      if (args[0] === 'status') return '';
      if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'main\n';
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
        if (command !== 'git') return '';
        if (args[0] === 'status') return '';
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'main\n';
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

    // Offline must not block a maintainer — the check can only ever add certainty.
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
});
