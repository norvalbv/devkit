import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A published bin is ALWAYS reached through a symlink shim: `node_modules/.bin/guard-x`, or a global
// install's bin dir. So `process.argv[1]` is the shim path, never the real module path, and a
// run-as-main check written as
//
//   process.argv[1] === fileURLToPath(import.meta.url)          // ❌ shim vs real — always false
//
// silently declines to dispatch: the process parses its args, runs NOTHING, and exits 0. That is
// indistinguishable from "the gate ran and passed", which is why `guard-clone scan --gate` and
// `guard-dup-allowlist <verb>` shipped dead for several releases (fixed in v0.39.0) with nothing
// surfacing it. The e2e counterpart (e2e/bin-shim.e2e.test.mts) proves the shipped bins actually
// dispatch through a real shim; this test is the cheap one — it reads SOURCE, needs no build, and
// reddens in the normal `vitest` run the moment a new module gets a non-realpath guard.
//
// The rule: if a module compares process.argv[1] against import.meta.url at all, argv[1] must be
// realpath'd. A module with NO such comparison is fine — it dispatches unconditionally at module
// scope (cli/index.mts, review/cli.mts, co-occurrence/matcher.mts, …), which is immune by
// construction.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const REALPATHED = /realpathSync\(\s*process\.argv\[1\]\s*\)/;
const FIX = 'use `import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href`';

/** Strip comments so a doc-comment QUOTING the broken form (clone-detector.mts does, deliberately)
 *  is not read as code. Block comments first, then line comments. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Run-as-main comparisons in a module, as source text. Matches both orderings:
 *   `import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href`
 *   `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`
 * Bounded to a single statement (no `;` or newline crossed) so one match is one comparison.
 */
function runAsMainComparisons(src: string): string[] {
  const code = stripComments(src);
  return [
    ...code.matchAll(/import\.meta\.url\s*===\s*[^;\n]*?process\.argv\[1\][^;\n]*/g),
    ...code.matchAll(/process\.argv\[1\][^;\n]*?===\s*[^;\n]*import\.meta\.url[^;\n]*/g),
  ].map((m) => m[0]);
}

/** The comparisons in this module that do NOT realpath argv[1]. Empty = compliant (including the
 *  common case of a module with no run-as-main comparison at all). */
function nonRealpathGuards(src: string): string[] {
  return runAsMainComparisons(src).filter((expr) => !REALPATHED.test(expr));
}

/** `./dist/gate-engine/x/y.mjs` → `gate-engine/x/y.mts` — the source the build emits it from. */
function binSourceRel(target: string): string {
  return target
    .replace(/^\.\//, '')
    .replace(/^dist\//, '')
    .replace(/\.mjs$/, '.mts');
}

/** Every .mts under gate-engine/ and cli/, minus eval benches and test files. */
function listSources(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === 'eval' || e.name === '__tests__' || e.name === 'node_modules') continue;
        walk(`${rel}/${e.name}`);
      } else if (e.name.endsWith('.mts')) {
        out.push(`${rel}/${e.name}`);
      }
    }
  };
  walk('gate-engine');
  walk('cli');
  return out;
}

const BIN: Record<string, string> = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
).bin;

describe('every published bin dispatches through its shim', () => {
  it('package.json declares bins (guards against an empty-loop pass)', () => {
    expect(Object.keys(BIN).length).toBeGreaterThan(10);
  });

  for (const [bin, target] of Object.entries(BIN)) {
    const rel = binSourceRel(target);

    it(`${bin} → ${rel} exists`, () => {
      expect(
        existsSync(join(REPO_ROOT, rel)),
        `${bin} points at ${target}, but there is no source at ${rel}`,
      ).toBe(true);
    });

    it(`${bin} realpaths process.argv[1] in its run-as-main guard`, () => {
      const bad = nonRealpathGuards(readFileSync(join(REPO_ROOT, rel), 'utf8'));
      expect(
        bad,
        `${bin} (${rel}) has a run-as-main guard that does not realpath argv[1], so it exits 0 ` +
          `WITHOUT DISPATCHING when invoked as \`${bin}\` through its bin shim — ${FIX}`,
      ).toEqual([]);
    });
  }
});

// The bins are what ship, but the class is wider: `guard-decisions` rewrites argv[1] and imports a
// sub-engine (decisions/cli.mts:40), so a SUB-engine's own guard decides whether the verb runs.
// Sweep every non-eval gate/CLI module rather than only the 15 entry points.
//
// eval/** is exempt: dev-only benches invoked as `node <real path>`, never published, and two of
// them still use the raw form.
describe('no non-realpath run-as-main guard anywhere in gate-engine/ or cli/', () => {
  const files = listSources();

  it('finds sources to check (guards against an empty-loop pass)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('every guard realpaths argv[1]', () => {
    const offenders = files
      .filter((rel) => nonRealpathGuards(readFileSync(join(REPO_ROOT, rel), 'utf8')).length > 0)
      .sort();
    expect(offenders, `non-realpath run-as-main guard(s) — ${FIX}`).toEqual([]);
  });
});

describe('runAsMainComparisons', () => {
  it('finds the guard in both orderings', () => {
    expect(
      runAsMainComparisons(
        'if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {',
      ),
    ).toHaveLength(1);
    expect(
      runAsMainComparisons(
        'const m = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);',
      ),
    ).toHaveLength(1);
  });

  it('ignores the broken form when it appears inside a comment', () => {
    expect(
      runAsMainComparisons(
        '// argv[1] === fileURLToPath(import.meta.url) compares the SHIM path, so it is false.\n',
      ),
    ).toEqual([]);
    expect(
      runAsMainComparisons(
        '/**\n * `process.argv[1] === fileURLToPath(import.meta.url)` is the bug.\n */\n',
      ),
    ).toEqual([]);
  });

  it('flags the raw form and clears the realpathed one', () => {
    expect(
      nonRealpathGuards('if (import.meta.url === pathToFileURL(process.argv[1]).href) main();'),
    ).toHaveLength(1);
    expect(
      nonRealpathGuards(
        'if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();',
      ),
    ).toEqual([]);
  });
});
