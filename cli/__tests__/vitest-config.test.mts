import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import config from '../../vitest.config.mjs';
import { SCRUBBED_ENV } from '../../vitest.setup.mjs';
import { testSpawnSync } from './_helpers.mts';

const REPO = path.resolve(import.meta.dirname, '../..');
const VITEST = path.join(REPO, 'node_modules/vitest/vitest.mjs');

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'vitest-config-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function nestedVitest(args: string[]) {
  return testSpawnSync(process.execPath, [VITEST, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
}

describe('devkit vitest config under vitest 5', () => {
  // vitest#10750: inline projects extend the root config and concatenate arrays, so without
  // `extends: false` git-integration also matched the root TEST_INCLUDE and ran 391 files twice.
  it('puts every test file in exactly one project', () => {
    const out = path.join(scratch, 'list.json');
    const result = nestedVitest(['list', '--filesOnly', `--json=${out}`]);
    expect(result.status, result.stderr).toBe(0);
    const files: { file: string; projectName: string }[] = JSON.parse(readFileSync(out, 'utf8'));

    const seen = new Map<string, string[]>();
    for (const { file, projectName } of files)
      seen.set(file, [...(seen.get(file) ?? []), projectName]);
    const doubled = [...seen].filter(([, projects]) => projects.length > 1);
    expect(doubled).toEqual([]);
    expect(files.some((f) => f.projectName === 'git-integration')).toBe(true);
  });

  it('opts every inline project out of root-config inheritance', () => {
    const projects = config.test?.projects ?? [];
    expect(projects.length).toBeGreaterThan(0);
    for (const project of projects) expect(project).toMatchObject({ extends: false });
  });

  it('attaches v8 coverage to spawned child processes', () => {
    expect(config.test?.coverage).toMatchObject({ provider: 'v8', autoAttachSubprocess: true });
  });

  // The provider hands NODE_V8_COVERAGE to children only through process.env; a setup-file scrub of
  // it would silently zero every CLI module's coverage again.
  it('never scrubs the variable that carries child coverage', () => {
    expect(SCRUBBED_ENV).not.toContain('NODE_V8_COVERAGE');
  });

  it('passes NODE_V8_COVERAGE through the supervised spawn boundary', () => {
    const marker = path.join(tmpdir(), 'v8-coverage-marker');
    const result = testSpawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.NODE_V8_COVERAGE ?? "")'],
      { encoding: 'utf8', env: { ...process.env, NODE_V8_COVERAGE: marker } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(marker);
  });

  // Runs devkit's own coverage block end to end. The root is realpath'd: a child reports its real
  // path, so a symlinked root (macOS /tmp) silently scores 0%.
  it('counts lines that only a spawned `node <file>.mts` child executes', () => {
    const root = realpathSync(scratch);
    writeFileSync(
      path.join(root, 'cli.mts'),
      [
        'export function classify(n: number): string {',
        "  if (n < 0) return 'neg';",
        "  return 'non-neg';",
        '}',
        'export function neverCalled(): number {',
        '  return 1;',
        '}',
        'if (process.argv[2]) console.log(classify(Number(process.argv[2])));',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(root, 'cli.test.mts'),
      [
        "import { spawnSync } from 'node:child_process';",
        "import { expect, it } from 'vitest';",
        "it('spawns', () => {",
        "  const cli = new URL('./cli.mts', import.meta.url).pathname;",
        "  expect(spawnSync(process.execPath, [cli, '-1'], { encoding: 'utf8' }).stdout).toBe('neg\\n');",
        '});',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(root, 'vitest.config.mjs'),
      `import base from ${JSON.stringify(pathToFileURL(path.join(REPO, 'vitest.config.mjs')).href)};\n` +
        "export default { test: { include: ['cli.test.mts'], coverage: base.test.coverage } };\n",
    );
    const result = testSpawnSync(
      process.execPath,
      [
        VITEST,
        'run',
        '--root',
        root,
        '--coverage.enabled',
        '--coverage.include=cli.mts',
        '--coverage.reporter=lcovonly',
        `--coverage.reportsDirectory=${path.join(root, 'coverage')}`,
      ],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1' } },
    );
    expect(result.status, result.stderr).toBe(0);
    // lcov `DA:<line>,<hits>`: one record per executable line of cli.mts.
    const hits = new Map(
      [
        ...readFileSync(path.join(root, 'coverage/lcov.info'), 'utf8').matchAll(
          /^DA:(\d+),(\d+)/gm,
        ),
      ].map(([, line, count]) => [Number(line), Number(count)]),
    );
    expect(hits.get(2)).toBeGreaterThan(0);
    expect(hits.get(6)).toBe(0);
  });
});
