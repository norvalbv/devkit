import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type Fixture, makeFixture, out } from './lib/harness.mts';

const created: Fixture[] = [];
const cloneParents: string[] = [];
afterAll(() => {
  for (const fixture of created) fixture.cleanup();
  for (const parent of cloneParents) rmSync(parent, { recursive: true, force: true });
});

async function fixture(): Promise<Fixture> {
  const value = await makeFixture('devkit-anti-slop-e2e-');
  created.push(value);
  return value;
}

const INITIAL = readFileSync(new URL('./fixtures/anti-slop/all-rules.ts', import.meta.url), 'utf8');
const INIT_ARGS = [
  'init',
  '--stack',
  'generic',
  '--yes',
  '--standalone',
  '--anti-slop',
  '--no-biome',
  '--no-tsconfig',
  '--no-skills',
  '--no-agents',
  '--no-husky',
  '--no-structure',
  '--no-guards',
  '--no-line-growth',
];

function baseline(root: string) {
  return JSON.parse(readFileSync(join(root, '.anti-slop-baseline.json'), 'utf8'));
}

describe('e2e: packed anti-slop capability', () => {
  it('refuses a baseline when a preserved consumer config omits the managed base', async () => {
    const fx = await fixture();
    writeFileSync(
      join(fx.repoDir, '.oxlintrc.jsonc'),
      '{\n  // "extends": ["./.devkit/oxc/oxlint.base.json"],\n  "rules": {}\n}\n',
    );
    expect(fx.run('devkit', INIT_ARGS).status).toBe(0);
    writeFileSync(
      join(fx.repoDir, '.devkit/.oxlintrc.json'),
      '{ "extends": ["./oxc/oxlint.base.json"] }\n',
    );
    writeFileSync(join(fx.repoDir, 'bad.ts'), 'function bad(value: object) { return value; }\n');

    const create = fx.run('devkit', ['anti-slop', 'create', 'bad.ts']);

    expect(create.status, out(create)).not.toBe(0);
    expect(out(create)).toContain('refusing an incomplete baseline');
    expect(existsSync(join(fx.repoDir, '.anti-slop-baseline.json'))).toBe(false);
    expect(fx.run('devkit', ['doctor']).status).not.toBe(0);
  });

  it('requires the repository config to compose the managed Oxc base', async () => {
    const fx = await fixture();
    expect(fx.run('devkit', INIT_ARGS).status).toBe(0);
    writeFileSync(
      join(fx.repoDir, '.oxlintrc.json'),
      '{ "extends": ["./.devkit/anti-slop/oxlint.json"] }\n',
    );
    writeFileSync(join(fx.repoDir, 'bad.ts'), 'function bad(value: object) { return value; }\n');

    const create = fx.run('devkit', ['anti-slop', 'create', 'bad.ts']);

    expect(create.status, out(create)).not.toBe(0);
    expect(out(create)).toContain('does not load the managed Oxlint base');
    expect(existsSync(join(fx.repoDir, '.anti-slop-baseline.json'))).toBe(false);
  });

  it('recovers an installed capability when init was interrupted before its config write', async () => {
    const fx = await fixture();
    expect(fx.run('devkit', INIT_ARGS).status).toBe(0);
    renameSync(
      join(fx.repoDir, '.devkit/config.json'),
      join(fx.repoDir, '.devkit/config.interrupted.json'),
    );

    const retry = fx.run(
      'devkit',
      INIT_ARGS.filter((argument) => argument !== '--anti-slop'),
    );

    expect(retry.status, out(retry)).toBe(0);
    const recovered = JSON.parse(readFileSync(join(fx.repoDir, '.devkit/config.json'), 'utf8')) as {
      components: { antiSlop: boolean };
    };
    expect(recovered.components.antiSlop).toBe(true);
    expect(recovered.components).not.toHaveProperty('oxc');
    expect(fx.run('devkit', ['doctor']).status).toBe(0);
  });

  it('deselects anti-slop without leaving a dangling managed Oxc base pointer', async () => {
    const fx = await fixture();
    expect(fx.run('devkit', INIT_ARGS).status).toBe(0);
    const deselect = fx.run('devkit', [
      ...INIT_ARGS.filter((argument) => argument !== '--anti-slop'),
      '--no-anti-slop',
      '--remove-deselected',
    ]);

    expect(deselect.status, out(deselect)).toBe(0);
    expect(existsSync(join(fx.repoDir, '.devkit/anti-slop'))).toBe(false);
    expect(readFileSync(join(fx.repoDir, '.devkit/oxc/oxlint.base.json'), 'utf8')).not.toContain(
      '../anti-slop/oxlint.json',
    );
    expect(fx.run('devkit', ['doctor']).status).toBe(0);
  });

  it('survives an ordinary package-mode git add and clone without reinstalling managed state', async () => {
    const fx = await fixture();
    writeFileSync(join(fx.repoDir, '.gitignore'), 'node_modules\nvendor/\n');
    const packageArgs = INIT_ARGS.filter((argument) => argument !== '--standalone');
    expect(fx.run('devkit', packageArgs).status).toBe(0);
    writeFileSync(join(fx.repoDir, 'legacy.ts'), INITIAL);
    expect(fx.run('devkit', ['anti-slop', 'create', 'legacy.ts']).status).toBe(0);
    expect(fx.git('add', '-A').status).toBe(0);
    expect(
      fx.git('ls-files', '.devkit/anti-slop/plugin/oxlint-plugins-api/index.js').stdout.trim(),
    ).toBe('.devkit/anti-slop/plugin/oxlint-plugins-api/index.js');
    expect(fx.git('ls-files', '.devkit/anti-slop/plugin/node_modules/**').stdout.trim()).toBe('');
    expect(fx.git('commit', '-qm', 'fixture').status).toBe(0);

    const parent = mkdtempSync(join(tmpdir(), 'devkit-anti-slop-clone-'));
    cloneParents.push(parent);
    const checkout = join(parent, 'checkout');
    const cloned = spawnSync('git', ['clone', '-q', fx.repoDir, checkout], {
      encoding: 'utf8',
      env: fx.env,
    });
    expect(cloned.status, out(cloned)).toBe(0);
    expect(existsSync(join(checkout, 'node_modules'))).toBe(false);

    const doctor = spawnSync('devkit', ['doctor'], {
      cwd: checkout,
      encoding: 'utf8',
      env: fx.env,
    });
    expect(doctor.status, out(doctor)).toBe(0);
    const checked = spawnSync('devkit', ['anti-slop', 'check', 'legacy.ts'], {
      cwd: checkout,
      encoding: 'utf8',
      env: fx.env,
    });
    expect(checked.status, out(checked)).toBe(0);
  });

  it('checks exact staged bytes, rejects growth, and persists Git renames durably', async () => {
    const fx = await fixture();
    const packageArgs = INIT_ARGS.filter((argument) => argument !== '--standalone');
    expect(fx.run('devkit', packageArgs).status).toBe(0);
    expect(fx.run('devkit', ['anti-slop', 'create']).status).toBe(0);
    expect(fx.git('add', '-A').status).toBe(0);
    expect(fx.git('commit', '-qm', 'bootstrap').status).toBe(0);

    const staged = join(fx.repoDir, 'staged.ts');
    writeFileSync(staged, 'function staged(value: object) { return value; }\n');
    expect(fx.git('add', 'staged.ts').status).toBe(0);
    writeFileSync(staged, 'export const workingTreeIsClean = true;\n');
    const stagedBad = fx.run('devkit', ['anti-slop', 'check', '--staged']);
    expect(stagedBad.status, out(stagedBad)).toBe(1);
    expect(out(stagedBad)).toContain('anti-slop/no-object-parameters');

    expect(fx.git('reset', '-q', 'HEAD', '--', 'staged.ts').status).toBe(0);
    writeFileSync(staged, 'export const stagedIsClean = true;\n');
    expect(fx.git('add', 'staged.ts').status).toBe(0);
    writeFileSync(staged, 'function working(value: object) { return value; }\n');
    const stagedClean = fx.run('devkit', ['anti-slop', 'check', '--staged']);
    expect(stagedClean.status, out(stagedClean)).toBe(0);

    expect(fx.git('reset', '-q', 'HEAD', '--', 'staged.ts').status).toBe(0);
    rmSync(staged, { force: true });
    writeFileSync(
      join(fx.repoDir, 'adopted.ts'),
      'function adopted(value: object) { return value; }\n',
    );
    expect(fx.run('devkit', ['anti-slop', 'create', '--force']).status).toBe(0);
    expect(fx.git('add', 'adopted.ts', '.anti-slop-baseline.json').status).toBe(0);
    const laundered = fx.run('devkit', ['anti-slop', 'check', '--staged']);
    expect(laundered.status, out(laundered)).toBe(1);
    expect(out(laundered)).toContain('BASELINE-GROWTH');
    const ciLaundered = fx.run('devkit', ['anti-slop', 'check', '--base', 'HEAD']);
    expect(ciLaundered.status, out(ciLaundered)).toBe(1);
    expect(out(ciLaundered)).toContain('BASELINE-GROWTH');

    const renamed = await fixture();
    expect(renamed.run('devkit', packageArgs).status).toBe(0);
    writeFileSync(
      join(renamed.repoDir, 'legacy.ts'),
      'function legacy(value: object) { return value; }\n',
    );
    expect(renamed.run('devkit', ['anti-slop', 'create']).status).toBe(0);
    expect(renamed.git('add', '-A').status).toBe(0);
    expect(renamed.git('commit', '-qm', 'adopt legacy debt').status).toBe(0);
    expect(renamed.git('mv', 'legacy.ts', 'renamed.ts').status).toBe(0);
    const staleRenameCheck = renamed.run('devkit', ['anti-slop', 'check', '--staged']);
    expect(staleRenameCheck.status, out(staleRenameCheck)).toBe(1);
    expect(out(staleRenameCheck)).toContain('BASELINE-RENAME');
    expect(renamed.run('devkit', ['anti-slop', 'create', '--force']).status).toBe(0);
    expect(renamed.git('add', '.anti-slop-baseline.json').status).toBe(0);
    const renameCheck = renamed.run('devkit', ['anti-slop', 'check', '--staged']);
    expect(renameCheck.status, out(renameCheck)).toBe(0);
    const ciRenameCheck = renamed.run('devkit', ['anti-slop', 'check', '--base', 'HEAD']);
    expect(ciRenameCheck.status, out(ciRenameCheck)).toBe(0);
    expect(renamed.git('commit', '-qm', 'persist renamed debt').status).toBe(0);
    expect(renamed.run('devkit', ['anti-slop', 'check']).status).toBe(0);
    writeFileSync(join(renamed.repoDir, 'unrelated.ts'), 'export const unrelated = true;\n');
    expect(renamed.git('add', 'unrelated.ts').status).toBe(0);
    expect(renamed.run('devkit', ['anti-slop', 'check', '--staged']).status).toBe(0);
    expect(renamed.run('devkit', ['anti-slop', 'check', '--base', 'HEAD']).status).toBe(0);
  });

  it('attributes inherited findings to an already-red CI base without allowing growth', async () => {
    const fx = await fixture();
    const packageArgs = INIT_ARGS.filter((argument) => argument !== '--standalone');
    expect(fx.run('devkit', packageArgs).status).toBe(0);
    expect(fx.run('devkit', ['anti-slop', 'create']).status).toBe(0);
    expect(fx.git('add', '-A').status).toBe(0);
    expect(fx.git('commit', '-qm', 'bootstrap').status).toBe(0);

    const inherited = 'function inherited(value: object) { return value; }\n';
    writeFileSync(join(fx.repoDir, 'inherited.ts'), inherited);
    expect(fx.git('add', 'inherited.ts').status).toBe(0);
    expect(fx.git('commit', '-qm', 'red base').status).toBe(0);
    const redBase = fx.git('rev-parse', 'HEAD').stdout.trim();

    writeFileSync(join(fx.repoDir, 'unrelated.ts'), 'export const unrelated = true;\n');
    expect(fx.git('add', 'unrelated.ts').status).toBe(0);
    const inheritedCheck = fx.run('devkit', ['anti-slop', 'check', '--base', redBase]);
    expect(inheritedCheck.status, out(inheritedCheck)).toBe(0);

    writeFileSync(join(fx.repoDir, 'inherited.ts'), `${inherited}${inherited}`);
    expect(fx.git('add', 'inherited.ts').status).toBe(0);
    const growthCheck = fx.run('devkit', ['anti-slop', 'check', '--base', redBase]);
    expect(growthCheck.status, out(growthCheck)).toBe(1);
    expect(out(growthCheck)).toContain('anti-slop/no-object-parameters');
  });

  it('checks candidate findings normally when the CI base predates anti-slop', async () => {
    const fx = await fixture();
    const preInstallBase = fx.git('rev-parse', 'HEAD').stdout.trim();
    const packageArgs = INIT_ARGS.filter((argument) => argument !== '--standalone');
    expect(fx.run('devkit', packageArgs).status).toBe(0);
    expect(fx.run('devkit', ['anti-slop', 'create']).status).toBe(0);
    writeFileSync(
      join(fx.repoDir, 'candidate.ts'),
      'function candidate(value: object) { return value; }\n',
    );
    expect(fx.git('add', '-A').status).toBe(0);

    const check = fx.run('devkit', ['anti-slop', 'check', '--base', preInstallBase]);
    expect(check.status, out(check)).toBe(1);
    expect(out(check)).toContain('anti-slop/no-object-parameters');
    expect(out(check)).not.toContain('anti-slop is not installed');
  });

  it('does not inherit debt for an introduced copy of a red-base source path', async () => {
    const fx = await fixture();
    const packageArgs = INIT_ARGS.filter((argument) => argument !== '--standalone');
    expect(fx.run('devkit', packageArgs).status).toBe(0);
    expect(fx.run('devkit', ['anti-slop', 'create']).status).toBe(0);
    const finding = 'function repeated(value: object) { return value; }\n';
    writeFileSync(join(fx.repoDir, 'source.ts'), finding);
    expect(fx.git('add', '-A').status).toBe(0);
    expect(fx.git('commit', '-qm', 'red base').status).toBe(0);
    const redBase = fx.git('rev-parse', 'HEAD').stdout.trim();

    expect(fx.git('mv', 'source.ts', 'renamed.ts').status).toBe(0);
    writeFileSync(join(fx.repoDir, 'source.ts'), `${finding}export const replacement = true;\n`);
    expect(fx.git('add', 'source.ts').status).toBe(0);
    const check = fx.run('devkit', ['anti-slop', 'check', '--base', redBase]);

    expect(check.status, out(check)).toBe(1);
    expect(out(check)).toContain('anti-slop/no-object-parameters renamed.ts');
  });

  it('vendors all rules and enforces an explicit deterministic shrink-only adoption flow', async () => {
    const fx = await fixture();
    const init = fx.run('devkit', INIT_ARGS);
    expect(init.status, out(init)).toBe(0);
    expect(existsSync(join(fx.repoDir, '.devkit/anti-slop/manifest.json'))).toBe(true);
    expect(existsSync(join(fx.repoDir, '.devkit/oxc/manifest.json'))).toBe(true);
    const ordinaryProbe = fx.run('devkit', [
      'oxc',
      'lint',
      '--format',
      'json',
      '.devkit/anti-slop/probe.ts',
    ]);
    expect([0, 1], out(ordinaryProbe)).toContain(ordinaryProbe.status);
    expect(
      JSON.parse(ordinaryProbe.stdout).diagnostics.filter((diagnostic: { code?: string }) =>
        diagnostic.code?.startsWith('anti-slop('),
      ),
    ).toEqual([]);
    const composed = fx.run('devkit', [
      'oxc',
      'lint',
      '--format',
      'json',
      '--disable-nested-config',
      '.',
    ]);
    expect([0, 1], out(composed)).toContain(composed.status);
    const composedPayload = JSON.parse(composed.stdout) as {
      diagnostics: Array<{ code?: string; filename?: string }>;
    };
    expect(
      composedPayload.diagnostics.filter(
        (diagnostic) =>
          diagnostic.code?.startsWith('anti-slop(') &&
          diagnostic.filename?.includes('.devkit/anti-slop/'),
      ),
    ).toEqual([
      expect.objectContaining({
        code: 'anti-slop(no-object-parameters)',
        filename: '.devkit/anti-slop/probe.ts',
      }),
    ]);

    writeFileSync(join(fx.repoDir, 'legacy.ts'), INITIAL);
    writeFileSync(join(fx.repoDir, 'held.ts'), INITIAL);
    writeFileSync(join(fx.repoDir, '.devkit/oxc/oxlint.base.json'), '{ "rules": {} }\n');
    const disconnected = fx.run('devkit', ['anti-slop', 'create', 'legacy.ts']);
    expect(disconnected.status, out(disconnected)).not.toBe(0);
    expect(out(disconnected)).toContain('managed Oxlint base is missing or drifted');
    expect(existsSync(join(fx.repoDir, '.anti-slop-baseline.json'))).toBe(false);
    fx.run('devkit', ['doctor', '--fix']);
    expect(fx.run('devkit', ['doctor']).status).toBe(0);
    const missing = fx.run('devkit', ['anti-slop', 'check', 'legacy.ts']);
    expect(missing.status, out(missing)).toBe(2);
    expect(existsSync(join(fx.repoDir, '.anti-slop-baseline.json'))).toBe(false);

    const create = fx.run('devkit', ['anti-slop', 'create', 'legacy.ts', 'held.ts']);
    expect(create.status, out(create)).toBe(0);
    const originalBaseline = readFileSync(join(fx.repoDir, '.anti-slop-baseline.json'), 'utf8');
    const initial = baseline(fx.repoDir);
    expect(new Set(initial.entries.map((entry: { ruleId: string }) => entry.ruleId)).size).toBe(15);
    const heldEntries = initial.entries.filter(
      (entry: { file: string }) => entry.file === 'held.ts',
    );
    const scopedForce = fx.run('devkit', ['anti-slop', 'create', '--force', 'legacy.ts']);
    expect(scopedForce.status, out(scopedForce)).toBe(0);
    expect(
      baseline(fx.repoDir).entries.filter((entry: { file: string }) => entry.file === 'held.ts'),
    ).toEqual(heldEntries);
    expect(readFileSync(join(fx.repoDir, '.anti-slop-baseline.json'), 'utf8')).toBe(
      originalBaseline,
    );
    expect(fx.run('devkit', ['anti-slop', 'check', 'legacy.ts', 'held.ts']).status).toBe(0);
    const scopedExisting = fx.run('devkit', ['anti-slop', 'check', 'legacy.ts']);
    expect(scopedExisting.status, out(scopedExisting)).toBe(0);
    expect(out(scopedExisting)).toContain('0 ready to prune');

    mkdirSync(join(fx.repoDir, 'sub'));
    writeFileSync(join(fx.repoDir, 'sub/.oxlintrc.json'), '{}\n');
    writeFileSync(
      join(fx.repoDir, 'sub/bad.ts'),
      'function shadowed(value: object) { return value; }\n',
    );
    const nestedShadow = fx.run('devkit', ['anti-slop', 'check', 'sub/bad.ts']);
    expect(nestedShadow.status, out(nestedShadow)).toBe(1);
    expect(out(nestedShadow)).toContain('anti-slop/no-object-parameters');
    writeFileSync(join(fx.repoDir, 'sub/bad.ts'), 'export const fixedShadow = true;\n');

    const second = await fixture();
    expect(second.run('devkit', INIT_ARGS).status).toBe(0);
    writeFileSync(join(second.repoDir, 'legacy.ts'), INITIAL);
    writeFileSync(join(second.repoDir, 'held.ts'), INITIAL);
    expect(second.run('devkit', ['anti-slop', 'create']).status).toBe(0);
    expect(readFileSync(join(second.repoDir, '.anti-slop-baseline.json'), 'utf8')).toBe(
      originalBaseline,
    );

    writeFileSync(join(fx.repoDir, 'new.ts'), 'function newer(value: object) { return value; }\n');
    const introduced = fx.run('devkit', ['anti-slop', 'check', 'legacy.ts', 'held.ts', 'new.ts']);
    expect(introduced.status, out(introduced)).toBe(1);
    expect(out(introduced)).toContain('anti-slop/no-object-parameters');
    expect(readFileSync(join(fx.repoDir, '.anti-slop-baseline.json'), 'utf8')).toBe(
      originalBaseline,
    );

    writeFileSync(
      join(fx.repoDir, 'new.ts'),
      'interface RecordValue { id: string }\nfunction newer(value: RecordValue) { return value; }\n',
    );
    expect(fx.run('devkit', ['anti-slop', 'check', 'legacy.ts', 'held.ts', 'new.ts']).status).toBe(
      0,
    );

    writeFileSync(
      join(fx.repoDir, '.oxlintrc.json'),
      `${JSON.stringify({
        extends: ['./.devkit/oxc/oxlint.base.json'],
        rules: {
          'anti-slop/no-object-parameters': 'warn',
          'anti-slop/no-reflect-get': 'off',
        },
      })}\n`,
    );
    writeFileSync(
      join(fx.repoDir, 'controls.ts'),
      'function controlled(value: object) { return Reflect.get(value, "id"); }\n',
    );
    const warning = fx.run('devkit', ['anti-slop', 'check', 'controls.ts']);
    expect(warning.status, out(warning)).toBe(0);
    expect(out(warning)).toContain('WARN anti-slop/no-object-parameters');
    expect(out(warning)).not.toContain('anti-slop/no-reflect-get');

    writeFileSync(
      join(fx.repoDir, '.oxlintrc.json'),
      `${JSON.stringify({
        extends: ['./.devkit/oxc/oxlint.base.json'],
        rules: {
          'anti-slop/no-object-parameters': 'error',
          'anti-slop/no-reflect-get': 'off',
        },
        overrides: [
          {
            files: ['controls.ts'],
            rules: { 'anti-slop/no-object-parameters': 'off' },
          },
        ],
      })}\n`,
    );
    const scoped = fx.run('devkit', ['anti-slop', 'check', 'controls.ts']);
    expect(scoped.status, out(scoped)).toBe(0);

    writeFileSync(join(fx.repoDir, 'legacy.ts'), 'export const fixed = true;\n');
    const prune = fx.run('devkit', ['anti-slop', 'prune', 'legacy.ts', 'new.ts']);
    expect(prune.status, out(prune)).toBe(0);
    expect(
      baseline(fx.repoDir).entries.every((entry: { file: string }) => entry.file === 'held.ts'),
    ).toBe(true);
    expect(fx.run('devkit', ['anti-slop', 'check', 'held.ts']).status).toBe(0);
    writeFileSync(join(fx.repoDir, 'held.ts'), 'export const alsoFixed = true;\n');
    expect(fx.run('devkit', ['anti-slop', 'prune', 'held.ts']).status).toBe(0);
    expect(baseline(fx.repoDir).entries).toEqual([]);
    expect(fx.run('devkit', ['anti-slop', 'inspect']).status).toBe(0);
    expect(fx.run('devkit', ['doctor']).status).toBe(0);

    expect(fx.run('devkit', ['clean', '--yes']).status).toBe(0);
    expect(existsSync(join(fx.repoDir, '.devkit/anti-slop'))).toBe(false);
    expect(existsSync(join(fx.repoDir, '.anti-slop-baseline.json'))).toBe(true);
  });
});
