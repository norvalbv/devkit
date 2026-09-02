import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENT_BUDGET } from '../../judge/odb-probe.mts';
import { emptyInventory } from '../inventory.mts';
import { commentBudgetEvent, emitCommentBudget } from '../telemetry.mts';
import type { CommentFinding, CommentInventory } from '../types.mts';

const finding = (index: number): CommentFinding => ({
  id: index.toString(16).padStart(12, '0'),
  path: `gate-engine/some/deeply/nested/module-${index}.mts`,
  extension: 'mts',
  adapterVersion: 'typescript-scanner-v2',
  kind: 'line',
  startLine: index * 10,
  endLine: index * 10 + 3,
  comment: '// a\n// b\n// c\n// d',
  context: 'const x = 1;',
  relevantDiff: '@@ -1 +1,4 @@',
  anchor: (index * 7).toString(16).padStart(12, 'a'),
  textLines: 4,
});

const inventory = (touched: number): CommentInventory => ({
  files: 3,
  paragraphs: { one: 4, two: 2, over: touched },
  trailingAdded: 5,
  decisionsStaged: true,
  touched: Array.from({ length: touched }, (_, index) => ({
    anchor: finding(index).anchor,
    textLines: 4,
  })),
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('commentBudgetEvent', () => {
  it('carries the paragraph shape, the findings, and the touched anchors', () => {
    const event = commentBudgetEvent('block', inventory(2), [finding(0), finding(1)]);
    expect(event).toMatchObject({
      type: 'comment_budget',
      gate: 'comments',
      status: 'block',
      files: 3,
      paragraphs: { one: 4, two: 2, over: 2 },
      trailing_added: 5,
      decisions_staged: true,
    });
    expect(event.findings).toEqual([
      {
        id: '000000000000',
        path: finding(0).path,
        start: 0,
        end: 3,
        text_lines: 4,
        anchor: finding(0).anchor,
      },
      {
        id: '000000000001',
        path: finding(1).path,
        start: 10,
        end: 13,
        text_lines: 4,
        anchor: finding(1).anchor,
      },
    ]);
    expect(event.touched).toHaveLength(2);
    expect('omitted' in event).toBe(false);
  });

  it('shrinks under the atomic-append budget, dropping touched anchors before findings', () => {
    const findings = Array.from({ length: 200 }, (_, index) => finding(index));
    const event = commentBudgetEvent('block', inventory(200), findings);
    expect(Buffer.byteLength(JSON.stringify(event), 'utf8')).toBeLessThanOrEqual(
      EVENT_BUDGET - 320,
    );
    expect(event.findings.length).toBeGreaterThan(0);
    expect(event.touched).toHaveLength(0);
    expect(event.omitted).toEqual({ findings: 200 - event.findings.length, touched: 200 });
    expect(event.paragraphs).toEqual({ one: 4, two: 2, over: 200 });
  });

  it('never omits findings when the touched list alone was over budget', () => {
    const event = commentBudgetEvent('block', inventory(120), [finding(0)]);
    expect(event.findings).toHaveLength(1);
    expect(event.omitted).toMatchObject({ findings: 0 });
  });
});

describe('emitCommentBudget', () => {
  it('appends one enveloped JSON line to the configured sink', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'comment-budget-'));
    const sink = path.join(dir, 'events.jsonl');
    vi.stubEnv('DEVKIT_GATE_EVENTS', sink);
    vi.stubEnv('DEVKIT_SHIP_ID', 'ship-1');
    emitCommentBudget('pass', emptyInventory(), []);
    const lines = readFileSync(sink, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      type: 'comment_budget',
      status: 'pass',
      ship_id: 'ship-1',
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
