import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDecision, renderTarget } from '../decision-format.mts';
import { cmdCategories, groupByCategory } from '../recall/category-report.mts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'category-report-'));
  process.env.GUARD_DECISIONS_DIR = dir;
});
afterEach(() => {
  delete process.env.GUARD_DECISIONS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

// Minimal Target field set: only `ruling` and `category` vary per axis.
const target = (o: { ruling: string; category?: string }) => ({
  context: 'c',
  ruling: o.ruling,
  consequences: 'v',
  tradeoff: 't',
  visionFit: 'f',
  category: o.category,
});

function writeAxis(slug: string, o: { ruling: string; category?: string }) {
  const body = `\n# ${slug}\n\n${renderTarget('2026-07-26', target(o))}\n`;
  writeFileSync(join(dir, `${slug}.md`), renderDecision({ slug, created: '2026-07-26' }, body));
}

describe('groupByCategory (pure)', () => {
  it('groups axes by category, in the frozen list order', () => {
    const { groups, uncategorised } = groupByCategory([
      { slug: 'a', ruling: 'ra', category: 'ship-pipeline' },
      { slug: 'b', ruling: 'rb', category: 'decision-log' },
      { slug: 'c', ruling: 'rc', category: 'decision-log' },
    ]);
    // decision-log sorts before ship-pipeline in CATEGORIES, regardless of input order.
    expect(groups.map((g) => g.category)).toEqual(['decision-log', 'ship-pipeline']);
    expect(groups[0].axes.map((a) => a.slug)).toEqual(['b', 'c']);
    expect(groups[1].axes.map((a) => a.slug)).toEqual(['a']);
    expect(uncategorised).toEqual([]);
  });

  it('reports axes with no category separately, never folded into a guessed bucket', () => {
    const { groups, uncategorised } = groupByCategory([
      { slug: 'a', ruling: 'ra', category: 'commit-gates' },
      { slug: 'b', ruling: 'rb', category: null },
    ]);
    expect(groups).toHaveLength(1);
    expect(uncategorised).toEqual([{ slug: 'b', ruling: 'rb' }]);
  });
});

describe('cmdCategories (integration)', () => {
  it('prints "No decisions recorded." for an empty log and never throws', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => cmdCategories(dir)).not.toThrow();
    expect(log).toHaveBeenCalledWith('No decisions recorded.');
    log.mockRestore();
  });

  it('groups recorded axes by category and lists uncategorised ones separately', () => {
    writeAxis('gate-a', { ruling: 'gate-a rules', category: 'commit-gates' });
    writeAxis('gate-b', { ruling: 'gate-b rules', category: 'commit-gates' });
    writeAxis('log-a', { ruling: 'log-a rules', category: 'decision-log' });
    writeAxis('no-cat', { ruling: 'no-cat rules' }); // Category omitted entirely

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdCategories(dir);
    const out = log.mock.calls.map((c) => c[0]).join('\n');
    log.mockRestore();

    expect(out).toContain('# decision-log (1)');
    expect(out).toContain('- log-a · log-a rules');
    expect(out).toContain('# commit-gates (2)');
    expect(out).toContain('- gate-a · gate-a rules');
    expect(out).toContain('- gate-b · gate-b rules');
    expect(out).toContain('# uncategorised (1)');
    expect(out).toContain('- no-cat · no-cat rules');
    // decision-log precedes commit-gates in the frozen list, so its section must print first.
    expect(out.indexOf('# decision-log')).toBeLessThan(out.indexOf('# commit-gates'));
  });

  it('truncates a long ruling in the printed line', () => {
    const long = 'x'.repeat(150);
    writeAxis('long-one', { ruling: long, category: 'benchmarking' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdCategories(dir);
    const out = log.mock.calls.map((c) => c[0]).join('\n');
    log.mockRestore();
    expect(out).not.toContain(long);
    expect(out).toContain(`${'x'.repeat(99)}…`);
  });
});
