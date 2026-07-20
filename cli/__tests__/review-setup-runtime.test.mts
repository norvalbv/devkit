import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOverlayHook, buildStandaloneHook } from '../lib/husky/husky-block.mts';
import { captureReviewSetup } from '../lib/ship/review/setup-manifest.mts';
import {
  encodeReviewSetupRuntimeFields,
  materializeReviewSetupRuntime,
  verifyReviewSetupRuntime,
  verifyReviewSetupSource,
} from '../lib/ship/review/setup-runtime.mts';
import { reviewSetupFixtures } from './review-setup-fixture.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '../lib/ship/review/setup-runtime.mts');
const { git, mkTmp, selection, write } = reviewSetupFixtures();

function config(overlay: boolean, pkgRel = '') {
  return {
    stack: 'generic',
    standalone: !overlay,
    overlay,
    ...(overlay ? { origHooksPath: '.git/hooks' } : {}),
    ...(pkgRel ? { pkgRel } : {}),
    components: selection,
    review: { enabled: true, guards: ['size', 'decisions'], decisionsDir: 'docs/decisions' },
  };
}

function fixture(
  name: string,
  options: { overlay?: boolean; nested?: boolean; linkedRunner?: boolean } = {},
) {
  const parent = mkTmp(`devkit-review-setup-runtime-${name}-`);
  const gitRoot = join(parent, 'source');
  const targetRoot = options.nested ? join(gitRoot, 'packages/app') : gitRoot;
  const targetRel = options.nested ? 'packages/app' : '';
  mkdirSync(targetRoot, { recursive: true });
  git(gitRoot, 'init', '-q');
  if (options.overlay) {
    writeFileSync(join(gitRoot, '.git/hooks/pre-commit'), '#!/bin/sh\necho chain\n', {
      mode: 0o755,
    });
    write(
      gitRoot,
      '.devkit/hooks/pre-commit',
      buildOverlayHook(selection, '.git/hooks/pre-commit', targetRel),
      true,
    );
  } else {
    const runner = options.linkedRunner
      ? join(parent, 'projected-runner')
      : join(gitRoot, '.husky/_');
    write(runner, 'pre-commit', '#!/bin/sh\nexit 0\n', true);
    write(runner, 'h', '#!/bin/sh\nexit 0\n');
    write(runner, 'helper', 'helper\n');
    if (options.linkedRunner) {
      mkdirSync(join(gitRoot, '.husky'), { recursive: true });
      symlinkSync(relative(join(gitRoot, '.husky'), runner), join(gitRoot, '.husky/_'));
    }
    write(gitRoot, '.husky/pre-commit', buildStandaloneHook(selection, targetRel), true);
  }
  write(
    targetRoot,
    '.devkit/config.json',
    `${JSON.stringify(config(Boolean(options.overlay), targetRel), null, 2)}\n`,
  );
  git(gitRoot, 'config', 'core.hooksPath', options.overlay ? '.devkit/hooks' : '.husky/_');
  const setupManifest = join(parent, 'setup.json');
  captureReviewSetup(targetRoot, setupManifest);
  const destination = join(parent, 'private');
  mkdirSync(destination);
  const runtimeManifest = join(parent, 'runtime.json');
  return { parent, gitRoot, targetRoot, targetRel, setupManifest, destination, runtimeManifest };
}

function seedSnapshot(fx: ReturnType<typeof fixture>, overlay = false): void {
  const targetPrefix = fx.targetRel ? `${fx.targetRel}/` : '';
  const pairs = [
    [`${targetPrefix}.devkit/config.json`, join(fx.targetRoot, '.devkit/config.json')],
    [
      overlay ? '.devkit/hooks/pre-commit' : '.husky/pre-commit',
      join(fx.gitRoot, overlay ? '.devkit/hooks/pre-commit' : '.husky/pre-commit'),
    ],
  ];
  for (const [path, source] of pairs) {
    const destination = join(fx.destination, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    chmodSync(destination, lstatSync(source).mode & 0o111 ? 0o755 : 0o644);
  }
}

describe('private review setup runtime', () => {
  it('maps nested target setup, merges identical snapshot files, and dereferences the runner', () => {
    const fx = fixture('nested', { nested: true, linkedRunner: true });
    seedSnapshot(fx);

    const runtime = materializeReviewSetupRuntime(
      fx.setupManifest,
      fx.destination,
      fx.runtimeManifest,
    );

    expect(runtime.fields).toMatchObject({
      targetRelativePath: 'packages/app',
      hooksPath: '.husky/_',
      overlay: false,
      enabled: true,
      guards: ['size', 'decisions'],
      decisionsDir: 'docs/decisions',
      chainHook: '',
    });
    expect(lstatSync(join(fx.destination, '.husky/_')).isDirectory()).toBe(true);
    expect(lstatSync(join(fx.destination, '.husky/_')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(fx.destination, '.husky/_/pre-commit')).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(fx.destination, 'packages/app/.devkit/config.json'), 'utf8')).toBe(
      readFileSync(join(fx.targetRoot, '.devkit/config.json'), 'utf8'),
    );
    expect(verifyReviewSetupRuntime(fx.setupManifest, fx.runtimeManifest)).toEqual(runtime);
  });

  it('maps a .git overlay chain into a private mirror and preserves the worktree gitfile', () => {
    const fx = fixture('overlay', { overlay: true });
    seedSnapshot(fx, true);
    writeFileSync(join(fx.destination, '.git'), 'gitdir: /private/common/worktrees/review\n');

    const runtime = materializeReviewSetupRuntime(
      fx.setupManifest,
      fx.destination,
      fx.runtimeManifest,
    );

    const chain = join(
      realpathSync(fx.destination),
      '.devkit/review-chain-root/.git/hooks/pre-commit',
    );
    expect(runtime.fields.chainHook).toBe(chain);
    expect(readFileSync(chain, 'utf8')).toContain('echo chain');
    expect(readFileSync(join(fx.destination, '.git'), 'utf8')).toContain('gitdir:');
    expect(lstatSync(chain).isSymbolicLink()).toBe(false);
  });

  it('freezes a Frink-style external .devkit projection without retaining the link', () => {
    const fx = fixture('projected-devkit');
    const projected = join(fx.parent, 'projected-devkit');
    renameSync(join(fx.targetRoot, '.devkit'), projected);
    symlinkSync(projected, join(fx.targetRoot, '.devkit'));
    const manifest = join(fx.parent, 'projected-setup.json');
    captureReviewSetup(fx.targetRoot, manifest);
    seedSnapshot(fx);

    const runtime = materializeReviewSetupRuntime(manifest, fx.destination, fx.runtimeManifest);

    expect(lstatSync(join(fx.destination, '.devkit')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(fx.destination, '.devkit/config.json'), 'utf8')).toBe(
      readFileSync(join(projected, 'config.json'), 'utf8'),
    );
    expect(verifyReviewSetupRuntime(manifest, fx.runtimeManifest)).toEqual(runtime);

    writeFileSync(join(projected, 'config.json'), 'changed projected config\n');
    expect(() => verifyReviewSetupRuntime(manifest, fx.runtimeManifest)).toThrow(
      /target setup changed/,
    );
  });

  it('rejects differing bytes or executable mode instead of clobbering snapshot entries', () => {
    const bytes = fixture('byte-conflict');
    seedSnapshot(bytes);
    writeFileSync(join(bytes.destination, '.devkit/config.json'), 'different\n');
    expect(() =>
      materializeReviewSetupRuntime(bytes.setupManifest, bytes.destination, bytes.runtimeManifest),
    ).toThrow(/conflicts with snapshot entry/);

    const mode = fixture('mode-conflict');
    seedSnapshot(mode);
    chmodSync(join(mode.destination, '.husky/pre-commit'), 0o644);
    expect(() =>
      materializeReviewSetupRuntime(mode.setupManifest, mode.destination, mode.runtimeManifest),
    ).toThrow(/conflicts with snapshot entry/);
  });

  it('rolls back private additions when a source changes during materialization', () => {
    const fx = fixture('capture-mutation');
    seedSnapshot(fx);

    expect(() =>
      materializeReviewSetupRuntime(fx.setupManifest, fx.destination, fx.runtimeManifest, {
        beforeSourceVerification: () =>
          writeFileSync(join(fx.targetRoot, '.devkit/config.json'), 'changed\n'),
      }),
    ).toThrow(/target setup changed after capture/);
    expect(existsSync(join(fx.destination, '.husky/_'))).toBe(false);
    expect(existsSync(fx.runtimeManifest)).toBe(false);
  });

  it('rejects private bytes copied during a source A-to-B-to-A change', () => {
    const fx = fixture('capture-aba');
    seedSnapshot(fx);
    const helper = join(fx.gitRoot, '.husky/_/helper');

    expect(() =>
      materializeReviewSetupRuntime(fx.setupManifest, fx.destination, fx.runtimeManifest, {
        beforePrivateMaterialization: () => writeFileSync(helper, 'intermediate\n'),
        beforeSourceVerification: () => writeFileSync(helper, 'helper\n'),
      }),
    ).toThrow(/private setup does not match its captured source/);
    expect(readFileSync(helper, 'utf8')).toBe('helper\n');
    expect(existsSync(join(fx.destination, '.husky/_'))).toBe(false);
    expect(existsSync(fx.runtimeManifest)).toBe(false);
  });

  it('detects source and private mutations after hooks execute', () => {
    const privateFx = fixture('private-mutation');
    seedSnapshot(privateFx);
    materializeReviewSetupRuntime(
      privateFx.setupManifest,
      privateFx.destination,
      privateFx.runtimeManifest,
    );
    writeFileSync(join(privateFx.destination, '.husky/_/helper'), 'changed\n');
    expect(() =>
      verifyReviewSetupRuntime(privateFx.setupManifest, privateFx.runtimeManifest),
    ).toThrow(/private immutable setup changed/);

    const sourceFx = fixture('source-mutation');
    seedSnapshot(sourceFx);
    materializeReviewSetupRuntime(
      sourceFx.setupManifest,
      sourceFx.destination,
      sourceFx.runtimeManifest,
    );
    git(sourceFx.gitRoot, 'config', 'core.hooksPath', '.git/hooks');
    expect(() =>
      verifyReviewSetupRuntime(sourceFx.setupManifest, sourceFx.runtimeManifest),
    ).toThrow(/core\.hooksPath changed/);
  });

  it('rejects nested setup symlinks, special files, and destination escapes', () => {
    const linked = fixture('nested-link');
    const helper = join(linked.gitRoot, '.husky/_/helper');
    const external = write(linked.parent, 'external-helper', 'helper\n');
    rmSync(helper);
    symlinkSync(external, helper);
    expect(() =>
      materializeReviewSetupRuntime(
        linked.setupManifest,
        linked.destination,
        linked.runtimeManifest,
      ),
    ).toThrow(/nested symlink/);

    if (process.platform !== 'win32') {
      const special = fixture('special');
      const target = join(special.gitRoot, '.husky/_/helper');
      rmSync(target);
      const made = spawnSync('mkfifo', [target], { encoding: 'utf8' });
      expect(made.status, made.stderr).toBe(0);
      expect(() =>
        materializeReviewSetupRuntime(
          special.setupManifest,
          special.destination,
          special.runtimeManifest,
        ),
      ).toThrow(/special file/);
    }

    const escaped = fixture('destination-link');
    const outside = join(escaped.parent, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(escaped.destination, '.husky'));
    expect(() =>
      materializeReviewSetupRuntime(
        escaped.setupManifest,
        escaped.destination,
        escaped.runtimeManifest,
      ),
    ).toThrow(/unsafe destination parent/);
    expect(existsSync(join(outside, '_'))).toBe(false);
  });

  it('emits an exact NUL-delimited CLI record including the guard count', () => {
    const fx = fixture('cli protocol\nwith newline', { nested: true });
    seedSnapshot(fx);
    const result = spawnSync(process.execPath, [
      CLI,
      'materialize',
      fx.setupManifest,
      fx.destination,
      fx.runtimeManifest,
    ]);

    expect(result.status, result.stderr.toString()).toBe(0);
    const fields = result.stdout.subarray(0, -1).toString().split('\0');
    expect(fields).toEqual([
      'devkit-review-setup-v1',
      'packages/app',
      '.husky/_',
      '0',
      '1',
      'docs/decisions',
      '',
      '2',
      'size',
      'decisions',
    ]);
    const runtime = verifyReviewSetupRuntime(fx.setupManifest, fx.runtimeManifest);
    expect(result.stdout).toEqual(encodeReviewSetupRuntimeFields(runtime.fields));
    expect(
      spawnSync(process.execPath, [CLI, 'verify', fx.setupManifest, fx.runtimeManifest]).status,
    ).toBe(0);
  });

  it('binds clean-path source verification to the requested target and rejects stale setup', () => {
    const fx = fixture('clean-source');
    const success = spawnSync(process.execPath, [CLI, 'source', fx.setupManifest, fx.targetRoot]);
    expect(success.status, success.stderr.toString()).toBe(0);
    expect(success.stdout.length).toBe(0);
    expect(verifyReviewSetupSource(fx.setupManifest, fx.targetRoot).targetRoot).toContain(
      'clean-source',
    );

    const other = fixture('other-source');
    expect(
      spawnSync(process.execPath, [CLI, 'source', fx.setupManifest, other.targetRoot]).status,
    ).toBe(1);
    writeFileSync(join(fx.targetRoot, '.devkit/config.json'), 'stale\n');
    const stale = spawnSync(process.execPath, [CLI, 'source', fx.setupManifest, fx.targetRoot]);
    expect(stale.status).toBe(1);
    expect(stale.stderr.toString()).toContain('target setup changed after capture');
  });
});
