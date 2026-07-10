/**
 * The per-file line-growth block enabler (gate-engine/ratchets/size-disable.mts): the maxLines knob +
 * its grandfather freeze. The load-bearing property is anti-laundering — enabling the cap on an
 * adopted repo grandfathers current giants into size-lines.json WITHOUT re-snapshotting the
 * disable-count baseline (size.json).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  enableLineGrowth,
  hasLineCap,
  LINE_CAP,
  previewGrandfather,
  setMaxLines,
} from '../../gate-engine/ratchets/size-disable.mts';
import { defaultSelection } from '../lib/components.mts';

let roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'linegrowth-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

const writeConfig = (root: string, cfg: object) =>
  writeFileSync(join(root, 'guard.config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
const big = (n: number) => Array(n).fill('const x = 1;').join('\n'); // n lines, no trailing newline
const writeSrc = (root: string, rel: string, content: string) => {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', rel), content);
};

describe('line-growth block enabler', () => {
  it('defaultSelection enables the block (recommended-on)', () => {
    expect(defaultSelection().lineGrowth).toBe(true);
  });

  it('setMaxLines writes the cap + doc when absent; preserves a tuned value', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'] });
    expect(setMaxLines(root)).toBe(true);
    let cfg = JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8'));
    expect(cfg.maxLines).toBe(LINE_CAP);
    expect(cfg['//maxLines']).toBeTypeOf('string');
    // Idempotent — a second call preserves the value and reports "no write".
    expect(setMaxLines(root)).toBe(false);
    // A consumer's tuned cap is never clobbered.
    writeConfig(root, { scanRoots: ['src'], maxLines: 800 });
    expect(setMaxLines(root)).toBe(false);
    cfg = JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8'));
    expect(cfg.maxLines).toBe(800);
  });

  it('setMaxLines is a no-op when guard.config.json is absent (no guards/structure)', () => {
    const root = makeRoot();
    expect(setMaxLines(root)).toBe(false);
    expect(existsSync(join(root, 'guard.config.json'))).toBe(false);
  });

  it('hasLineCap reflects a positive maxLines only', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'] });
    expect(hasLineCap(root)).toBe(false); // absent
    writeConfig(root, { scanRoots: ['src'], maxLines: 0 });
    expect(hasLineCap(root)).toBe(false); // 0 = off
    writeConfig(root, { scanRoots: ['src'], maxLines: 500 });
    expect(hasLineCap(root)).toBe(true);
  });

  it('enableLineGrowth sets the cap, grandfathers giants, and NEVER touches size.json', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'] }); // no cap yet
    writeSrc(root, 'giant.ts', big(600));
    writeSrc(root, 'small.ts', big(10));
    // A pre-existing disable-count baseline (adopted long ago) that must survive byte-for-byte.
    mkdirSync(join(root, 'eslint', 'baselines'), { recursive: true });
    const sizeJson = join(root, 'eslint', 'baselines', 'size.json');
    writeFileSync(sizeJson, JSON.stringify({ fileDisables: 2, fnDisables: 0 }));
    const sizeBefore = readFileSync(sizeJson, 'utf8');

    const { grandfathered } = enableLineGrowth(root);

    expect(grandfathered).toBe(1);
    expect(hasLineCap(root)).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'guard.config.json'), 'utf8')).maxLines).toBe(
      LINE_CAP,
    );
    const lines = JSON.parse(
      readFileSync(join(root, 'eslint', 'baselines', 'size-lines.json'), 'utf8'),
    );
    expect(lines).toEqual({ maxLines: LINE_CAP, files: { 'src/giant.ts': 600 } });
    // The anti-laundering property: the disable-count baseline is untouched.
    expect(readFileSync(sizeJson, 'utf8')).toBe(sizeBefore);
  });

  it('previewGrandfather counts over-cap files without writing anything', () => {
    const root = makeRoot();
    writeConfig(root, { scanRoots: ['src'], sourceExtensions: ['ts'] });
    writeSrc(root, 'a.ts', big(600));
    writeSrc(root, 'b.ts', big(10));
    expect(previewGrandfather(root)).toBe(1);
    expect(hasLineCap(root)).toBe(false); // preview wrote nothing
  });
});
