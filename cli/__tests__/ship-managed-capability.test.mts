import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ANTI_SLOP_MANIFEST_REL, ANTI_SLOP_RULE_IDS } from '../lib/install/anti-slop/constants.mts';
import { antiSlopCapabilityIssue } from '../lib/install/anti-slop/lifecycle.mts';
import { oxcBaseCapabilityIssue } from '../lib/install/oxc/lifecycle.mts';
import { testExecFileSync as execFileSync, testSpawnSync as spawnSync } from './_helpers.mts';

// sc-2099: a ship worktree is cut from $BASE, so its committed .devkit/oxc + .devkit/anti-slop bytes
// are the branch's FORK POINT, while the gates judging them come from the caller's linked
// node_modules. prepare_gate_worktree therefore refreshes that managed state from the RUNNING package
// — in the WORKING TREE only, so the shipped commit still carries exactly the briefed paths.

const prepareGateWorktreeScript = fileURLToPath(
  new URL('../lib/ship/prepare-gate-worktree.sh', import.meta.url),
);
const GENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const STALE_DIGEST = '0'.repeat(64);
// Consumer-owned root config: devkit never rewrites it, so the fixture must already extend the base.
const EXTENDING_OXLINTRC = `${JSON.stringify(
  { extends: ['./.devkit/oxc/oxlint.base.json'], jsPlugins: [], overrides: [], rules: {} },
  null,
  2,
)}\n`;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function runManagedRefresh(worktree: string, root: string) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      ['source "$1"', 'refresh_ship_managed_capability "$2" "$3" shipping'].join('\n'),
      'refresh-managed-capability',
      prepareGateWorktreeScript,
      worktree,
      root,
    ],
    { encoding: 'utf8', env: { ...process.env, ...GENV } },
  );
}

function staleOxcManifest(antiSlop: boolean): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      pins: { oxlint: '0.0.0', oxfmt: '0.0.0' },
      antiSlop,
      baseDigest: STALE_DIGEST,
      configs: {
        oxlint: { path: '.oxlintrc.json', createdDigest: null },
        oxfmt: { path: '.oxfmtrc.json', createdDigest: null },
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * A repo whose HEAD carries fork-point managed state, plus a detached worktree cut from it — the exact
 * shape `git worktree add --detach "$WT" "$BASE"` produces inside ship/reship.
 */
function seedForkPointRepo(
  seed: (dir: string) => void,
  antiSlop = false,
  wtPrefix = 'managed-cap-wt-',
) {
  const root = mkdtempSync(join(tmpdir(), 'managed-cap-root-'));
  dirs.push(root);
  const env = { ...process.env, ...GENV };
  const git = (args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', root], { env });
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  mkdirSync(join(root, '.devkit'), { recursive: true });
  writeFileSync(
    join(root, '.devkit/config.json'),
    `${JSON.stringify({ components: { antiSlop } })}\n`,
  );
  seed(root);
  writeFileSync(join(root, 'note.txt'), 'hi\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fork point']);

  const wt = join(mkdtempSync(join(tmpdir(), wtPrefix)), 'wt');
  dirs.push(join(wt, '..'));
  git(['worktree', 'add', '-q', '--detach', wt, 'HEAD']);
  const wtGit = (args: string[]) =>
    execFileSync('git', ['-C', wt, ...args], { env, encoding: 'utf8' }).trim();
  return { git: wtGit, root, wt };
}

/** The devkit-managed paths the refresh writes; none may ever reach the index or the commit. */
const MANAGED = ['.devkit/oxc/manifest.json', '.devkit/oxc/oxlint.base.json'];

describe('ship managed capability refresh', () => {
  it('clears a stale fork-point base digest without touching the index or the commit', () => {
    const { git, root, wt } = seedForkPointRepo((dir) => {
      mkdirSync(join(dir, '.devkit/oxc'), { recursive: true });
      writeFileSync(join(dir, '.devkit/oxc/manifest.json'), staleOxcManifest(false));
      writeFileSync(join(dir, '.devkit/oxc/oxlint.base.json'), '{"stale":true}\n');
      writeFileSync(join(dir, '.oxlintrc.json'), EXTENDING_OXLINTRC);
    });
    expect(oxcBaseCapabilityIssue(wt)).toBe('managed Oxlint base manifest digest is stale');

    writeFileSync(join(wt, 'note.txt'), 'shipped\n');
    git(['add', '--', 'note.txt']);
    const stagedBefore = git(['diff', '--cached', '--name-only']);

    const res = runManagedRefresh(wt, root);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('refreshed managed capability state');

    expect(oxcBaseCapabilityIssue(wt)).toBeNull();
    expect(git(['diff', '--cached', '--name-only'])).toBe(stagedBefore);
    for (const rel of MANAGED) expect(stagedBefore).not.toContain(rel);

    git(['commit', '-q', '--no-verify', '-m', 'ship']);
    const committed = git(['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
    expect(committed).toEqual(['note.txt']);
  });

  it('clears an incomplete fork-point anti-slop rule registry', () => {
    const { root, wt } = seedForkPointRepo((dir) => {
      mkdirSync(join(dir, '.devkit/anti-slop'), { recursive: true });
      writeFileSync(
        join(dir, ANTI_SLOP_MANIFEST_REL),
        `${JSON.stringify({ ruleIds: ANTI_SLOP_RULE_IDS.slice(1) })}\n`,
      );
      writeFileSync(join(dir, '.oxlintrc.json'), EXTENDING_OXLINTRC);
    }, true);
    expect(antiSlopCapabilityIssue(wt)).not.toBeNull();

    const res = runManagedRefresh(wt, root);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('.devkit/anti-slop/**');
    expect(antiSlopCapabilityIssue(wt)).toBeNull();
  });

  it('installs managed state on a branch that predates the Oxc cutover entirely', () => {
    const { git, root, wt } = seedForkPointRepo(() => {});
    expect(existsSync(join(wt, '.devkit/oxc'))).toBe(false);

    expect(runManagedRefresh(wt, root).status).toBe(0);

    expect(oxcBaseCapabilityIssue(wt)).toBeNull();
    // ownershipFor writes the .oxlintrc.json starter when no root config exists — worktree only.
    expect(existsSync(join(wt, '.oxlintrc.json'))).toBe(true);
    expect(git(['diff', '--cached', '--name-only'])).toBe('');
    expect(git(['ls-files', '--', '.devkit/oxc', '.oxlintrc.json'])).toBe('');
  });

  it('no-ops in overlay mode rather than writing through the linked .devkit', () => {
    const { root, wt } = seedForkPointRepo((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), EXTENDING_OXLINTRC);
    });
    rmSync(join(wt, '.devkit'), { force: true, recursive: true });
    symlinkSync(join(root, '.devkit'), join(wt, '.devkit'));
    const callerBefore = readFileSync(join(root, '.devkit/config.json'), 'utf8');

    const res = runManagedRefresh(wt, root);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('overlay mode links .devkit from the caller');

    expect(lstatSync(join(wt, '.devkit')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, '.devkit/oxc'))).toBe(false);
    expect(readFileSync(join(root, '.devkit/config.json'), 'utf8')).toBe(callerBefore);
  });

  it('refuses to refresh the caller checkout itself', () => {
    const { root } = seedForkPointRepo(() => {});
    const res = runManagedRefresh(root, root);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('refusing to refresh managed capability state in the caller');
    expect(existsSync(join(root, '.devkit/oxc'))).toBe(false);
  });
});

// ─── Wiring ────────────────────────────────────────────────────────────────────────────────────────
// Each half is unit-covered above; these pin the CONTROL FLOW between them. `prepare_gate_worktree`
// dispatches four purposes (shipping · "tag validation" · review · review-baseline) and its own exit
// status is what ship/reship trust under `set -e`, so both the branch and the status must be exact.

/** A worktree + root that satisfy prepare_gate_worktree's real preflights (deps + an executable hook). */
function seedPreparablePair() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'managed-cap-wire-')));
  dirs.push(base);
  const root = join(base, 'root');
  const wt = join(base, 'wt');
  for (const dir of [root, wt]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  mkdirSync(join(root, 'coverage'), { recursive: true });
  mkdirSync(join(root, '.husky/_'), { recursive: true });
  writeFileSync(join(root, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { root, wt };
}

/**
 * Run the real prepare_gate_worktree with both refresh halves replaced by markers. `set -euo pipefail`
 * matches every real caller, so a predicate answering "no" must not abort the shell.
 */
function prepareWithStubs(
  wt: string,
  root: string,
  purpose: string,
  reviewerExit = 0,
  managedExit = 0,
) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      [
        'set -euo pipefail',
        '. "$1"',
        'reviewer_exit=$5 managed_exit=$6',
        'refresh_ship_reviewer_assets() { echo "REVIEWER"; return "$reviewer_exit"; }',
        'refresh_ship_managed_capability() { echo "MANAGED"; return "$managed_exit"; }',
        'set +e; prepare_gate_worktree "$2" "$3" "$4"; echo "RETURNED=$?"',
      ].join('\n'),
      'prepare-wiring',
      prepareGateWorktreeScript,
      wt,
      root,
      purpose,
      String(reviewerExit),
      String(managedExit),
    ],
    { encoding: 'utf8', env: { ...process.env, ...GENV } },
  );
}

describe('prepare_gate_worktree — managed capability wiring', () => {
  it('refreshes managed capability state for a ship, after the reviewer assets', () => {
    const { root, wt } = seedPreparablePair();
    const res = prepareWithStubs(wt, root, 'shipping');
    expect(res.stdout).toContain('MANAGED');
    expect(res.stdout.indexOf('REVIEWER')).toBeLessThan(res.stdout.indexOf('MANAGED'));
    expect(res.stdout).toContain('RETURNED=0');
  });

  it('leaves the tag-validation worktree minimal — no reviewer or managed refresh', () => {
    const { root, wt } = seedPreparablePair();
    const res = prepareWithStubs(wt, root, 'tag validation');
    expect(res.stdout).toContain('RETURNED=0');
    expect(res.stdout).not.toContain('MANAGED');
    expect(res.stdout).not.toContain('REVIEWER');
  });

  it('keeps the reviewer refresh FAIL-CLOSED — the managed call cannot swallow its failure', () => {
    // Before sc-2099 the reviewer call was this function's LAST statement, so its status WAS the
    // function's. Appending a second, always-succeeding call would have silently cleared it.
    const { root, wt } = seedPreparablePair();
    const res = prepareWithStubs(wt, root, 'shipping', 1, 0);
    expect(res.stdout).toContain('RETURNED=1');
    expect(res.stdout).not.toContain('MANAGED');
  });

  it('keeps the managed refresh ADVISORY — its failure never aborts the ship', () => {
    const { root, wt } = seedPreparablePair();
    const res = prepareWithStubs(wt, root, 'shipping', 0, 1);
    // The stub returns 1 directly. The callee already swallows a helper failure, and the call site
    // repeats `|| true`, so a managed-refresh failure can never abort the ship under the caller's
    // `set -e` — while the reviewer half above stays fail-closed.
    expect(res.stdout).toContain('REVIEWER');
    expect(res.stdout).toContain('MANAGED');
    expect(res.stdout).toContain('RETURNED=0');
  });
});

describe('ship managed capability refresh — degraded environments', () => {
  it('continues the ship when neither the .mts nor the .mjs helper is present', () => {
    const { root, wt } = seedForkPointRepo(() => {});
    // The lookup is `${BASH_SOURCE[0]}`-relative and resolves inside the FUNCTION, so it cannot be
    // faked from the caller: copy the script somewhere with no sibling helper — a truncated install.
    const lone = mkdtempSync(join(tmpdir(), 'managed-cap-lone-'));
    dirs.push(lone);
    const copy = join(lone, 'prepare-gate-worktree.sh');
    writeFileSync(copy, readFileSync(prepareGateWorktreeScript, 'utf8'));

    const res = spawnSync(
      '/bin/bash',
      [
        '-c',
        [
          'set -euo pipefail',
          '. "$1"',
          'set +e; refresh_ship_managed_capability "$2" "$3" shipping; echo "RETURNED=$?"',
        ].join('\n'),
        'managed-missing-helper',
        copy,
        wt,
        root,
      ],
      { encoding: 'utf8', env: { ...process.env, ...GENV } },
    );
    expect(res.stderr).toContain('managed capability runtime helper unavailable');
    expect(res.stdout).toContain('RETURNED=0');
    expect(existsSync(join(wt, '.devkit/oxc'))).toBe(false);
  });

  it('swallows a helper that exits non-zero rather than aborting the ship', () => {
    const { wt } = seedForkPointRepo(() => {});
    // `node <helper> project` with no root is argv misuse → exit 1. The ship must survive it.
    const res = spawnSync(
      '/bin/bash',
      [
        '-c',
        ['set -euo pipefail', '. "$1"', 'refresh_ship_managed_capability "$2" "" shipping'].join(
          '\n',
        ),
        'managed-helper-fails',
        prepareGateWorktreeScript,
        wt,
      ],
      { encoding: 'utf8', env: { ...process.env, ...GENV } },
    );
    expect(res.status).toBe(0);
  });
});

describe('ship managed capability refresh — selection and path shapes', () => {
  it('falls back to the on-disk probe when .devkit/config.json is unparseable', () => {
    const { root, wt } = seedForkPointRepo((dir) => {
      mkdirSync(join(dir, '.devkit/oxc'), { recursive: true });
      writeFileSync(join(dir, '.devkit/oxc/manifest.json'), staleOxcManifest(false));
      writeFileSync(join(dir, '.devkit/oxc/oxlint.base.json'), '{"stale":true}\n');
      writeFileSync(join(dir, '.oxlintrc.json'), EXTENDING_OXLINTRC);
    });
    // A hand-edited config must not throw the refresh — and must not abort the ship either.
    writeFileSync(join(root, '.devkit/config.json'), '{ not json');

    const res = runManagedRefresh(wt, root);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('refreshed managed capability state');
    expect(oxcBaseCapabilityIssue(wt)).toBeNull();
  });

  it('honours a recorded antiSlop:false even when the branch committed anti-slop bytes', () => {
    const { root, wt } = seedForkPointRepo((dir) => {
      mkdirSync(join(dir, '.devkit/anti-slop'), { recursive: true });
      writeFileSync(join(dir, ANTI_SLOP_MANIFEST_REL), `${JSON.stringify({ ruleIds: [] })}\n`);
      writeFileSync(join(dir, '.devkit/anti-slop/oxlint.json'), '{}\n');
      writeFileSync(join(dir, '.oxlintrc.json'), EXTENDING_OXLINTRC);
    });

    const res = runManagedRefresh(wt, root);
    expect(res.status).toBe(0);
    // The RECORDED selection wins over the stale on-disk bytes: an oxc-only sync, and the base it
    // writes must not extend the deselected anti-slop config.
    expect(res.stderr).not.toContain('.devkit/anti-slop/**');
    expect(oxcBaseCapabilityIssue(wt)).toBeNull();
    expect(readFileSync(join(wt, '.devkit/oxc/oxlint.base.json'), 'utf8')).not.toContain(
      'anti-slop/oxlint.json',
    );
  });

  it('handles a worktree path containing a space', () => {
    const { git, root, wt } = seedForkPointRepo(
      (dir) => {
        mkdirSync(join(dir, '.devkit/oxc'), { recursive: true });
        writeFileSync(join(dir, '.devkit/oxc/manifest.json'), staleOxcManifest(false));
        writeFileSync(join(dir, '.devkit/oxc/oxlint.base.json'), '{"stale":true}\n');
        writeFileSync(join(dir, '.oxlintrc.json'), EXTENDING_OXLINTRC);
      },
      false,
      'managed cap spaced-',
    );
    expect(wt).toContain(' ');

    expect(runManagedRefresh(wt, root).status).toBe(0);
    expect(oxcBaseCapabilityIssue(wt)).toBeNull();
    expect(git(['diff', '--cached', '--name-only'])).toBe('');
  });

  it('refuses the caller checkout even when it is reached through a symlink alias', () => {
    // macOS routinely hands out aliased paths (/tmp → /private/tmp, /var → /private/var), so a plain
    // string compare would wave the caller checkout through and make the refresh a user-visible write.
    const { root } = seedForkPointRepo(() => {});
    const alias = `${root}-alias`;
    symlinkSync(root, alias);
    dirs.push(alias);

    const res = runManagedRefresh(alias, root);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('refusing to refresh managed capability state in the caller');
    expect(existsSync(join(root, '.devkit/oxc'))).toBe(false);
  });

  it('runs two concurrent refreshes from one caller checkout without corrupting either', () => {
    // Frink drives multiple panes against a single checkout, so two ships can prepare their own
    // worktrees at once. The managed sync locks per-WORKTREE, so neither may block or clobber.
    const seed = (dir: string) => {
      mkdirSync(join(dir, '.devkit/oxc'), { recursive: true });
      writeFileSync(join(dir, '.devkit/oxc/manifest.json'), staleOxcManifest(false));
      writeFileSync(join(dir, '.devkit/oxc/oxlint.base.json'), '{"stale":true}\n');
      writeFileSync(join(dir, '.oxlintrc.json'), EXTENDING_OXLINTRC);
    };
    const { git, root, wt } = seedForkPointRepo(seed);
    const second = join(mkdtempSync(join(tmpdir(), 'managed-cap-wt2-')), 'wt');
    git(['worktree', 'add', '-q', '--detach', second, 'HEAD']);

    const res = spawnSync(
      '/bin/bash',
      [
        '-c',
        [
          'set -euo pipefail',
          '. "$1"',
          'refresh_ship_managed_capability "$2" "$4" shipping & p1=$!',
          'refresh_ship_managed_capability "$3" "$4" shipping & p2=$!',
          'wait $p1 && wait $p2',
        ].join('\n'),
        'managed-concurrent',
        prepareGateWorktreeScript,
        wt,
        second,
        root,
      ],
      { encoding: 'utf8', env: { ...process.env, ...GENV } },
    );
    expect(res.status).toBe(0);
    expect(oxcBaseCapabilityIssue(wt)).toBeNull();
    expect(oxcBaseCapabilityIssue(second)).toBeNull();
    // Neither run may leak a write into the shared caller checkout.
    expect(readFileSync(join(root, '.devkit/oxc/oxlint.base.json'), 'utf8')).toBe(
      '{"stale":true}\n',
    );
  });
});
