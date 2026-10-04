import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rootRegistry } from '../../../__tests__/_helpers.mts';
import {
  OVERLAY_ENTRY_REL,
  overlayDiscoveryRow,
  overlayEntry,
  readConsumerIgnores,
} from './overlay-entry.mts';
import { resolveOxcRuntime } from './runtime.mts';

const { mkTmp, cleanup } = rootRegistry();
afterEach(cleanup);

const BASE = './.devkit/oxc/oxlint.base.json';

interface OxlintReport {
  diagnostics: { code: string; filename: string }[];
}
const entryOf = (root: string, consumer: string[]) =>
  JSON.parse(overlayEntry(readConsumerIgnores(root, consumer).patterns));

function repo(files: Record<string, string>): string {
  const root = mkTmp('devkit-overlay-entry-');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe('overlay entry config — honouring the consumer Oxlint ignores', () => {
  it('copies the consumer ignorePatterns and never extends the consumer config', () => {
    const root = repo({ '.oxlintrc.json': '{ "ignorePatterns": ["drizzle"], "rules": {} }\n' });
    expect(entryOf(root, ['.oxlintrc.json'])).toEqual({
      extends: [BASE],
      ignorePatterns: ['drizzle'],
    });
  });

  it('reads a commented .oxlintrc.jsonc', () => {
    const root = repo({ '.oxlintrc.jsonc': '{\n  // ours\n  "ignorePatterns": ["out"],\n}\n' });
    expect(entryOf(root, ['.oxlintrc.jsonc'])).toEqual({
      extends: [BASE],
      ignorePatterns: ['out'],
    });
  });

  it('reads a config with no ignorePatterns as readable, with nothing to copy', () => {
    const root = repo({ '.oxlintrc.json': '{ "rules": { "eqeqeq": "error" } }\n' });
    expect(readConsumerIgnores(root, ['.oxlintrc.json'])).toEqual({
      patterns: [],
      unreadable: null,
    });
    expect(entryOf(root, ['.oxlintrc.json'])).toEqual({ extends: [BASE] });
  });

  it('extends only the base when there is no consumer config', () => {
    const root = repo({});
    expect(entryOf(root, [])).toEqual({ extends: [BASE] });
    writeFileSync(
      join(root, OVERLAY_ENTRY_REL),
      overlayEntry(readConsumerIgnores(root, []).patterns),
    );
    expect(overlayDiscoveryRow(root, [], true).status).toBe('OK');
  });

  it.each([
    [{ 'oxlint.config.ts': 'export default {};\n' }, ['oxlint.config.ts'], /cannot read/u],
    [
      { '.oxlintrc.json': '{ nope' },
      ['.oxlintrc.json'],
      /not a JSON object, or its ignorePatterns/u,
    ],
    [{ '.oxlintrc.json': '[]\n' }, ['.oxlintrc.json'], /not a JSON object, or its ignorePatterns/u],
    [{ '.oxlintrc.json/x': '' }, ['.oxlintrc.json'], /could not be read/u],
    [
      { '.oxlintrc.json': '{ "ignorePatterns": "vendor" }' },
      ['.oxlintrc.json'],
      /not a JSON object, or its ignorePatterns/u,
    ],
    [
      { '.oxlintrc.json': '{ "ignorePatterns": [1] }' },
      ['.oxlintrc.json'],
      /not a JSON object, or its ignorePatterns/u,
    ],
    [
      { '.oxlintrc.json': '{}\n', '.oxlintrc.jsonc': '{}\n' },
      ['.oxlintrc.json', '.oxlintrc.jsonc'],
      /more than one/u,
    ],
  ])('leaves out ignores it cannot read, and doctor names why', (files, consumer, reason) => {
    const root = repo(files);
    expect(readConsumerIgnores(root, consumer).unreadable).toMatch(reason);
    expect(entryOf(root, consumer)).toEqual({ extends: [BASE] });
    const row = overlayDiscoveryRow(root, consumer, true);
    expect(row.status).toBe('DRIFT');
    expect(row.fixable).toBeFalsy();
  });

  it('reports the entry as inert while anti-slop is off, whatever the consumer config says', () => {
    const root = repo({ 'oxlint.config.ts': 'export default {};\n' });
    expect(overlayDiscoveryRow(root, ['oxlint.config.ts'], false).status).toBe('OK');
  });

  it('reports a missing entry as DRIFT, never as honoured', () => {
    const root = repo({ '.oxlintrc.json': '{ "ignorePatterns": ["a"] }\n' });
    expect(overlayDiscoveryRow(root, ['.oxlintrc.json'], true).status).toBe('DRIFT');
  });

  it('reports a stale entry once the consumer ignores change under it', () => {
    const root = repo({ '.oxlintrc.json': '{ "ignorePatterns": ["a"] }\n' });
    writeFileSync(
      join(root, OVERLAY_ENTRY_REL),
      overlayEntry(readConsumerIgnores(root, ['.oxlintrc.json']).patterns),
    );
    expect(overlayDiscoveryRow(root, ['.oxlintrc.json'], true).status).toBe('OK');

    writeFileSync(join(root, '.oxlintrc.json'), '{ "ignorePatterns": ["a", "b"] }\n');
    const row = overlayDiscoveryRow(root, ['.oxlintrc.json'], true);
    expect(row.status).toBe('DRIFT');
    expect(row.detail).toContain('.oxlintrc.json');
  });

  // Proven against the bundled Oxlint: a consumer config naming a rule that Oxlint version does not
  // know (a repo pinned to a newer Oxlint) must not break the run, and the copied ignores still apply.
  it('runs under the bundled Oxlint despite consumer rules it does not know, honouring ignores', () => {
    const root = repo({
      '.oxlintrc.json': JSON.stringify({
        rules: { 'react/rule-from-a-newer-oxlint': 'error' },
        ignorePatterns: ['vendor'],
      }),
      '.devkit/oxc/oxlint.base.json': JSON.stringify({ rules: { 'no-debugger': 'error' } }),
      'a.ts': 'debugger;\nexport const a = 1;\n',
      'vendor/b.ts': 'debugger;\nexport const b = 1;\n',
    });
    writeFileSync(
      join(root, OVERLAY_ENTRY_REL),
      overlayEntry(readConsumerIgnores(root, ['.oxlintrc.json']).patterns),
    );

    const run = spawnSync(
      process.execPath,
      [resolveOxcRuntime('lint').binPath, '-c', OVERLAY_ENTRY_REL, '--format', 'json', '.'],
      { cwd: root, encoding: 'utf8' },
    );
    const report: OxlintReport = JSON.parse(run.stdout);
    const hits = report.diagnostics.map((d) => `${d.filename} ${d.code}`);
    expect(hits).toEqual(['a.ts eslint(no-debugger)']);
  });
});
