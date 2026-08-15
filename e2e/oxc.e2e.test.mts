import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type Fixture, makeFixture, out } from './lib/harness.mts';

const created: Fixture[] = [];
afterAll(() => {
  for (const fixture of created) fixture.cleanup();
});

async function fixture(): Promise<Fixture> {
  const value = await makeFixture('devkit-oxc-e2e-');
  created.push(value);
  return value;
}

const INIT_ARGS = [
  'init',
  '--stack',
  'generic',
  '--yes',
  '--standalone',
  '--oxc',
  '--no-biome',
  '--no-tsconfig',
  '--no-skills',
  '--no-agents',
  '--no-husky',
  '--no-structure',
  '--no-guards',
  '--no-line-growth',
];

describe('e2e: packed Oxc capability', () => {
  it('installs, runs exact pins, honors rule overrides, survives doctor, and uninstalls safely', async () => {
    const fx = await fixture();
    const packageBefore = readFileSync(join(fx.repoDir, 'package.json'), 'utf8');

    const init = fx.run('devkit', INIT_ARGS);
    expect(init.status, out(init)).toBe(0);
    expect(readFileSync(join(fx.repoDir, 'package.json'), 'utf8')).toBe(packageBefore);
    expect(existsSync(join(fx.repoDir, '.devkit/oxc/oxlint.base.json'))).toBe(true);
    expect(existsSync(join(fx.repoDir, '.oxlintrc.json'))).toBe(true);
    expect(existsSync(join(fx.repoDir, '.oxfmtrc.json'))).toBe(true);

    const lintVersion = fx.run('devkit', ['oxc', 'lint', '--version']);
    const fmtVersion = fx.run('devkit', ['oxc', 'fmt', '--version']);
    expect(lintVersion.status, out(lintVersion)).toBe(0);
    expect(fmtVersion.status, out(fmtVersion)).toBe(0);
    expect(out(lintVersion)).toContain('1.78.0');
    expect(out(fmtVersion)).toContain('0.63.0');

    writeFileSync(join(fx.repoDir, 'rule-target.ts'), 'debugger;\n');
    writeFileSync(
      join(fx.repoDir, '.oxlintrc.json'),
      `${JSON.stringify({
        extends: ['./.devkit/oxc/oxlint.base.json'],
        rules: { 'no-debugger': 'error' },
      })}\n`,
    );
    const denied = fx.run('devkit', ['oxc', 'lint', 'rule-target.ts']);
    expect(denied.status, out(denied)).toBe(1);
    expect(out(denied)).toContain('no-debugger');

    writeFileSync(
      join(fx.repoDir, '.oxlintrc.json'),
      `${JSON.stringify({
        extends: ['./.devkit/oxc/oxlint.base.json'],
        overrides: [{ files: ['rule-target.ts'], rules: { 'no-debugger': 'off' } }],
        rules: { 'no-debugger': 'error' },
      })}\n`,
    );
    const allowed = fx.run('devkit', ['oxc', 'lint', 'rule-target.ts']);
    expect(allowed.status, out(allowed)).toBe(0);

    writeFileSync(
      join(fx.repoDir, 'local-plugin.js'),
      `const rule = {
  create(context) {
    let count = 0;
    return {
      ClassDeclaration(node) {
        count += 1;
        if (count === 2) context.report({ message: 'Too many classes', node });
      },
    };
  },
};
export default { meta: { name: 'local' }, rules: { 'max-classes': rule } };
`,
    );
    writeFileSync(join(fx.repoDir, 'plugin-target.ts'), 'class A {} class B {}\n');
    writeFileSync(
      join(fx.repoDir, '.oxlintrc.json'),
      `${JSON.stringify({
        extends: ['./.devkit/oxc/oxlint.base.json'],
        jsPlugins: ['./local-plugin.js'],
        rules: { 'local/max-classes': ['error'] },
      })}\n`,
    );
    const plugin = fx.run('devkit', ['oxc', 'lint', 'plugin-target.ts']);
    expect(plugin.status, out(plugin)).toBe(1);
    expect(out(plugin)).toContain('local(max-classes)');
    expect(out(plugin)).toContain('Too many classes');

    const managedBase = join(fx.repoDir, '.devkit/oxc/oxlint.base.json');
    const customizedConfig = readFileSync(join(fx.repoDir, '.oxlintrc.json'), 'utf8');
    writeFileSync(managedBase, '{ "rules": { "no-debugger": "warn" } }\n');
    const upgrade = fx.run('devkit', ['upgrade']);
    expect(upgrade.status, out(upgrade)).toBe(0);
    expect(readFileSync(managedBase, 'utf8')).toBe('{\n  "rules": {}\n}\n');
    expect(readFileSync(join(fx.repoDir, '.oxlintrc.json'), 'utf8')).toBe(customizedConfig);

    writeFileSync(join(fx.repoDir, 'format-target.ts'), 'const value={answer:42}\n');
    const formatCheck = fx.run('devkit', ['oxc', 'fmt', '--check', 'format-target.ts']);
    expect(formatCheck.status, out(formatCheck)).toBe(1);
    expect(fx.run('devkit', ['oxc', 'fmt', '--write', 'format-target.ts']).status).toBe(0);
    expect(readFileSync(join(fx.repoDir, 'format-target.ts'), 'utf8')).toContain(
      'const value = { answer: 42 };',
    );

    const doctor = fx.run('devkit', ['doctor']);
    expect(doctor.status, out(doctor)).toBe(0);

    // The Oxc manifest is independent provenance: clean can recover even if the component record
    // was lost after installation, while still preserving customized root config.
    const configPath = join(fx.repoDir, '.devkit/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.components.oxc;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const clean = fx.run('devkit', ['clean', '--yes']);
    expect(clean.status, out(clean)).toBe(0);
    expect(existsSync(join(fx.repoDir, '.devkit/oxc'))).toBe(false);
    expect(existsSync(join(fx.repoDir, '.oxfmtrc.json'))).toBe(false);
    expect(existsSync(join(fx.repoDir, '.oxlintrc.json'))).toBe(true);
  });
});
