import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUARD_IDS, normalizeSelection } from '../lib/components.mts';
import {
  buildCommitMsgBlock,
  buildCommitMsgHook,
  checkCommitMsgHook,
} from '../lib/husky/commit-msg-block.mts';
import {
  formatGateOrder,
  type GateOrderSelection,
  gateRunOrder,
  type InstallMode,
} from '../lib/husky/gate-policy/gate-order.mts';
import {
  buildGuardBlock,
  buildOverlayHook,
  buildStandaloneBlock,
} from '../lib/husky/husky-block.mts';
import { hookRunnable } from '../lib/husky/husky.mts';
import {
  buildSelfHostBlock,
  SELF_HOST_EXTRAS,
  SELF_HOST_STRUCTURE_CMD,
  selfHostSelection,
} from '../lib/husky/self-host.mts';

// Explicit off-switches: an absent field normalizes to the installer default (structure is on).
const OFF = { antiSlop: false, structure: false, biome: false, fallow: false };

// Recorded with qavis-advisory BEFORE review: the old `block calls:` line printed exactly that.
const FRINK = {
  ...OFF,
  guards: ['size', 'dup', 'decisions', 'qavis-advisory', 'review', 'sentry'],
};
const INSTALLS = ['package', 'standalone', 'overlay', 'self-host'] as const;

describe('gateRunOrder', () => {
  it('orders a package hook by run order, not by the recorded selection order', () => {
    expect(formatGateOrder(gateRunOrder(FRINK, 'package'))).toBe(
      'pre-commit: deterministic(size,dup) → decisions → review [+completeness prewarm on ship] → sentry [ship prewarm] → qavis-advisory · commit-msg: completeness → sentry',
    );
  });

  it('overlay has no prewarms, so sentry judges only at commit-msg — after the advisory', () => {
    expect(gateRunOrder(FRINK, 'overlay')).toEqual({
      preCommit: [
        'deterministic(size,dup)',
        'lint overlay (eslint,biome)',
        'decisions',
        'review',
        'qavis-advisory',
      ],
      commitMsg: ['completeness', 'sentry'],
    });
  });

  it('standalone keeps the sentry prewarm but has no completeness prewarm', () => {
    expect(gateRunOrder(FRINK, 'standalone').preCommit).toEqual([
      'deterministic(size,dup)',
      'decisions',
      'review',
      'sentry [ship prewarm]',
      'qavis-advisory',
    ]);
  });

  it('self-host has no commit-msg segment and always runs structure', () => {
    const order = gateRunOrder(selfHostSelection(), 'self-host');
    expect(order.commitMsg).toEqual([]);
    expect(order.preCommit.find((r) => r.startsWith('deterministic'))).toMatch(
      /^deterministic\(.*structure\)$/,
    );
    expect(formatGateOrder(order)).not.toContain('commit-msg');
  });

  it('sentry without review: prewarm in pre-commit, sentry alone at commit-msg', () => {
    expect(gateRunOrder({ ...OFF, guards: ['sentry'] }, 'package')).toEqual({
      preCommit: ['sentry [ship prewarm]'],
      commitMsg: ['sentry'],
    });
  });

  it('ignores unknown ids and duplicates in a hand-edited or legacy config', () => {
    expect(
      gateRunOrder({ ...OFF, guards: ['review', 'bogus', 'size', 'review', 'size'] }, 'package'),
    ).toEqual({
      preCommit: ['deterministic(size)', 'review [+completeness prewarm on ship]'],
      commitMsg: ['completeness'],
    });
  });

  it('names the deterministic step for anti-slop or structure with no deterministic guard id', () => {
    expect(gateRunOrder({ ...OFF, guards: [], antiSlop: true }, 'package').preCommit).toEqual([
      'deterministic(anti-slop)',
    ]);
    expect(
      gateRunOrder({ ...OFF, structure: true, guards: ['size'] }, 'standalone').preCommit,
    ).toEqual(['deterministic(size,structure)']);
    // Overlay never wires a structure command, so structure alone runs nothing there.
    expect(gateRunOrder({ ...OFF, structure: true, guards: [] }, 'overlay').preCommit).toEqual([
      'lint overlay (eslint,biome)',
    ]);
  });

  it('formats first in a package block, but not in a monorepo package block', () => {
    const sel = { ...OFF, biome: true, guards: ['size'] };
    expect(gateRunOrder(sel, 'package').preCommit).toEqual([
      'format (biome)',
      'deterministic(size)',
    ]);
    expect(gateRunOrder(sel, 'package', 'packages/api').preCommit).toEqual(['deterministic(size)']);
    expect(gateRunOrder(sel, 'standalone').preCommit).toEqual(['deterministic(size)']);
  });

  it('lists the deterministic step in the orchestrator registry order, not selection order', () => {
    expect(
      gateRunOrder({ ...OFF, guards: ['comments', 'size'], antiSlop: true }, 'package').preCommit,
    ).toEqual(['deterministic(size,anti-slop,comments)']);
    // Self-host's --extra commands run after the registry gates and before structure.
    expect(
      gateRunOrder(selfHostSelection(), 'self-host').preCommit.find((r) =>
        r.startsWith('deterministic'),
      ),
    ).toMatch(/,comments,lint,.*structure\)$/);
  });

  it('reports a partial config by the defaults its generated hook runs', () => {
    expect(gateRunOrder({}, 'package')).toEqual(gateRunOrder(normalizeSelection({}), 'package'));
    expect(formatGateOrder(gateRunOrder({}, 'package'))).toMatch(/decisions.*qavis-advisory/);
  });

  it('does not claim a commit-msg order the installed hook may not run', () => {
    expect(formatGateOrder(gateRunOrder(FRINK, 'package'), { commitMsgVerified: false })).toMatch(
      / · commit-msg: not verified \(hook missing or stale\)$/,
    );
    // Nothing selected for commit-msg: no segment, verified or not.
    expect(
      formatGateOrder(gateRunOrder({ ...OFF, guards: ['size'] }, 'package'), {
        commitMsgVerified: false,
      }),
    ).toBe('pre-commit: deterministic(size)');
  });

  it('formats an empty selection as an empty string', () => {
    expect(formatGateOrder(gateRunOrder({ ...OFF, guards: [] }, 'package'))).toBe('');
  });
});

// Drift guard: the printed order must match what each builder actually emits. A builder reorder,
// a dropped prewarm or a new prewarm fails here instead of shipping a doctor line that lies.
const ANCHORS = {
  deterministic: /^\s*__dk_gate_deterministic [^(]/m,
  decisions: /__dk_gate_selected decisions\b/,
  review: /__dk_gate_selected review\b/,
  sentry: /# devkit:guard-sentry-prewarm/,
  'qavis-advisory': /__dk_gate_selected qavis-advisory\b/,
  format: /# devkit:biome-format/,
  'lint overlay': /# devkit lint overlay — STAGED/,
  fallow: /# devkit:fallow-advisory/,
  'skill-projection': /# devkit:self-host-skill-projection-advisory/,
} satisfies Record<string, RegExp>;
const COMPLETENESS_PREWARM = / completeness --gate "\$DEVKIT_COMMIT_MSG_FILE" &/;

// Builder input as each installer builds it; self-host fixes its guards and always seeds
// structure + extras (hook-parity.mts).
const asInstalled = (install: InstallMode, sel: GateOrderSelection): GateOrderSelection =>
  install === 'self-host' ? selfHostSelection(sel) : sel;
function preCommitText(install: InstallMode, recorded: GateOrderSelection): string {
  const sel = normalizeSelection(asInstalled(install, recorded));
  const structureCmd = sel.structure ? 'guard-structure staged' : undefined;
  if (install === 'package') return buildGuardBlock({ ...sel, structureCmd });
  if (install === 'standalone') return buildStandaloneBlock({ ...sel, structureCmd });
  if (install === 'overlay') return buildOverlayHook(sel, undefined, '', { fallow: sel.fallow });
  return buildSelfHostBlock(
    { ...sel, structureCmd: SELF_HOST_STRUCTURE_CMD, extras: SELF_HOST_EXTRAS },
    '',
    process.cwd(),
  );
}

describe('gateRunOrder matches the generated hooks', () => {
  for (const install of INSTALLS) {
    it.each([
      { ...OFF, guards: GUARD_IDS },
      { guards: GUARD_IDS, antiSlop: true, structure: true, biome: true, fallow: true },
    ])(`${install}: pre-commit rows appear in the builder output in order (%o)`, (sel) => {
      const text = preCommitText(install, sel);
      const rows = gateRunOrder(asInstalled(install, sel), install).preCommit;
      const at = rows.map((row) => {
        const anchor = Object.entries(ANCHORS).find(([id]) => row.startsWith(id))?.[1];
        return anchor ? text.search(anchor) : -1;
      });
      expect(
        at.every((i) => i >= 0),
        `${install} rows ${rows.join(', ')} at ${at.join(',')}`,
      ).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      // Every stage the builder emits is named, and none is named that it doesn't emit.
      for (const [id, anchor] of Object.entries(ANCHORS))
        expect(
          rows.some((r) => r.startsWith(id)),
          `${install} ${id}`,
        ).toBe(anchor.test(text));
      expect(rows.includes('sentry [ship prewarm]')).toBe(ANCHORS.sentry.test(text));
      expect(rows.some((r) => r.includes('completeness prewarm'))).toBe(
        COMPLETENESS_PREWARM.test(text),
      );
    });

    it(`${install}: names the deterministic step exactly when the builder emits it`, () => {
      for (const sel of [
        {},
        { ...OFF, guards: [] },
        { ...OFF, guards: [], antiSlop: true },
        { ...OFF, guards: [], structure: true },
        { ...OFF, guards: ['review'] },
      ]) {
        const named = gateRunOrder(asInstalled(install, sel), install).preCommit.some((r) =>
          r.startsWith('deterministic'),
        );
        expect(named, `${install} ${JSON.stringify(sel)}`).toBe(
          ANCHORS.deterministic.test(preCommitText(install, sel)),
        );
      }
    });
  }

  it('commit-msg rows appear in buildCommitMsgBlock in the same order', () => {
    const block = buildCommitMsgBlock({ guards: GUARD_IDS }) ?? '';
    const at = gateRunOrder({ guards: GUARD_IDS }, 'package').commitMsg.map((id) =>
      block.indexOf(`# devkit:guard-${id}\n`),
    );
    expect(at).toHaveLength(2);
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });
});

// Doctor only claims a commit-msg order when this check is OK, so a false DRIFT hides a real order.
describe('checkCommitMsgHook', () => {
  function repoWithHook(guards: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'dk-commit-msg-'));
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    mkdirSync(join(root, '.husky'));
    writeFileSync(join(root, '.husky', 'commit-msg'), buildCommitMsgHook({ guards }));
    return root;
  }

  it('reads a freshly generated hook as OK despite its commit-index capture sentinel', () => {
    expect(
      checkCommitMsgHook(repoWithHook(['review', 'sentry']), ['review', 'sentry']).status,
    ).toBe('OK');
  });

  it('still flags a deselected gate left in the block', () => {
    const r = checkCommitMsgHook(repoWithHook(['review', 'sentry']), ['review']);
    expect(r.status).toBe('DRIFT');
    expect(r.detail).toBe('block contains deselected gate(s): guard-sentry');
  });
});

describe.skipIf(process.platform === 'win32')('hookRunnable', () => {
  it('is true only for an existing file git can execute', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dk-hook-mode-'));
    const hook = join(dir, 'pre-commit');
    expect(hookRunnable(hook)).toBe(false);
    writeFileSync(hook, '#!/bin/sh\n');
    chmodSync(hook, 0o644);
    expect(hookRunnable(hook)).toBe(false);
    chmodSync(hook, 0o755);
    expect(hookRunnable(hook)).toBe(true);
  });

  it('is false for a directory, which git cannot execute as a hook', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dk-hook-dir-'));
    mkdirSync(join(dir, 'pre-commit'), { mode: 0o755 });
    expect(hookRunnable(join(dir, 'pre-commit'))).toBe(false);
  });
});
