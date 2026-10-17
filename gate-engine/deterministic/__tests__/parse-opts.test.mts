import { describe, expect, it } from 'vitest';
import { parseOpts } from '../parse-opts.mts';

describe('parseOpts — the argv tokenizer the real hook depends on', () => {
  it('captures --hook/--scope/--structure values and repeated --extra specs', () => {
    const o = parseOpts([
      '--hook',
      '/a b/pre-commit',
      '--scope',
      'frink-extra',
      '--structure',
      'guard-structure gate',
      '--extra',
      'lint=bun run lint',
      '--extra',
      'types=tsc -p .',
    ]);
    expect(o.hookPath).toBe('/a b/pre-commit');
    expect(o.scope).toBe('frink-extra');
    expect(o.structure).toBe('guard-structure gate');
    expect(o.extra).toEqual([
      { label: 'lint', cmd: 'bun run lint' },
      { label: 'types', cmd: 'tsc -p .' },
    ]);
  });

  it('a malformed --extra (no `=`) parses to a label-only spec (runDeterministic then blocks it)', () => {
    expect(parseOpts(['--extra', 'lint']).extra).toEqual([{ label: 'lint' }]);
  });

  it('--only splits/trims/drops blanks — `,,` yields [] (fail-closed at runDeterministic)', () => {
    expect(parseOpts(['--only', 'size, fanout ,']).only).toEqual(['size', 'fanout']);
    expect(parseOpts(['--only', ',,']).only).toEqual([]);
  });
});
