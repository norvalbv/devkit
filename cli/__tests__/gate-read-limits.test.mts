/**
 * The decisions skill's "What the gates read" table tells authors each gate's limit so they need
 * no code trace. This pins the brief, detect and reviewer limits to the constants that enforce them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DETECT_TARGETS_BYTES,
  REVIEWER_TARGETS_BYTES,
} from '../../gate-engine/review/evidence/targets-block.mts';

// The hook is read, not run, so declare the edge that makes `vitest related` select this file.
void (() => import('../../agents-hooks/decision-scope-brief.mjs'));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = readFileSync(join(ROOT, 'agents-hooks/decision-scope-brief.mjs'), 'utf8');
const SKILL = readFileSync(join(ROOT, 'skills/decisions/SKILL.md'), 'utf8');

/** The integer a `const NAME = 1_234;` line in `source` assigns; throws when there is none. */
function constValue(source: string, name: string): number {
  const match = new RegExp(`\\bconst ${name} = ([\\d_]+);`).exec(source);
  if (!match) throw new Error(`no \`const ${name} = <integer>;\``);
  return Number(match[1].replaceAll('_', ''));
}

/** Every integer in a table cell, with `4,096`-style separators dropped. */
function numbers(cell: string): number[] {
  return [...cell.replaceAll(',', '').matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/** The Limit cell of the named consumer's row; throws when the section or row is missing. */
function limitCell(markdown: string, consumer: string): string {
  const section = markdown.split('## What the gates read')[1]?.split('\n## ')[0] ?? '';
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells[1] === consumer) return cells[3];
  }
  throw new Error(`no "${consumer}" row in "What the gates read"`);
}

describe('the "What the gates read" limits', () => {
  it('reads a separated number from a row, and throws on a missing row or constant', () => {
    const doc =
      '## What the gates read\n| Consumer | Sees | Limit |\n| A | x | 4,096-byte block |\n';
    expect(numbers(limitCell(doc, 'A'))).toEqual([4096]);
    expect(() => limitCell(doc, 'B')).toThrow('no "B" row');
    expect(constValue('const N = 2_000;', 'N')).toBe(2000);
    expect(() => constValue('const N = cap;', 'N')).toThrow('const N');
  });

  it('states the pre-edit brief caps the hook enforces', () => {
    expect(numbers(limitCell(SKILL, 'Pre-edit brief'))).toEqual([
      constValue(HOOK, 'MAX_AXES'),
      constValue(HOOK, 'RULING_CHARS'),
    ]);
  });

  it('states the detect and domain-reviewer Target block caps', () => {
    expect(numbers(limitCell(SKILL, 'Decision judge (`detect`)'))).toEqual([DETECT_TARGETS_BYTES]);
    expect(numbers(limitCell(SKILL, 'Domain reviewers'))).toEqual([REVIEWER_TARGETS_BYTES]);
  });
});
