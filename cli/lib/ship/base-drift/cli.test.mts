import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.mts';

const CWD = '/repo';

describe('parseArgs', () => {
  it('defaults to the caller cwd and reports everything', () => {
    expect(parseArgs([], CWD)).toEqual({
      root: CWD,
      paths: [],
      json: false,
      exitZero: false,
      ship: false,
      cachedOk: false,
    });
  });

  it('reads every flag it owns', () => {
    const args = parseArgs(
      [
        '--root',
        '/elsewhere',
        '--base',
        'release/1.0',
        '--json',
        '--exit-zero',
        '--ship',
        '--cached-ok',
        '--max-age-ms',
        '500',
      ],
      CWD,
    );
    expect(args).toMatchObject({
      root: '/elsewhere',
      base: 'release/1.0',
      json: true,
      exitZero: true,
      ship: true,
      cachedOk: true,
      maxAgeMs: 500,
    });
  });

  it('treats everything after -- as a path, flags included', () => {
    // ship passes `-- "${PATHS[@]}"`, and a repo may legitimately contain a file whose name starts
    // with a dash. Nothing after the separator may be re-read as an option.
    const args = parseArgs(['--base', 'main', '--', '--ship', '-weird.txt'], CWD);
    expect(args.ship).toBe(false);
    expect(args.cachedOk).toBe(false);
    expect(args.paths).toEqual(['--ship', '-weird.txt']);
  });

  it('does not let a value-taking flag swallow the next option', () => {
    // `--base --json` must fail loudly, not query a base named "--json" while silently dropping the
    // JSON mode the caller asked for.
    expect(() => parseArgs(['--base', '--json'], CWD)).toThrow(/unknown or incomplete/);
    expect(() => parseArgs(['--root', '--ship'], CWD)).toThrow(/unknown or incomplete/);
    expect(() => parseArgs(['--max-age-ms', '--json'], CWD)).toThrow(/unknown or incomplete/);
    // A path after `--` may still start with a dash.
    expect(parseArgs(['--', '--weird.txt'], CWD).paths).toEqual(['--weird.txt']);
  });

  it('rejects a malformed duration instead of silently picking a window', () => {
    // '9'.repeat(400) is all digits, so a regex alone accepts it — and Number() makes it Infinity,
    // which would hold the fetch window open forever.
    for (const bad of ['500ms', 'abc', '1.5', '-1', '', '9'.repeat(400)]) {
      expect(() => parseArgs(['--max-age-ms', bad], CWD)).toThrow();
    }
    expect(parseArgs(['--max-age-ms', String(Number.MAX_SAFE_INTEGER)], CWD).maxAgeMs).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(parseArgs(['--max-age-ms', '0'], CWD).maxAgeMs).toBe(0);
    expect(parseArgs(['--max-age-ms', '500'], CWD).maxAgeMs).toBe(500);
  });

  it('rejects an unknown or incomplete flag rather than ignoring it', () => {
    expect(() => parseArgs(['--nonsense'], CWD)).toThrow(/unknown or incomplete/);
    expect(() => parseArgs(['--base'], CWD)).toThrow(/unknown or incomplete/);
  });
});
