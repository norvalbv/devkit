import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncOxcCapability } from '../oxc/lifecycle.mts';
import {
  checkAntiSlopCapability,
  removeAntiSlopCapability,
  syncAntiSlopCapability,
} from './lifecycle.mts';

const roots: string[] = [];

function root(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-lifecycle-'));
  roots.push(cwd);
  return cwd;
}

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(() => {
  vi.restoreAllMocks();
  for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe('anti-slop capability lifecycle', () => {
  it('installs all rules self-contained and integrates through the managed Oxc base', () => {
    const cwd = root();
    syncAntiSlopCapability(cwd);
    syncOxcCapability(cwd, { antiSlop: true });

    const manifest = JSON.parse(readFileSync(join(cwd, '.devkit/anti-slop/manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      upstreamCommit: '446268e5d15baa968eaec669ff65358d36ae6259',
      pluginApiVersion: '1.78.0',
    });
    expect(manifest.ruleIds).toHaveLength(15);
    expect(existsSync(join(cwd, '.devkit/anti-slop/plugin/oxlint-plugins-api/index.js'))).toBe(
      true,
    );
    expect(readFileSync(join(cwd, '.devkit/anti-slop/plugin/package.json'), 'utf8')).toContain(
      '"#oxlint-plugins"',
    );
    expect(existsSync(join(cwd, '.devkit/anti-slop/probe.ts'))).toBe(true);
    expect(readFileSync(join(cwd, '.devkit/oxc/oxlint.base.json'), 'utf8')).toContain(
      '../anti-slop/oxlint.json',
    );
    expect(checkAntiSlopCapability(cwd).every((result) => result.status === 'OK')).toBe(true);
  });

  it('repairs managed drift without touching a repository baseline', () => {
    const cwd = root();
    syncAntiSlopCapability(cwd);
    syncOxcCapability(cwd, { antiSlop: true });
    writeFileSync(join(cwd, '.anti-slop-baseline.json'), '{"consumer":"data"}\n');
    writeFileSync(join(cwd, '.devkit/anti-slop/oxlint.json'), '{}\n');
    expect(checkAntiSlopCapability(cwd).some((result) => result.status === 'DRIFT')).toBe(true);

    syncAntiSlopCapability(cwd);
    expect(checkAntiSlopCapability(cwd).every((result) => result.status === 'OK')).toBe(true);
    removeAntiSlopCapability(cwd);

    expect(readFileSync(join(cwd, '.anti-slop-baseline.json'), 'utf8')).toBe(
      '{"consumer":"data"}\n',
    );
    expect(existsSync(join(cwd, '.devkit/anti-slop'))).toBe(false);
    const base = JSON.parse(readFileSync(join(cwd, '.devkit/oxc/oxlint.base.json'), 'utf8')) as {
      extends?: string[];
    };
    expect(base.extends ?? []).not.toContain('../anti-slop/oxlint.json');
  });

  it('reports a preserved consumer config that does not compose the managed base', () => {
    const cwd = root();
    writeFileSync(join(cwd, '.oxlintrc.json'), '{ "rules": {} }\n');
    syncAntiSlopCapability(cwd);

    expect(checkAntiSlopCapability(cwd)).toContainEqual(
      expect.objectContaining({ name: 'anti-slop Oxc integration', status: 'DRIFT' }),
    );
    writeFileSync(
      join(cwd, '.oxlintrc.json'),
      '{ "extends": ["./.devkit/anti-slop/oxlint.json"], "rules": {} }\n',
    );
    expect(checkAntiSlopCapability(cwd)).toContainEqual(
      expect.objectContaining({
        name: 'anti-slop Oxc integration',
        status: 'DRIFT',
        detail: 'consumer config does not load the managed Oxlint base',
      }),
    );
    writeFileSync(
      join(cwd, '.oxlintrc.json'),
      '{ "extends": ["./.devkit/oxc/oxlint.base.json"], "rules": {} }\n',
    );
    expect(checkAntiSlopCapability(cwd).every((result) => result.status === 'OK')).toBe(true);

    writeFileSync(
      join(cwd, 'local-plugin.mjs'),
      `const rule = { create(context) { return { ClassDeclaration(node) { context.report({ message: 'local', node }); } }; } };
export default { meta: { name: 'local' }, rules: { classes: rule } };
`,
    );
    writeFileSync(
      join(cwd, '.oxlintrc.json'),
      '{ "extends": ["./.devkit/oxc/oxlint.base.json"], "jsPlugins": ["./local-plugin.mjs"], "rules": { "local/classes": "error" } }\n',
    );
    expect(checkAntiSlopCapability(cwd).every((result) => result.status === 'OK')).toBe(true);
  });

  it('preflights Oxc collisions before publishing anti-slop managed state', () => {
    const cwd = root();
    writeFileSync(join(cwd, '.oxlintrc.json'), '{}\n');
    writeFileSync(join(cwd, 'oxlint.config.ts'), 'export default {};\n');

    expect(() => syncAntiSlopCapability(cwd)).toThrow('multiple Oxc configs');

    expect(existsSync(join(cwd, '.devkit/anti-slop'))).toBe(false);
    expect(existsSync(join(cwd, '.devkit/oxc'))).toBe(false);
  });
});
