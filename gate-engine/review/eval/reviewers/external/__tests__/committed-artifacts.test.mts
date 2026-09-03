/** docs/benchmarks/external/** is public: refuse any artifact carrying a path, finding text, or
 * per-finding row (scale-track-third-party-data) — assertCountsOnly re-applied at test time. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertCountsOnly, type LensHoleReport, PATH_LIKE_RE } from '../holes.mts';

const ROOT = path.resolve(import.meta.dirname, '../../../../../../docs/benchmarks/external');

function jsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsonFiles(full));
    else if (entry.endsWith('.json')) out.push(full);
  }
  return out;
}

/** Public PR URLs are allowed (stripped before the scan); any bare repo-relative source path is not. */
const PRIVATE = /\/Users\/|\.devkit\/research|benord-labs/i;

describe('docs/benchmarks/external committed artifacts', () => {
  const files = jsonFiles(ROOT);
  it('has at least the CodeRabbit cross-tab tables', () => {
    expect(files.some((f) => f.includes('coderabbit-devkit-lens-holes'))).toBe(true);
  });
  for (const file of files) {
    it(`${path.relative(ROOT, file)} carries counts and names only`, () => {
      const text = readFileSync(file, 'utf8');
      // SAFETY: every artifact here is written by external/*.mts — a report, or a summary wrapping one.
      const parsed = JSON.parse(text) as LensHoleReport | { lensHoles: LensHoleReport };
      const report = 'lensHoles' in parsed ? parsed.lensHoles : parsed;
      expect(() => assertCountsOnly(report)).not.toThrow();
      const pathHit = text.replace(/https?:\/\/\S+/g, '').match(PATH_LIKE_RE);
      expect(pathHit, `path-like token ${pathHit?.[0] ?? ''}`).toBeNull();
      const privateHit = text.match(PRIVATE);
      expect(privateHit, `private marker ${privateHit?.[0] ?? ''}`).toBeNull();
    });
  }
});
