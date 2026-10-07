/**
 * A doc that names a `guard-<bin> <sub> --gate` call reads as "this runs at commit". Each one is
 * therefore either emitted by the generated hook, or listed here as on-demand.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUARD_IDS } from '../lib/components.mts';
import { buildCommitMsgBlock } from '../lib/husky/commit-msg-block.mts';
import { buildGuardBlock } from '../lib/husky/husky-block.mts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Documented gates no generated hook runs; the docs naming them say so. */
const ON_DEMAND = ['guard-decisions check-alignment --gate'];

const GATE_CALL_RE = /guard-[a-z-]+(?: [a-z-]+)? --gate/g;
const WHITESPACE_RE = /\s+/g;

/** Both generated hooks, every guard selected; quotes dropped so `"$dir/guard-x" y` reads as a call. */
const BLOCK = [
  buildGuardBlock({ guards: GUARD_IDS }),
  buildCommitMsgBlock({ guards: GUARD_IDS }) ?? '',
]
  .join('\n')
  .replaceAll('"', '');

/** Every gate call in `text`, tolerant of a call wrapped across lines. */
function gateCalls(text: string): string[] {
  return [...new Set(text.replace(WHITESPACE_RE, ' ').match(GATE_CALL_RE) ?? [])];
}

/** The source docs an agent reads, not the `.claude` / `.cursor` projections of them. */
function sourceDocs(): string[] {
  const skills = readdirSync(join(ROOT, 'skills'))
    .map((dir) => `skills/${dir}/SKILL.md`)
    .filter((rel) => existsSync(join(ROOT, rel)));
  const agents = readdirSync(join(ROOT, 'agents'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => `agents/${file}`);
  return ['AGENTS.md', 'CLAUDE.md', 'docs/troubleshooting.md', ...skills, ...agents];
}

/** The gate calls in `text` that `block` does not run and that are not declared on-demand. */
function unbackedCalls(text: string, block: string): string[] {
  return gateCalls(text).filter((call) => !block.includes(call) && !ON_DEMAND.includes(call));
}

describe('gate calls named in the docs', () => {
  it('finds a call wrapped across a line break', () => {
    expect(gateCalls('run `guard-x\n  y --gate` then `guard-x y --gate`')).toEqual([
      'guard-x y --gate',
    ]);
  });

  // A gate with no subcommand (`guard-review --gate`) is the shape real consumer hooks carry.
  it('finds a call that has no subcommand', () => {
    expect(gateCalls('then `guard-review --gate` runs')).toEqual(['guard-review --gate']);
  });

  it('reports a call the hook does not run, and clears one it does', () => {
    const text =
      'guard-decisions detect --gate, guard-decisions check-alignment --gate, guard-x y --gate';
    expect(unbackedCalls(text, BLOCK)).toEqual(['guard-x y --gate']);
  });

  it('are emitted by the generated hook, or listed as on-demand', () => {
    // A listed doc that is missing or unreadable throws here rather than reading as claim-free.
    const docs = sourceDocs().map((rel) => [rel, readFileSync(join(ROOT, rel), 'utf8')] as const);
    expect(docs.flatMap(([, text]) => gateCalls(text))).toContain('guard-decisions detect --gate');
    const unbacked = docs.flatMap(([rel, text]) =>
      unbackedCalls(text, BLOCK).map((call) => `${rel}: ${call}`),
    );
    expect(unbacked).toEqual([]);
  });

  it('keeps the on-demand list honest: the hook really does not run those', () => {
    expect(ON_DEMAND.filter((call) => BLOCK.includes(call))).toEqual([]);
  });
});
