import { describe, expect, it } from 'vitest';
import { strayGateCalls } from '../lib/doctor/stray-gate-calls.mts';

// A repo that hand-rolled its gates before devkit absorbed them keeps the old lines below the
// managed block, so every commit runs each gate twice — two model bills for the LLM judges, while
// .devkit/config.json still describes one run. This finds those, and (just as importantly) does not
// cry wolf about lines that only look like calls.

const hook = (
  below: string,
  inBlock = 'bunx guard-decisions detect --gate\nbunx guard-review --gate',
) =>
  ['#!/bin/bash', '# >>> devkit-guards >>>', inBlock, '# <<< devkit-guards <<<', below].join('\n');

describe('strayGateCalls', () => {
  it('reports a gate invoked outside the block that the block also runs', () => {
    const found = strayGateCalls(hook('guard-review --gate || rrc=$?'));
    expect(found).toHaveLength(1);
    // Signature is bin + SUBCOMMAND; `--gate` is a flag, so it stops at the bin.
    expect(found[0].bin).toBe('guard-review');
    expect(found[0].line).toBe(6); // shebang, open marker, 2 block lines, close marker, then this
  });

  it('ignores calls INSIDE the managed block — that is where they belong', () => {
    expect(strayGateCalls(hook('echo done'))).toHaveLength(0);
  });

  it('ignores a subcommand the block does not run', () => {
    // devkit emits `guard-decisions detect`; it ships no fragment for check-alignment, so this is
    // the consumer's ONLY invocation. Flagging it would advise deleting a live gate.
    expect(strayGateCalls(hook('guard-decisions check-alignment --gate'))).toHaveLength(0);
  });

  it('still catches the duplicated subcommand alongside a non-duplicated one', () => {
    const found = strayGateCalls(
      hook('guard-decisions check-alignment --gate\nguard-decisions detect --gate'),
    );
    expect(found.map((f) => f.bin)).toEqual(['guard-decisions detect']);
  });

  it('ignores bins named inside echo/printf remedy strings', () => {
    // A remedy line naturally names the very bin it tells you to run.
    const below = 'echo "   run: guard-review --gate to retry"\nprintf "guard-decisions detect\\n"';
    expect(strayGateCalls(hook(below))).toHaveLength(0);
  });

  it('ignores comments', () => {
    expect(strayGateCalls(hook('# guard-review --gate runs in the block above'))).toHaveLength(0);
  });

  it('returns nothing when the hook has no managed block (nothing to duplicate)', () => {
    expect(strayGateCalls('#!/bin/bash\nguard-review --gate\n')).toHaveLength(0);
  });

  // A monorepo hook holds one block per package. A sibling's block is devkit-written and valid, so
  // reporting it would tell the consumer to delete devkit's own output.
  it('does not report a SIBLING package block in a monorepo hook', () => {
    const monorepo = [
      '#!/bin/bash',
      '# >>> devkit-guards: services/api >>>',
      'bunx guard-deterministic --hook "$0" || exit 1',
      '# <<< devkit-guards: services/api <<<',
      '# >>> devkit-guards: services/web >>>',
      'bunx guard-deterministic --hook "$0" || exit 1',
      '# <<< devkit-guards: services/web <<<',
    ].join('\n');
    expect(strayGateCalls(monorepo, 'services/web')).toHaveLength(0);
  });

  // guard-deterministic is an orchestrator: the block never names the gates it runs, so matching on
  // literal block text alone could never flag a stray copy of one of them.
  it('reports a stray sub-gate that guard-deterministic already orchestrates', () => {
    const found = strayGateCalls(
      hook('guard-dup scan --new --changed --gate', 'bunx guard-deterministic --hook "$0"'),
    );
    expect(found.map((f) => f.bin)).toEqual(['guard-dup scan']);
  });

  it('reports EVERY gate on a chained line, not just the first', () => {
    const found = strayGateCalls(
      hook(
        'guard-dup scan ; guard-review --gate',
        'bunx guard-deterministic --hook "$0"\nbunx guard-review --gate',
      ),
    );
    expect(found.map((f) => f.bin)).toEqual(['guard-dup scan', 'guard-review']);
  });

  // A guarded call spans two lines: `if command -v X; then` / `  X --check`. Only the second runs
  // the gate — counting the probe double-reports and points at a line that invokes nothing.
  it('ignores a `command -v` existence probe, but still reports the guarded call', () => {
    const below = [
      'if command -v guard-dup >/dev/null 2>&1; then',
      '    guard-dup scan --gate || true',
      'fi',
    ].join('\n');
    const found = strayGateCalls(hook(below, 'bunx guard-deterministic --hook "$0"'));
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(6); // the invocation, not the probe on line 5
  });

  it('catches the real call when a probe and the invocation share ONE line', () => {
    // Same bin twice on one line: tracking only its first occurrence filters the whole bin away as
    // "just a probe" and misses the duplicate.
    const found = strayGateCalls(
      hook('command -v guard-dup && guard-dup scan --gate', 'bunx guard-deterministic --hook "$0"'),
    );
    expect(found.map((f) => f.bin)).toEqual(['guard-dup scan']);
  });

  it('does not read guard-dup-allowlist as a guard-dup call', () => {
    const found = strayGateCalls(
      hook('guard-dup-allowlist add a b c d', 'bunx guard-deterministic --hook "$0"'),
    );
    expect(found).toHaveLength(0);
  });

  it('ignores a bin named in a NON-leading echo, or an inline comment', () => {
    // A bin name is far more often mentioned than run — in a remedy message or a trailing note.
    const below = [
      '[ -n "$V" ] && echo "next up: guard-review --gate"',
      'true  # guard-review runs in the block above',
    ].join('\n');
    expect(strayGateCalls(hook(below))).toHaveLength(0);
  });

  it('ignores a DIFFERENT subcommand of a bin the block runs bare', () => {
    // The block runs `guard-review --gate`; `guard-review transcript` is a different command, not a
    // second run of the gate. Only the gates guard-deterministic orchestrates get a bare-bin match.
    expect(strayGateCalls(hook('guard-review transcript'))).toHaveLength(0);
    expect(strayGateCalls(hook('guard-review clear-cache'))).toHaveLength(0);
  });

  it('ignores which/type/hash probes too', () => {
    const below = 'which guard-review\ntype guard-review\nhash guard-review';
    expect(strayGateCalls(hook(below))).toHaveLength(0);
  });

  // Self-host rewrites `bunx guard-review` to `node gate-engine/review/cli.mts` before writing the
  // hook, so matching bin NAMES alone leaves blockSignatures empty and the check silently does
  // nothing — in the very repo that dogfoods it. The alias comes from the repo's own bin map.
  it('matches a self-hosted block (node gate-engine/...) against a bin-name stray', () => {
    const selfHosted = [
      '#!/bin/bash',
      '# >>> devkit-guards >>>',
      'node gate-engine/review/cli.mts --gate',
      '# <<< devkit-guards <<<',
      'guard-review --gate || rrc=$?',
    ].join('\n');
    // cwd = the devkit repo, whose package.json bin map supplies the alias.
    const found = strayGateCalls(selfHosted, '', process.cwd());
    expect(found.map((f) => f.bin)).toEqual(['guard-review']);
  });

  it('still reports a genuine stray in a monorepo hook', () => {
    const monorepo = [
      '#!/bin/bash',
      '# >>> devkit-guards: services/api >>>',
      'bunx guard-deterministic --hook "$0" || exit 1',
      '# <<< devkit-guards: services/api <<<',
      '# >>> devkit-guards: services/web >>>',
      'bunx guard-deterministic --hook "$0" || exit 1',
      '# <<< devkit-guards: services/web <<<',
      'guard-deterministic --hook "$0" || exit 1', // hand-written, outside every block
    ].join('\n');
    const found = strayGateCalls(monorepo, 'services/web');
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(8);
  });
});
