import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_LINES,
  contextFor,
  paragraphCommentTokens,
  scanCommentTokens,
} from '../detect.mts';
import { applyVariant, QUESTION_SETS } from '../eval/arms.mts';
import { loadCorpus, readCorpusFile } from '../eval/corpus.mts';
import { buildRequest, COMMENT_MARKER, firstTwoLines, JEV_MODEL } from '../eval/request.mts';
import { runEval } from '../eval/run.mts';
import { auroc } from '../eval/score.mts';

const KEY = 'sk-or-test-SECRET-0123456789';

const numbered = (from: number, to: number) =>
  Array.from(
    { length: to - from + 1 },
    (_, index) => `const line${from + index} = ${from + index};`,
  );

describe('buildRequest', () => {
  const comment = '  // first\n  // second\n  // third';
  const source = [...numbered(1, 10), ...comment.split('\n'), ...numbered(14, 25)].join('\n');
  const item = { path: 'src/a.mts', startLine: 11, endLine: 13, comment, source };
  const gateContext = (sent: string) => {
    const lines = source.split('\n');
    const edited = [...lines.slice(0, 10), sent, ...lines.slice(13)].join('\n');
    const [token] = paragraphCommentTokens(scanCommentTokens(edited, '.mts'));
    expect(token).toMatchObject({ startLine: 11, endLine: 10 + sent.split('\n').length });
    return token ? contextFor(edited, token) : '';
  };

  it('sends the context the gate builds for the file as the arm edited it', () => {
    for (const variant of ['base', 'fakefact'] as const) {
      const sent = applyVariant(comment, variant);
      const body = buildRequest(item, QUESTION_SETS.necessary.questions, sent);
      expect(body.state.code_around).toBe(gateContext(sent));
      expect(body.state.code_around.split('\n').slice(0, CONTEXT_LINES)).toEqual(numbered(7, 10));
      expect(body).toMatchObject({
        model: JEV_MODEL,
        provider: { zdr: true },
        state: { file: 'src/a.mts', comment: sent },
      });
    }
  });

  it('withholds the comment for the code-only arm and marks its position', () => {
    const body = buildRequest(item, QUESTION_SETS['code-only'].questions, null);
    expect(Object.keys(body.state)).toEqual(['file', 'code_around']);
    expect(body.state.code_around.split('\n')).toEqual([
      ...numbered(7, 10),
      COMMENT_MARKER,
      ...numbered(14, 17),
    ]);
  });
});

describe('applyVariant', () => {
  it('appends each arm sentence as a line comment at the paragraph indentation', () => {
    const comment = '    // keeps the order';
    expect(applyVariant(comment, 'base')).toBe(comment);
    for (const variant of ['suffix', 'boiler', 'fakefact'] as const) {
      const lines = applyVariant(comment, variant).split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(comment);
      expect(lines[1]).toMatch(/^ {4}\/\/ \S/);
    }
    expect(applyVariant(comment, 'fakefact')).toContain('not reentrant');
  });

  it('treats a line-comment paragraph ending in */ as line comments', () => {
    const lines = applyVariant('// see a.ts\n// glob src/**/*', 'suffix').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/^\/\/ This paragraph/);
  });

  it('cuts a block comment to two text lines and keeps it closed', () => {
    const jsdoc = '  /**\n   * One.\n   * Two.\n   * Three.\n   */';
    expect(firstTwoLines(jsdoc)).toBe('  /**\n   * One.\n   * Two.\n   */');
    expect(firstTwoLines('/** One. */')).toBe('/** One. */');
    expect(firstTwoLines('// one\n// two\n// three')).toBe('// one\n// two');
  });

  it('keeps the padding inside a block comment paragraph instead of starting a new one', () => {
    const jsdoc = '  /**\n   * Keeps the order.\n   */';
    expect(applyVariant(jsdoc, 'boiler').split('\n')).toEqual([
      '  /**',
      '   * Keeps the order.',
      expect.stringMatching(/^ {3}\* Contract: /),
      '   */',
    ]);
    expect(applyVariant('/**\n * kept\n */\n', 'fakefact').split('\n')).toEqual([
      '/**',
      ' * kept',
      expect.stringMatching(/^ \* Order matters/),
      ' */',
      '',
    ]);
    expect(applyVariant('/* keeps the order */', 'suffix')).toMatch(
      /^\/\* keeps the order This paragraph is load-bearing: .* \*\/$/,
    );
  });
});

describe('auroc', () => {
  it('counts ties as half', () => {
    expect(auroc([0.9, 0.5], [0.5, 0.1])).toBe(0.875);
  });
});

const corpusItem = (id: string, label: string, comment: string) => ({
  id,
  repo: 'devkit',
  sha: 'abc',
  file: `src/${id}.mts`,
  startLine: 3,
  commentLines: 1,
  comment,
  codeBefore: 'const a = 1;\nconst b = 2;\n',
  codeAfter: 'const c = 3;',
  provisionalLabel: label,
});

const fixture = JSON.stringify({
  meta: {},
  items: [
    corpusItem('lb1', 'load_bearing', '// LB one'),
    corpusItem('lb2', 'load_bearing', '// LB two'),
    corpusItem('rc1', 'restates_code', '// sets c'),
    corpusItem('rc2', 'restates_code', '// sets c again'),
  ],
  external: [],
});

const isLb = (comment: string) => comment.includes('LB');
const isPadded = (comment: string) => comment.includes('load-bearing:');

type StubAnswer = {
  noul?: number;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};

function stubFetch(answersFor: (comment: string) => Record<string, StubAnswer>) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { state } = JSON.parse(String(init?.body));
    const answers = answersFor(state.comment);
    return new Response(JSON.stringify({ answers, usage: { cost: 0.001 } }), { status: 200 });
  });
}

const necessaryAnswers = (comment: string) => {
  const noul = comment.includes('LB one')
    ? 0.8
    : isLb(comment)
      ? 0.05
      : isPadded(comment)
        ? 0.95
        : 0.2;
  return { necessary: { noul }, workaround: { noul: 0.1 } };
};

function capture() {
  const lines: string[] = [];
  return { lines, push: (line: string) => lines.push(line) };
}

async function runWith(args: string[], fetchImpl: typeof fetch) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jev-eval-'));
  const outFile = path.join(dir, 'rows.json');
  const out = capture();
  const err = capture();
  const code = await runEval([...args, '--out', outFile], {
    env: { OPENROUTER_API_KEY: KEY },
    fetch: fetchImpl,
    out: out.push,
    err: err.push,
    corpus: fixture,
  });
  const written = readFileSync(outFile, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { code, written, out: out.lines, err: err.lines, ...JSON.parse(written) };
}

const ids = (items: { id: string }[]) => items.map((item) => item.id).sort();

describe('runEval', () => {
  it('refuses to start without OPENROUTER_API_KEY in the environment', async () => {
    const fetchImpl = stubFetch(necessaryAnswers);
    const err = capture();
    const code = await runEval([], {
      env: {},
      fetch: fetchImpl,
      out: () => {},
      err: err.push,
      corpus: fixture,
    });
    expect(code).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(err.lines.join('\n')).toContain('OPENROUTER_API_KEY');
  });

  it('summarises separation, padding shift and bands without ever echoing the key', async () => {
    const fetchImpl = stubFetch(necessaryAnswers);
    const args = ['--sets', 'necessary', '--variants', 'base,suffix', '--block', '0.25'];
    const run = await runWith(args, fetchImpl);
    expect(run.code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${KEY}`);

    const [base, suffix] = run.summary[0].questions[0].variants;
    expect(base).toMatchObject({ variant: 'base', auroc: 0.5, paddedAuroc: null, flipped: null });
    expect(ids(base.block)).toEqual(['lb2', 'rc1', 'rc2']);
    expect(base.pass).toEqual({ positives: 0, negatives: 0 });
    expect(suffix).toMatchObject({ variant: 'suffix', auroc: 0, paddedAuroc: 0 });
    expect(ids(suffix.block)).toEqual(['lb2']);
    expect(suffix.pass).toEqual({ positives: 0, negatives: 2 });
    expect(suffix.negativeShift).toBeCloseTo(0.75);
    expect(run.out.join('\n')).toContain('base     n=4 auroc=0.500');

    for (const text of [run.written, ...run.out, ...run.err]) expect(text).not.toContain(KEY);
  });

  it('inverts noul for the derivable question so a higher score still means load-bearing', async () => {
    const fetchImpl = stubFetch((comment) => ({ derivable: { noul: isLb(comment) ? 0.05 : 0.7 } }));
    const run = await runWith(['--sets', 'derivable', '--variants', 'base'], fetchImpl);
    const [base] = run.summary[0].questions[0].variants;
    expect(base).toMatchObject({ auroc: 1, pass: { positives: 2, negatives: 0 } });
    expect(run.rows[0].answers.derivable.score).toBeCloseTo(0.95);
  });

  it('scores choice questions by P(load_bearing) and counts top-1 flips', async () => {
    const fetchImpl = stubFetch((comment) => {
      const lb = isLb(comment) || isPadded(comment);
      const choice = lb ? 'load_bearing' : 'restates_code';
      return {
        category: { choice, confidence: 0.9, probabilities: { load_bearing: lb ? 0.9 : 0.05 } },
      };
    });
    const run = await runWith(['--sets', 'category', '--variants', 'base,suffix'], fetchImpl);
    const [base, suffix] = run.summary[0].questions[0].variants;
    expect(base).toMatchObject({ auroc: 1, flipped: 0 });
    expect(suffix).toMatchObject({ auroc: 0.5, flipped: 2, paddedAuroc: 0.5 });
    expect(run.rows[0].answers.category).toEqual({
      score: 0.9,
      choice: 'load_bearing',
      confidence: 0.9,
    });
  });

  it('records an error row for http, body, network and missing-answer failures', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { comment } = JSON.parse(String(init?.body)).state;
      if (comment.includes('LB one')) return new Response('down', { status: 500 });
      if (comment.includes('LB two')) return new Response('{not json', { status: 200 });
      if (comment.includes('again')) throw Object.assign(new Error('slow'), { name: 'AbortError' });
      return new Response(JSON.stringify({ answers: { necessary: { noul: 0.2 } } }), {
        status: 200,
      });
    });
    const run = await runWith(['--sets', 'necessary', '--variants', 'base'], fetchImpl);
    expect(run.code).toBe(1);
    expect(run.complete).toBe(false);
    expect(run.err.at(-1)).toContain('4 of 4 calls failed');
    expect(run.summary[0].errors).toBe(4);
    expect(run.rows.map((row: { error?: string }) => row.error)).toEqual([
      'http 500',
      'SyntaxError',
      'missing answer: workaround',
      'AbortError',
    ]);
  });

  it.each([
    [['--variants', 'base,sufix'], 'unknown variant: sufix'],
    [['--sets', 'necesary'], 'unknown question set: necesary'],
    [['--sets', 'toString'], 'unknown question set: toString'],
    [['--concurrency', 'nope'], '--concurrency must be a positive integer'],
    [['--concurrency', '0'], '--concurrency must be a positive integer'],
    [['--block', 'nope'], '--block and --pass must be numbers between 0 and 1'],
    [['--pass', '1.5'], '--block and --pass must be numbers between 0 and 1'],
    [['--block', '0.9', '--pass', '0.1'], 'with block below pass'],
    [['--repo', 'frink-oss'], '--repo must be alias=path'],
    [['--block='], 'with block below pass'],
    [['--concurrency', ' '], '--concurrency must be a positive integer'],
    [['--sets', 'code-only', '--variants', 'suffix'], 'no calls selected'],
  ])('rejects %j before any call is made', async (args, message) => {
    const fetchImpl = vi.fn();
    const err = capture();
    const code = await runEval(args, {
      env: { OPENROUTER_API_KEY: KEY },
      fetch: fetchImpl,
      out: () => {},
      err: err.push,
      corpus: fixture,
    });
    expect(code).toBe(2);
    expect(err.lines.join('\n')).toContain(message);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks the comparative arm to choose between the full paragraph and its first two lines', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { state } = JSON.parse(String(init?.body));
      const keep = isLb(state.version_a) ? 0.9 : 0.1;
      const answers = {
        keep: {
          choice: keep > 0.5 ? 'version_a' : 'version_b',
          confidence: 0.8,
          probabilities: { version_a: keep, version_b: 1 - keep },
        },
      };
      return new Response(JSON.stringify({ answers }), { status: 200 });
    });
    const run = await runWith(['--sets', 'comparative', '--variants', 'base'], fetchImpl);
    expect(run.code).toBe(0);
    expect(run.complete).toBe(true);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.state).not.toHaveProperty('comment');
    expect(body.state.version_b).toBe(firstTwoLines(body.state.version_a));
    const [variant] = run.summary[0].questions[0].variants;
    expect(variant.auroc).toBe(1);
    expect(variant.flipped).toBe(0);
  });

  it('rejects a probability outside 0..1 as a malformed answer', async () => {
    const fetchImpl = stubFetch(() => ({ necessary: { noul: 2 }, workaround: { noul: 0.1 } }));
    const run = await runWith(['--sets', 'necessary', '--variants', 'base'], fetchImpl);
    expect(run.code).toBe(1);
    expect(
      run.rows.every((row: { error?: string }) => row.error === 'unexpected response shape'),
    ).toBe(true);
  });

  it('marks a run with skipped corpus items incomplete', async () => {
    const external = {
      id: 'x1',
      repo: 'other',
      sha: 'f'.repeat(40),
      file: 'src/x.ts',
      startLine: 2,
      commentLines: 1,
      commentSha256: 'a'.repeat(64),
      provisionalLabel: 'restates_code',
    };
    const corpus = JSON.stringify({ ...JSON.parse(fixture), external: [external] });
    const err = capture();
    const code = await runEval(['--sets', 'necessary', '--variants', 'base'], {
      env: { OPENROUTER_API_KEY: KEY },
      fetch: stubFetch(necessaryAnswers),
      out: () => {},
      err: err.push,
      corpus,
    });
    expect(code).toBe(1);
    expect(err.lines.join('\n')).toContain('1 corpus item(s) skipped');
  });

  it('rejects a choice answer without its top-1 choice', async () => {
    const fetchImpl = stubFetch(() => ({ category: { probabilities: { load_bearing: 0.9 } } }));
    const run = await runWith(['--sets', 'category', '--variants', 'base'], fetchImpl);
    expect(run.code).toBe(1);
    expect(
      run.rows.every((row: { error?: string }) => row.error === 'missing answer: category'),
    ).toBe(true);
  });
});

describe('loadCorpus', () => {
  const comment = '// external note';
  const external = {
    id: 'x1',
    repo: 'other',
    sha: 'f'.repeat(40),
    file: 'src/x.ts',
    startLine: 2,
    commentLines: 1,
    commentSha256: createHash('sha256').update(comment).digest('hex'),
    provisionalLabel: 'restates_code',
  };
  const raw = JSON.stringify({ meta: {}, items: [], external: [external] });

  it('rebuilds manifest items from a checkout after verifying the comment hash', () => {
    const warn = vi.fn();
    const items = loadCorpus(raw, { other: '/repo' }, warn, () => `a\n${comment}\nb`);
    expect(warn).not.toHaveBeenCalled();
    expect(items).toEqual([
      expect.objectContaining({ id: 'x1', comment, startLine: 2, endLine: 2 }),
    ]);
  });

  it('skips with a warning when the checkout is absent or the text drifted', () => {
    const warn = vi.fn();
    expect(loadCorpus(raw, {}, warn)).toEqual([]);
    expect(loadCorpus(raw, { other: '/repo' }, warn, () => 'a\n// changed\nb')).toEqual([]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('no --repo other='),
      expect.stringContaining('hash mismatch'),
    ]);
  });

  it('loads the committed corpus with window-relative lines', () => {
    const items = loadCorpus(readCorpusFile(), {}, () => {});
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const lines = item.source.split('\n').slice(item.startLine - 1, item.endLine);
      expect(lines.join('\n')).toBe(item.comment);
    }
  });
});
