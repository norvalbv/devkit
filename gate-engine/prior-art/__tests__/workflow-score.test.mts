import { describe, expect, it } from 'vitest';
import type { Member, Span } from '../eval/workflow/families.mts';
import { quoteLines, scoreRun, spanStatus, toFileRef } from '../eval/workflow/score.mts';
import type { ToolCall, ToolInput } from '../eval/workflow/trace.mts';
import { member, response, stream } from './workflow-fixtures.mts';

const WS = '/private/var/folders/x/prior-art-wf-1';
const call = (name: string, input: ToolInput, result = ''): ToolCall => ({
  id: name,
  name,
  input,
  result,
  isError: false,
});

describe('workspace path normalisation', () => {
  it('maps every spelling of a workspace path onto the same snapshot file', () => {
    const peer = { root: 'peer', path: 'src/a.ts' };
    expect(toFileRef(`${WS}/refs/peer/src/a.ts`, WS)).toEqual(peer);
    expect(toFileRef('/var/folders/x/prior-art-wf-1/refs/peer/src/a.ts', WS)).toEqual(peer);
    expect(toFileRef('../refs/peer/src/a.ts:12-20', WS)).toEqual(peer);
    expect(toFileRef('refs/peer/src/a.ts#L12', WS)).toEqual(peer);
    expect(toFileRef('./docs/x.md', WS)).toEqual({ root: 'consumer', path: 'docs/x.md' });
    expect(toFileRef('/etc/passwd', WS)).toBeNull();
  });
});

describe('required-span accounting', () => {
  const span: Span = { root: 'peer', path: 'src/big.ts', lines: [3504, 3531] };
  const file = `${WS}/refs/peer/src/big.ts`;

  it('reads a tree-wide Grep line whose path itself holds a -<digits>- run', () => {
    const odd: Span = { root: 'peer', path: 'src/foo-2-bar.ts', lines: [10, 10] };
    const grep = call('Grep', { path: `${WS}/refs` }, `${WS}/refs/peer/src/foo-2-bar.ts:10:  x`);
    expect(spanStatus(odd, [grep], WS)).toBe('read');
  });

  it('a Read without an offset stops at 2000 lines, so it locates but does not read a late span', () => {
    expect(spanStatus(span, [call('Read', { file_path: file })], WS)).toBe('located');
    expect(spanStatus(span, [call('Read', { file_path: file, offset: 3490, limit: 60 })], WS)).toBe(
      'read',
    );
  });

  it('Grep content output reads a span; a files-with-matches listing only locates it', () => {
    const scoped = call(
      'Grep',
      { path: file, output_mode: 'content' },
      '3517:  Stream.takeWhile(...)',
    );
    expect(spanStatus(span, [scoped], WS)).toBe('read');
    const tree = call('Grep', { path: `${WS}/refs` }, `${file}:3520:      handleSdkMessage`);
    expect(spanStatus(span, [tree], WS)).toBe('read');
    const listing = call('Grep', { output_mode: 'files_with_matches' }, file);
    expect(spanStatus(span, [listing], WS)).toBe('located');
    expect(
      spanStatus(span, [call('Glob', { pattern: '**/*.md' }, `${WS}/refs/peer/README.md`)], WS),
    ).toBe('missed');
  });
});

describe('quote fidelity', () => {
  const content = 'line one\n  const x =   takeWhile(\n    () => !stopped,\n  );\nlast';

  it('matches across reflowed whitespace and ellipses, returning the first fragment line', () => {
    expect(quoteLines('const x = takeWhile( () => !stopped', content)).toEqual([2]);
    expect(quoteLines('takeWhile( … !stopped', content)).toEqual([2]);
    expect(quoteLines('last', content)).toEqual([5]);
  });

  it('matches a quote that runs across line-leading comment markers', () => {
    const comment =
      'code();\n  // A blocking preflight placed ahead\n  // of the record would reintroduce it.\n';
    expect(
      quoteLines('A blocking preflight placed ahead of the record would reintroduce it.', comment),
    ).toEqual([2]);
  });

  it('finds nothing when any fragment is absent or the quote is empty', () => {
    expect(quoteLines('takeWhile ... neverWritten', content)).toEqual([]);
    expect(quoteLines('', content)).toEqual([]);
  });
});

describe('claim support and leg honesty', () => {
  const m = member({
    gold: [{ id: 'g', desc: 'd', spans: [{ root: 'peer', path: 'src/a.ts', lines: [2, 3] }] }],
    decoys: [
      { id: 'd', desc: 'd', spans: [{ root: 'consumer', path: 'lib/b.ts', lines: [1, 1] }] },
    ],
  });
  const files = new Map([
    ['peer:src/a.ts', 'header\nconst session = consume();\nuntil(stopped);\n'],
    ['consumer:lib/b.ts', 'retry(5);\n'],
    ['consumer:README.md', 'unlabelled but real\n'],
  ]);
  const read = (_m: Member, root: string, file: string) => files.get(`${root}:${file}`) ?? null;

  it('sorts each cited claim into supported, decoy, unjudged, unverifiable or external', () => {
    const raw = response({
      verdict: 'GENUINE_NEW_WORK',
      resolved: 1,
      evidence: [
        { source: 'src/a.ts', repoRoot: '../refs/peer', quote: 'const session = consume();' },
        { source: `${WS}/consumer/lib/b.ts`, quote: 'retry(5);' },
        { source: 'README.md', quote: 'unlabelled but real' },
        { source: 'README.md', quote: 'a quote the file never held' },
        { kind: 'github', source: 'https://github.com/x/y/pull/1', quote: '' },
      ],
    });
    const score = scoreRun(m, 'search', stream({ result: raw }), WS, read);
    expect(score.claims).toEqual({
      supported: 1,
      decoy: 1,
      unjudged: 1,
      unverifiable: 1,
      external: 1,
    });
    expect(score.recalled).toEqual({ g: true });
    expect(score.legHonest).toBe(true);
    expect(score.fault).toBeNull();
  });

  it('places a quote that repeats in the file by its cited line, and leaves it unjudged when uncited', () => {
    const shell = member({
      gold: [{ id: 'g', desc: 'd', spans: [{ root: 'consumer', path: 's.sh', lines: [2, 2] }] }],
      decoys: [{ id: 'd', desc: 'd', spans: [{ root: 'consumer', path: 's.sh', lines: [4, 4] }] }],
    });
    const script = 'set -e\n  exit 1\nrecord\n  exit 1\n';
    const readScript = (_m: Member, root: string, file: string) =>
      root === 'consumer' && file === 's.sh' ? script : null;
    const raw = response({
      verdict: 'GENUINE_NEW_WORK',
      resolved: 1,
      evidence: [
        { source: 's.sh:4', quote: 'exit 1' },
        { source: 's.sh:2-2', quote: 'exit 1' },
        { source: 's.sh', quote: 'exit 1' },
      ],
    });
    const score = scoreRun(shell, 'search', stream({ result: raw }), WS, readScript);
    expect(score.claims).toMatchObject({ decoy: 1, supported: 1, unjudged: 1 });
  });

  it('resolves a repoRoot-scoped citation to the peer file even when the consumer has the same name', () => {
    const peer = member({
      gold: [{ id: 'g', desc: 'd', spans: [{ root: 'peer', path: 'README.md', lines: [1, 1] }] }],
    });
    const readmes = new Map([
      ['consumer:README.md', 'our own readme\n'],
      ['peer:README.md', 'consume the session stream\n'],
    ]);
    const readBoth = (_m: Member, root: string, file: string) =>
      readmes.get(`${root}:${file}`) ?? null;
    const raw = response({
      verdict: 'GENUINE_NEW_WORK',
      resolved: 1,
      evidence: [
        { source: 'README.md', repoRoot: '../refs/peer', quote: 'consume the session stream' },
      ],
    });
    const score = scoreRun(peer, 'search', stream({ result: raw }), WS, readBoth);
    expect(score).toMatchObject({
      recalled: { g: true },
      claims: { supported: 1, unverifiable: 0 },
    });
  });

  it('flags a local leg that claims reached with nothing resolved as dishonest', () => {
    const broken = member({ refs: [], expectVerdict: ['INSUFFICIENT_EVIDENCE'] });
    const raw = response({ verdict: 'INSUFFICIENT_EVIDENCE', resolved: 1 });
    expect(scoreRun(broken, 'search', stream({ result: raw }), WS, read).legHonest).toBe(false);
    const honest = response({ verdict: 'INSUFFICIENT_EVIDENCE', resolved: 0 });
    expect(scoreRun(broken, 'search', stream({ result: honest }), WS, read).legHonest).toBe(true);
  });

  it('scores a missing or malformed result as DARK or INVALID, never as a verdict', () => {
    expect(scoreRun(m, 'search', stream({ result: null }), WS, read).verdict).toBe('DARK');
    expect(scoreRun(m, 'search', stream({ result: 'prose' }), WS, read)).toMatchObject({
      verdict: 'INVALID',
      valid: false,
      legHonest: null,
    });
  });
});
