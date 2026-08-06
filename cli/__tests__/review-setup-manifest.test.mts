import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeSelection, structureCmdFor } from '../lib/components.mts';
import { buildOverlayHook, buildStandaloneHook } from '../lib/husky/husky-block.mts';
import { globalInitPath, installGlobalHook } from '../lib/overlay-global-hook.mts';
import {
  captureReviewSetup,
  type ReviewSetupManifest,
  verifyReviewSetup,
} from '../lib/ship/review/setup-manifest.mts';
import { reviewSetupFixtures } from './review-setup-fixture.mts';

const { git, mkTmp, selection, write } = reviewSetupFixtures();
const SETUP_MANIFEST_CLI = fileURLToPath(
  new URL('../lib/ship/review/setup-manifest.mts', import.meta.url),
);

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [SETUP_MANIFEST_CLI, ...args], { encoding: 'utf8' });
}

function config(overlay: boolean, overrides: Record<string, unknown> = {}) {
  return {
    stack: 'generic',
    standalone: !overlay,
    overlay,
    ...(overlay ? { origHooksPath: '.git/hooks' } : {}),
    components: selection,
    review: {
      enabled: true,
      guards: ['decisions'],
      decisionsDir: 'docs/decisions',
    },
    ...overrides,
  };
}

function setup(name: string, overlay = false) {
  const parent = mkTmp(`devkit-review-setup-${name}-`);
  const root = join(parent, 'target');
  mkdirSync(root);
  git(root, 'init', '-q');
  if (!overlay) {
    write(root, '.husky/_/pre-commit', '#!/bin/sh\nexec sh "$(dirname "$0")/h" "$@"\n', true);
    write(root, '.husky/_/h', '#!/bin/sh\n"$s" "$@"\n');
  }
  const chain = join(root, '.git/hooks/pre-commit');
  if (overlay) writeFileSync(chain, '#!/bin/sh\necho chained\n', { mode: 0o755 });
  const hook = overlay
    ? buildOverlayHook(selection, '.git/hooks/pre-commit')
    : buildStandaloneHook(selection);
  write(root, overlay ? '.devkit/hooks/pre-commit' : '.husky/pre-commit', hook, true);
  write(root, '.devkit/config.json', `${JSON.stringify(config(overlay), null, 2)}\n`);
  git(root, 'config', 'core.hooksPath', overlay ? '.devkit/hooks' : '.husky/_');
  return { parent, root, manifest: join(parent, 'setup.json') };
}

// husky 9.1.7's real `_/h`, verbatim in the part that matters: it builds the XDG init.sh path and
// sources it. The acceptance predicate greps for that, so a fixture that paraphrases it proves
// nothing about the arrangement devkit is agreeing to trust.
const HUSKY_RUNNER_H =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell ${VAR:-default}, not a JS template
  '#!/usr/bin/env sh\ni="${XDG_CONFIG_HOME:-$HOME/.config}/husky/init.sh"\n[ -f "$i" ] && . "$i"\n';

function pathRecord(manifest: ReviewSetupManifest, id: string) {
  return manifest.setup.paths.find((entry) => entry.id === id);
}

function resignManifest(value: Record<string, unknown>): void {
  const { selfHash: _selfHash, ...unsigned } = value;
  value.selfHash = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
}

describe('review setup manifest', () => {
  it('exposes capture and verify through the direct CLI', () => {
    const { root, manifest } = setup('direct-cli');

    const captured = runCli('capture', root, manifest);
    expect(captured.status, captured.stderr).toBe(0);
    expect(readFileSync(manifest, 'utf8')).toContain('"version"');

    const verified = runCli('verify', root, manifest);
    expect(verified.status, verified.stderr).toBe(0);

    writeFileSync(join(root, '.devkit/config.json'), '{}\n');
    const changed = runCli('verify', root, manifest);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain('devkit review:');
  });

  it('rejects malformed direct CLI invocations with usage guidance', () => {
    const result = runCli('capture');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'usage: setup-manifest capture <target-root> <manifest> | verify <target-root> <manifest>',
    );
  });

  it('captures and verifies a clean standalone setup without requiring a diff', () => {
    const { root, manifest } = setup('standalone');
    write(root, '.devkit/correctness-overrides.json', '{"allow":[]}\n');
    write(root, '.devkit/biome/base.jsonc', '{}\n');
    write(root, '.devkit/tsconfig/base.json', '{}\n');

    const captured = captureReviewSetup(root, manifest);

    expect(captured.setup).toMatchObject({
      overlay: false,
      hooksPath: '.husky/_',
      chain: null,
      profile: { enabled: true, guards: ['decisions'], decisionsDir: 'docs/decisions' },
    });
    expect(pathRecord(captured, 'effective-hook')?.relativePath).toBe('.husky/pre-commit');
    expect(pathRecord(captured, 'correctness-overrides')?.fingerprint).not.toBe('absent');
    expect(pathRecord(captured, 'biome-runtime')?.fingerprint).not.toBe('absent');
    expect(pathRecord(captured, 'tsconfig-runtime')?.fingerprint).not.toBe('absent');
    expect(verifyReviewSetup(root, manifest)).toEqual(captured);
  });

  it('freezes package-local config and Git-root hooks separately in a monorepo install', () => {
    const parent = mkTmp('devkit-review-setup-monorepo-');
    const gitRoot = join(parent, 'repo');
    const targetRoot = join(gitRoot, 'packages', 'app');
    mkdirSync(targetRoot, { recursive: true });
    git(gitRoot, 'init', '-q');
    write(gitRoot, '.husky/_/pre-commit', '#!/bin/sh\nexit 0\n', true);
    write(gitRoot, '.husky/_/h', '#!/bin/sh\nexit 0\n');
    write(gitRoot, '.husky/pre-commit', buildStandaloneHook(selection, 'packages/app'), true);
    write(
      targetRoot,
      '.devkit/config.json',
      `${JSON.stringify(config(false, { pkgRel: 'packages/app' }), null, 2)}\n`,
    );
    git(gitRoot, 'config', 'core.hooksPath', '.husky/_');
    const manifest = join(parent, 'setup.json');

    const captured = captureReviewSetup(targetRoot, manifest);

    expect(captured.targetRoot).toBe(realpathSync(targetRoot));
    expect(captured.gitRoot).toBe(realpathSync(gitRoot));
    expect(pathRecord(captured, 'config')?.root).toBe('target');
    expect(pathRecord(captured, 'runner-pre-commit')?.root).toBe('git');
    expect(pathRecord(captured, 'effective-hook')?.root).toBe('git');
    expect(verifyReviewSetup(targetRoot, manifest)).toEqual(captured);
    expect(() => captureReviewSetup(targetRoot, join(gitRoot, 'outside-package.json'))).toThrow(
      /manifest must live outside the target checkout/,
    );
  });

  it('preserves legacy component inference when components are absent or partial', () => {
    const legacy = setup('legacy-components');
    const legacyConfig = config(false) as Record<string, unknown>;
    delete legacyConfig.components;
    writeFileSync(
      join(legacy.root, '.husky/pre-commit'),
      buildStandaloneHook({ ...normalizeSelection(), structureCmd: structureCmdFor('generic') }),
      { mode: 0o755 },
    );
    writeFileSync(
      join(legacy.root, '.devkit/config.json'),
      `${JSON.stringify(legacyConfig, null, 2)}\n`,
    );
    expect(captureReviewSetup(legacy.root, legacy.manifest).setup.profile.guards).toEqual([
      'decisions',
    ]);

    const partial = setup('partial-components');
    const selected = {
      ...normalizeSelection({ guards: ['decisions'] }),
      structureCmd: structureCmdFor('generic'),
    };
    writeFileSync(join(partial.root, '.husky/pre-commit'), buildStandaloneHook(selected), {
      mode: 0o755,
    });
    writeFileSync(
      join(partial.root, '.devkit/config.json'),
      `${JSON.stringify(config(false, { components: { guards: ['decisions'] } }), null, 2)}\n`,
    );
    expect(captureReviewSetup(partial.root, partial.manifest).setup.profile.guards).toEqual([
      'decisions',
    ]);
  });

  it('canonicalizes harmless decision-directory syntax accepted by existing installs', () => {
    const { root, manifest } = setup('decision-directory-syntax');
    writeFileSync(
      join(root, '.devkit/config.json'),
      `${JSON.stringify(config(false, { review: { enabled: true, guards: [], decisionsDir: './docs/decisions/' } }), null, 2)}\n`,
    );

    expect(captureReviewSetup(root, manifest).setup.profile.decisionsDir).toBe('docs/decisions');
  });

  it('records the exact overlay hook and complete original chain source directory', () => {
    const { root, manifest } = setup('overlay', true);

    const captured = captureReviewSetup(root, manifest);

    expect(captured.setup.overlay).toBe(true);
    expect(captured.setup.hooksPath).toBe('.devkit/hooks');
    expect(captured.setup.chain).toEqual({
      path: '.git/hooks/pre-commit',
      sourcePath: '.git/hooks',
    });
    expect(pathRecord(captured, 'effective-hook')?.relativePath).toBe('.devkit/hooks/pre-commit');
    expect(pathRecord(captured, 'overlay-chain')?.fingerprint).not.toBe('absent');
    expect(pathRecord(captured, 'overlay-chain-source')?.fingerprint).not.toBe('absent');
    expect(verifyReviewSetup(root, manifest)).toEqual(captured);
  });

  it('does not freeze an unrelated hook directory when the configured chain is absent', () => {
    const { root, manifest } = setup('overlay-without-chain', true);
    rmSync(join(root, '.git/hooks/pre-commit'));
    writeFileSync(join(root, '.devkit/hooks/pre-commit'), buildOverlayHook(selection, ''), {
      mode: 0o755,
    });

    const captured = captureReviewSetup(root, manifest);

    expect(pathRecord(captured, 'overlay-chain')?.fingerprint).toBe('absent');
    expect(pathRecord(captured, 'overlay-chain-source')).toBeUndefined();
    writeFileSync(join(root, '.git/hooks/unrelated-helper'), 'unrelated\n');
    expect(verifyReviewSetup(root, manifest)).toEqual(captured);
  });

  it('fails closed with the doctor remedy for missing, drifted, or ineffective hooks', () => {
    const missing = setup('missing');
    rmSync(join(missing.root, '.husky/_/pre-commit'));
    expect(() => captureReviewSetup(missing.root, missing.manifest)).toThrow(
      /missing \.husky\/_\/pre-commit.*doctor --fix/,
    );

    const drifted = setup('drifted');
    writeFileSync(join(drifted.root, '.husky/pre-commit'), '#!/bin/sh\nexit 0\n');
    expect(() => captureReviewSetup(drifted.root, drifted.manifest)).toThrow(
      /gate block differs.*doctor --fix/,
    );

    const ineffective = setup('ineffective');
    git(ineffective.root, 'config', 'core.hooksPath', '.git/hooks');
    expect(() => captureReviewSetup(ineffective.root, ineffective.manifest)).toThrow(
      /core\.hooksPath.*expected \.husky\/_.*doctor --fix/,
    );
  });

  it('freezes every target-controlled Husky runner dependency', () => {
    const { parent, root, manifest } = setup('husky-runner-dependency');
    const projectedRunner = join(parent, 'projected-husky-runner');
    mkdirSync(projectedRunner);
    write(projectedRunner, 'pre-commit', '#!/bin/sh\nexit 0\n', true);
    write(projectedRunner, 'h', '#!/bin/sh\nexit 0\n');
    write(projectedRunner, 'helper', 'before\n');
    rmSync(join(root, '.husky/_'), { recursive: true });
    symlinkSync(projectedRunner, join(root, '.husky/_'));
    expect(() => captureReviewSetup(root, join(projectedRunner, 'setup.json'))).toThrow(
      /manifest must live outside every frozen setup source/,
    );
    const captured = captureReviewSetup(root, manifest);

    expect(pathRecord(captured, 'runner-source')?.fingerprint).not.toBe('absent');
    writeFileSync(join(projectedRunner, 'helper'), 'after\n');
    expect(() => verifyReviewSetup(root, manifest)).toThrow(/changed after capture/);
  });

  it.each([
    ['non-object review', { review: [] }, /review must be a JSON object/],
    ['disabled review', { review: { enabled: false } }, /disabled by/],
    [
      'uninstalled guard',
      { review: { enabled: true, guards: ['review'] } },
      /unknown or uninstalled guards: review/,
    ],
    [
      'unknown installed guard',
      { components: { ...selection, guards: ['bogus'] } },
      /components\.guards contains unknown guards: bogus/,
    ],
    [
      'empty decisions directory',
      { review: { enabled: true, guards: [], decisionsDir: '  ' } },
      /decisionsDir must not be empty/,
    ],
    [
      'escaping decisions directory',
      { review: { enabled: true, guards: [], decisionsDir: '../shared-decisions' } },
      /decisionsDir must be repository-relative/,
    ],
  ])('rejects malformed config: %s', (_name, override, expected) => {
    const { root, manifest } = setup('malformed');
    writeFileSync(
      join(root, '.devkit/config.json'),
      `${JSON.stringify(config(false, override), null, 2)}\n`,
    );

    expect(() => captureReviewSetup(root, manifest)).toThrow(expected);
  });

  it('detects setup mutation both during capture and after the manifest is written', () => {
    const during = setup('during');
    expect(() =>
      captureReviewSetup(during.root, during.manifest, {
        afterFirstCapture: () =>
          write(during.root, '.devkit/correctness-overrides.json', '{"changed":true}\n'),
      }),
    ).toThrow(/changed during validation/);

    const after = setup('after', true);
    captureReviewSetup(after.root, after.manifest);
    writeFileSync(join(after.root, '.git/hooks/sibling-helper'), 'new sibling\n');
    expect(() => verifyReviewSetup(after.root, after.manifest)).toThrow(/changed after capture/);
  });

  it('ignores inherited repository-local Git variables and restores the caller environment', () => {
    const { root, manifest } = setup('git-environment');
    const poison = join(root, 'not-the-repository');
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = poison;
    try {
      expect(captureReviewSetup(root, manifest).setup.hooksPath).toBe('.husky/_');
      expect(process.env.GIT_DIR).toBe(poison);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it('rejects non-NUL git config output instead of truncating the hooks path', () => {
    const { parent, root, manifest } = setup('malformed-git-output');
    const bin = join(parent, 'bin');
    write(bin, 'git', '#!/bin/sh\nprintf .husky/_\n', true);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ''}`;
    try {
      expect(() => captureReviewSetup(root, manifest)).toThrow(/malformed output.*doctor --fix/);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });

  it('rejects an escaping overlay chain before generator validation', () => {
    const { root, manifest } = setup('escape', true);
    const cfg = config(true, { origHooksPath: '../outside-hooks' });
    writeFileSync(join(root, '.devkit/config.json'), `${JSON.stringify(cfg, null, 2)}\n`);

    expect(() => captureReviewSetup(root, manifest)).toThrow(/chain escapes the target repository/);

    const unsupported = setup('unsupported-chain', true);
    writeFileSync(
      join(unsupported.root, '.devkit/config.json'),
      `${JSON.stringify(config(true, { origHooksPath: '.hooks\\legacy' }), null, 2)}\n`,
    );
    expect(() => captureReviewSetup(unsupported.root, unsupported.manifest)).toThrow(
      /chain is not a safe repository-relative path/,
    );
  });

  it('rejects a repository-root overlay chain whose helper dependencies cannot be isolated', () => {
    const { root, manifest } = setup('root-chain', true);
    rmSync(join(root, '.git/hooks/pre-commit'));
    write(root, 'pre-commit', '#!/bin/sh\necho root chain\n', true);
    writeFileSync(
      join(root, '.devkit/hooks/pre-commit'),
      buildOverlayHook(selection, './pre-commit'),
      { mode: 0o755 },
    );
    writeFileSync(
      join(root, '.devkit/config.json'),
      `${JSON.stringify(config(true, { origHooksPath: '.' }), null, 2)}\n`,
    );

    expect(() => captureReviewSetup(root, manifest)).toThrow(
      /root-level overlay pre-commit chains are not supported/,
    );
  });

  it('handles target paths containing spaces and newlines without line parsing', () => {
    const base = mkTmp('devkit-review-setup-paths-');
    const root = join(base, 'target with space\nand newline');
    mkdirSync(root);
    git(root, 'init', '-q');
    write(root, '.husky/_/pre-commit', '#!/bin/sh\nexit 0\n', true);
    write(root, '.husky/_/h', '#!/bin/sh\nexit 0\n');
    write(root, '.husky/pre-commit', buildStandaloneHook(selection), true);
    write(root, '.devkit/config.json', `${JSON.stringify(config(false), null, 2)}\n`);
    git(root, 'config', 'core.hooksPath', '.husky/_');
    const manifest = join(base, 'manifest with space\nand newline.json');

    const captured = captureReviewSetup(root, manifest);

    expect(captured.targetRoot).toBe(realpathSync(root));
    expect(verifyReviewSetup(root, manifest)).toEqual(captured);
  });

  it('requires the manifest outside the target and rejects a tampered self-hash', () => {
    const { root, manifest } = setup('manifest-boundary');
    expect(() => captureReviewSetup(root, join(root, '.devkit/setup.json'))).toThrow(
      /manifest must live outside/,
    );

    captureReviewSetup(root, manifest);
    const tampered = JSON.parse(readFileSync(manifest, 'utf8'));
    tampered.setup.hooksPath = '.git/hooks';
    writeFileSync(manifest, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(() => verifyReviewSetup(root, manifest)).toThrow(/self-hash does not match/);
  });

  it('rejects a malformed nested manifest even when its self-hash is recomputed', () => {
    const { root, manifest } = setup('nested-manifest');
    captureReviewSetup(root, manifest);
    const malformed = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    const setupValue = malformed.setup as Record<string, unknown>;
    const profile = setupValue.profile as Record<string, unknown>;
    profile.guards = ['decisions', 'decisions'];
    resignManifest(malformed);
    writeFileSync(manifest, `${JSON.stringify(malformed, null, 2)}\n`);

    expect(() => verifyReviewSetup(root, manifest)).toThrow(/profile has invalid guards/);
  });
});

// husky's committed `prepare` resets core.hooksPath to `.husky/_` on EVERY install, un-wiring the
// overlay's `.devkit/hooks` pointer. Commits stay gated when the opt-in `~/.config/husky/init.sh`
// shim is installed — husky's own `_/h` sources it before running the committed hook — so review
// must accept that arrangement instead of failing on the literal. It is accepted only on proof:
// every link of that chain has to be intact, or a genuinely ungated repo would pass review.
describe('review setup manifest — husky-reclaimed overlay hooksPath', () => {
  const origXdg = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
  });

  /**
   * An overlay repo AFTER husky reclaimed core.hooksPath: the overlay hook is still installed and
   * chains to the committed `.husky/pre-commit`, but git now runs husky's `.husky/_` runner.
   * `shim: false` sandboxes XDG at an empty dir, so the global block is genuinely absent.
   */
  function reclaimed(name: string, { shim = true } = {}) {
    const parent = mkTmp(`devkit-review-reclaimed-${name}-`);
    process.env.XDG_CONFIG_HOME = join(parent, 'xdg');
    if (shim) installGlobalHook();
    const root = join(parent, 'target');
    mkdirSync(root);
    git(root, 'init', '-q');
    // husky 9.1.7's real runner shape: `_/h` sources the XDG init.sh, `_/<hook>` sources `_/h`.
    write(root, '.husky/_/h', HUSKY_RUNNER_H);
    write(root, '.husky/_/pre-commit', '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n', true);
    write(root, '.husky/pre-commit', '#!/bin/sh\necho team hook\n', true);
    write(root, '.devkit/hooks/pre-commit', buildOverlayHook(selection, '.husky/pre-commit'), true);
    write(
      root,
      '.devkit/config.json',
      `${JSON.stringify(config(true, { origHooksPath: '.husky/_' }), null, 2)}\n`,
    );
    git(root, 'config', 'core.hooksPath', '.husky/_');
    return { parent, root, manifest: join(parent, 'setup.json') };
  }

  it('accepts the reclaimed path and still freezes the canonical .devkit/hooks', () => {
    const { root, manifest } = reclaimed('accepted');

    const captured = captureReviewSetup(root, manifest);

    // Canonical, NOT the live `.husky/_`: review-target.sh hardcodes `.devkit/hooks` for its gate
    // run, and freezing the transient value would let a concurrent `git ci` abort a live review.
    expect(captured.setup.hooksPath).toBe('.devkit/hooks');
    expect(captured.setup.overlay).toBe(true);
    expect(captured.setup.chain).toEqual({ path: '.husky/pre-commit', sourcePath: '.husky' });
    expect(verifyReviewSetup(root, manifest)).toEqual(captured);
  });

  it('rejects the reclaimed path when the global shim is absent, naming the resolved init.sh', () => {
    const { root, manifest } = reclaimed('no-shim', { shim: false });

    expect(() => captureReviewSetup(root, manifest)).toThrow(
      new RegExp(`no devkit block in ${globalInitPath().replaceAll('.', '\\.')}`),
    );
    expect(() => captureReviewSetup(root, manifest)).toThrow(/--global-commit-gate/);
  });

  it('rejects a shim whose hook invocation is commented out but still present', () => {
    // Both markers intact and the hook path still in the text, so any substring test passes — yet
    // husky runs nothing. The block is compared verbatim against the generator for exactly this.
    const { root, manifest } = reclaimed('commented-shim');
    const initSh = globalInitPath();
    const disabled = readFileSync(initSh, 'utf8').replace(
      /^(\s*)(DEVKIT_VIA_HUSKY_INIT=1 sh )/m,
      '$1# $2',
    );
    expect(disabled).toContain('.devkit/hooks/pre-commit'); // the path survives the edit
    expect(disabled).toContain('<<< devkit overlay global pre-commit gate <<<'); // markers intact
    writeFileSync(initSh, disabled);

    expect(() => captureReviewSetup(root, manifest)).toThrow(/no devkit block in/);
  });

  it('rejects a shim block truncated after its start marker', () => {
    const { root, manifest } = reclaimed('truncated-shim');
    const initSh = globalInitPath();
    const truncated = readFileSync(initSh, 'utf8').split('\n').slice(0, 2).join('\n');
    expect(truncated).toContain('>>> devkit overlay global pre-commit gate >>>');
    writeFileSync(initSh, `${truncated}\n`);

    expect(() => captureReviewSetup(root, manifest)).toThrow(/no devkit block in/);
  });

  it('rejects the reclaimed path when no committed .husky/pre-commit exists', () => {
    // husky's `_/h` runs `[ ! -f "$s" ] && exit 0` BEFORE sourcing init.sh, so with no committed
    // hook the shim never fires at all and every commit is silently ungated.
    const { root, manifest } = reclaimed('no-committed-hook');
    rmSync(join(root, '.husky/pre-commit'));
    writeFileSync(join(root, '.devkit/hooks/pre-commit'), buildOverlayHook(selection, ''), {
      mode: 0o755,
    });

    expect(() => captureReviewSetup(root, manifest)).toThrow(
      /husky's runner would never reach it|exits before sourcing the shim/,
    );
  });

  it('rejects a runner that only MENTIONS init.sh without sourcing it', () => {
    // husky's own `_/h` prints a deprecation notice for `~/.huskyrc` that embeds the literal
    // `~/.config/husky/init.sh`. A runner stripped of its `. "$i"` line but still carrying that
    // echo satisfies a substring test while never reaching the shim — presence is not proof.
    const { root, manifest } = reclaimed('mentions-only');
    write(
      root,
      '.husky/_/h',
      '#!/usr/bin/env sh\nif [ -f "$HOME/.huskyrc" ]; then\n\techo "husky - DEPRECATED, move your code to ~/.config/husky/init.sh"\nfi\n',
    );

    expect(() => captureReviewSetup(root, manifest)).toThrow(/never sources husky\/init\.sh/);
  });

  it('accepts a runner that sources init.sh from an indented if-block', () => {
    // Valid shell that genuinely sources: the dot-source sits at a line start WITH indentation,
    // not after a `;`/`&&`. Rejecting it would hard-fail a repo that IS gated — the false-reject
    // mirror of the echo/comment traps, and just as much a defect.
    const { root, manifest } = reclaimed('indented-source');
    write(
      root,
      '.husky/_/h',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell ${VAR:-default}, not a JS template
      '#!/usr/bin/env sh\ni="${XDG_CONFIG_HOME:-$HOME/.config}/husky/init.sh"\nif [ -f "$i" ]; then\n  . "$i"\nfi\n',
    );

    expect(captureReviewSetup(root, manifest).setup.hooksPath).toBe('.devkit/hooks');
  });

  it('rejects a runner whose source line is commented out', () => {
    // A comment still supplies the `;` a source-command pattern keys on, so a disabled line reads
    // as an active one unless comments are stripped first. Same trap as the echo, different shape.
    const { root, manifest } = reclaimed('commented-source');
    write(
      root,
      '.husky/_/h',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell ${VAR:-default}, not a JS template
      '#!/usr/bin/env sh\ni="${XDG_CONFIG_HOME:-$HOME/.config}/husky/init.sh"\n# disabled; . "$i"\n',
    );

    expect(() => captureReviewSetup(root, manifest)).toThrow(/never sources husky\/init\.sh/);
  });

  it('rejects a stub whose source of the runner is commented out', () => {
    const { root, manifest } = reclaimed('commented-stub');
    write(root, '.husky/_/pre-commit', '#!/usr/bin/env sh\n# . "$(dirname "$0")/h"\n', true);

    expect(() => captureReviewSetup(root, manifest)).toThrow(
      /pre-commit never sources \.husky\/_\/h/,
    );
  });

  it('rejects a runner that cannot reach the shim', () => {
    const { root, manifest } = reclaimed('broken-runner');
    write(root, '.husky/_/h', '#!/usr/bin/env sh\nexit 0\n');

    expect(() => captureReviewSetup(root, manifest)).toThrow(/never sources husky\/init\.sh/);

    write(root, '.husky/_/h', HUSKY_RUNNER_H);
    chmodSync(join(root, '.husky/_/pre-commit'), 0o644);
    expect(() => captureReviewSetup(root, manifest)).toThrow(
      /\.husky\/_\/pre-commit is not executable/,
    );
  });

  it('rejects a reclaimed overlay whose chain does not resolve through .husky', () => {
    // An overlay installed BEFORE husky records origHooksPath '' and chains to .git/hooks — husky's
    // runner would never execute that, so review must not vouch for a chain it never ran.
    const { root, manifest } = reclaimed('foreign-chain');
    writeFileSync(join(root, '.git/hooks/pre-commit'), '#!/bin/sh\necho chained\n', {
      mode: 0o755,
    });
    write(
      root,
      '.devkit/hooks/pre-commit',
      buildOverlayHook(selection, '.git/hooks/pre-commit'),
      true,
    );
    write(
      root,
      '.devkit/config.json',
      `${JSON.stringify(config(true, { origHooksPath: '' }), null, 2)}\n`,
    );

    expect(() => captureReviewSetup(root, manifest)).toThrow(/chains to \.git\/hooks, not \.husky/);
  });

  it('still rejects an overlay hooksPath that is neither the overlay nor husky runner', () => {
    const { root, manifest } = reclaimed('foreign-path');
    git(root, 'config', 'core.hooksPath', '.githooks');

    expect(() => captureReviewSetup(root, manifest)).toThrow(
      /core\.hooksPath is "\.githooks", expected \.devkit\/hooks/,
    );
  });
});
