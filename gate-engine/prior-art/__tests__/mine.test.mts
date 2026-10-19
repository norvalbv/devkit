import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { casesPath, lintRows, loadRows } from '../eval/cases.mts';
import {
  buildCandidates,
  draftRow,
  type FeedbackEvent,
  main,
  type PromoteInput,
  readPriorArtEvents,
} from '../eval/mine.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
// Synthesized and sanitized: a size cap read as raw physical lines, plus two contrasts.
const SEED: { id: string; verdict: string; request: string; response: unknown }[] = JSON.parse(
  readFileSync(path.join(here, 'fixtures', 'mine-physical-lines.json'), 'utf8'),
);

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

let telemetry: string;
let sink: string;

beforeEach(() => {
  telemetry = mkdtempSync(path.join(tmpdir(), 'prior-art-mine-'));
  sink = path.join(telemetry, 'gate-events.jsonl');
  writeFileSync(sink, '');
});

function archive(text: string): string {
  const hash = sha(text);
  mkdirSync(path.join(telemetry, 'evidence'), { recursive: true });
  writeFileSync(path.join(telemetry, 'evidence', `${hash}.gz`), gzipSync(Buffer.from(text)));
  return hash;
}

function append(...events: object[]): void {
  writeFileSync(sink, events.map((e) => `${JSON.stringify(e)}\n`).join(''), { flag: 'a' });
}

function run(id: string, request: string, response: string, ts = '2026-10-01T00:00:00Z') {
  return {
    type: 'judge_exec',
    judge: 'prior-art',
    invocation_id: id,
    request_sha256: archive(request),
    output_sha256: archive(response),
    ts,
  };
}

function feedback(id: string, run: string, extra: Partial<FeedbackEvent> = {}) {
  return {
    type: 'agent_feedback',
    judge: 'prior-art',
    invocation_id: run,
    feedback_id: id,
    claimed_verdict: 'DISSOLVE_FRAME',
    feedback_source: 'user',
    reason: 'FEEDBACK-REASON-TEXT',
    ts: '2026-10-02T00:00:00Z',
    ...extra,
  };
}

async function queue(asOf?: string) {
  return buildCandidates(await readPriorArtEvents(sink, asOf), path.join(telemetry, 'evidence'));
}

function seed(): void {
  SEED.forEach((c, i) => {
    append(run(uuid(i + 1), c.request, JSON.stringify(c.response)));
  });
}

const promoteInput = (labelSource: string): PromoteInput => ({
  caseId: 'size-cap-physical-lines',
  verdict: 'DISSOLVE_FRAME',
  framing: 'DISSOLVES',
  labelSource,
  privacyReviewed: true,
});

const labelUrl = 'https://example.test/decision/raw-line-cap';

describe('prior-art miner: evidence', () => {
  it('reports each side present only when the archived bytes hash back to the key', async () => {
    seed();
    const { candidates } = await queue();
    expect(candidates).toHaveLength(3);
    for (const c of candidates) {
      expect(c.request.evidence).toBe('present');
      expect(c.output.evidence).toBe('present');
    }
  });

  it('names missing, corrupt, mismatched and never-captured evidence instead of guessing', async () => {
    const hash = (n: number) => String(n).repeat(64);
    mkdirSync(path.join(telemetry, 'evidence'), { recursive: true });
    writeFileSync(path.join(telemetry, 'evidence', `${hash(2)}.gz`), 'not gzip');
    writeFileSync(path.join(telemetry, 'evidence', `${hash(3)}.gz`), gzipSync('other bytes'));
    append(
      {
        type: 'judge_exec',
        judge: 'prior-art',
        invocation_id: uuid(1),
        ts: 'a',
        output_sha256: hash(1),
      },
      {
        type: 'judge_exec',
        judge: 'prior-art',
        invocation_id: uuid(2),
        ts: 'a',
        output_sha256: hash(2),
      },
      {
        type: 'judge_exec',
        judge: 'prior-art',
        invocation_id: uuid(3),
        ts: 'a',
        output_sha256: hash(3),
      },
    );
    const { candidates } = await queue();
    expect(candidates.map((c) => c.output.evidence)).toEqual([
      'missing',
      'corrupt',
      'hash_mismatch',
    ]);
    expect(candidates.every((c) => c.request.evidence === 'not_captured')).toBe(true);
  });
});

describe('prior-art miner: events', () => {
  it('collapses a re-serialised copy of one run but keeps repeated invocations apart', async () => {
    const first = run(uuid(1), 'same request', 'same response');
    append(first, Object.fromEntries(Object.entries(first).reverse()));
    append(run(uuid(2), 'same request', 'same response'));
    const { candidates } = await queue();
    expect(candidates.map((c) => [c.copies, c.conflict])).toEqual([
      [2, false],
      [1, false],
    ]);
  });

  it('flags one invocation id carrying two different payloads as a conflict', async () => {
    append(run(uuid(1), 'request', 'a'), run(uuid(1), 'request', 'b'));
    append({ ...run(uuid(2), 'request', 'a'), disposition: 'followed' });
    append({ ...run(uuid(2), 'request', 'a'), disposition: 'overridden' });
    expect((await queue()).candidates.map((c) => c.conflict)).toEqual([true, true]);
  });

  it('keeps both payloads of one feedback id and reads them as a conflict', async () => {
    seed();
    append(
      feedback(uuid(10), uuid(1), { claimed_verdict: 'DISSOLVE_FRAME' }),
      feedback(uuid(10), uuid(1), { claimed_verdict: 'GENUINE_NEW_WORK' }),
    );
    const c = must((await queue()).candidates[0]);
    expect(c.feedback.map((f) => f.claimed_verdict)).toEqual([
      'DISSOLVE_FRAME',
      'GENUINE_NEW_WORK',
    ]);
    expect(c.feedback_state).toBe('conflict');
  });

  it('keeps every feedback revision and settles on the one nothing supersedes', async () => {
    seed();
    append(
      feedback(uuid(10), uuid(1), { claimed_verdict: 'GENUINE_NEW_WORK', feedback_source: 'root' }),
      feedback(uuid(11), uuid(1), { supersedes: uuid(10), ts: '2026-10-03T00:00:00Z' }),
      feedback(uuid(11), uuid(1), { supersedes: uuid(10), ts: '2026-10-03T00:00:00Z' }),
    );
    const c = must((await queue()).candidates[0]);
    expect(c.feedback.map((f) => f.feedback_id)).toEqual([uuid(10), uuid(11)]);
    expect(c).toMatchObject({ heads: [uuid(11)], feedback_state: 'settled', dangling: [] });
  });

  it('reports two heads as a conflict and a broken supersedes link as dangling', async () => {
    seed();
    append(
      feedback(uuid(10), uuid(1)),
      feedback(uuid(11), uuid(1), { supersedes: uuid(10) }),
      feedback(uuid(12), uuid(1), { supersedes: uuid(10) }),
      feedback(uuid(13), uuid(2), { supersedes: uuid(10) }),
      feedback(uuid(14), uuid(99)),
    );
    const { candidates, orphanFeedback } = await queue();
    expect(candidates[0]).toMatchObject({
      heads: [uuid(11), uuid(12)],
      feedback_state: 'conflict',
    });
    expect(candidates[1]).toMatchObject({ dangling: [uuid(13)], heads: [uuid(13)] });
    expect(orphanFeedback).toEqual([uuid(14)]);
  });

  it('counts a torn trailing line as malformed and still mines every complete line', async () => {
    seed();
    writeFileSync(sink, '{"type":"judge_exec","judge":"prior-art","invo', { flag: 'a' });
    const q = await queue();
    expect(q.candidates).toHaveLength(3);
    expect(q.malformed).toBe(1);
  });

  // record-feedback cannot write a cycle, but a hand-edited or merged sink can; it must not read as no feedback.
  it('reports a supersession cycle as a conflict, never as no feedback', async () => {
    seed();
    append(
      feedback(uuid(10), uuid(1), { supersedes: uuid(11) }),
      feedback(uuid(11), uuid(1), { supersedes: uuid(10) }),
    );
    expect(must((await queue()).candidates[0])).toMatchObject({
      heads: [],
      feedback_state: 'conflict',
    });
  });

  it('keeps a run whose optional metadata is null instead of silently dropping it', async () => {
    append({ ...run(uuid(1), 'request', 'response'), prior_art_verdict: null, repo: null });
    expect((await queue()).candidates).toHaveLength(1);
  });

  it('drops events after the as-of cutoff, so a later claim cannot enter an earlier freeze', async () => {
    seed();
    append(
      run(uuid(4), 'late request', 'late response', '2026-11-01T00:00:00Z'),
      feedback(uuid(10), uuid(1), { ts: '2026-11-02T00:00:00Z' }),
      feedback(uuid(11), uuid(1), { supersedes: uuid(10), ts: '2026-10-05T00:00:00Z' }),
    );
    const { candidates } = await queue('2026-10-31T00:00:00Z');
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({ heads: [uuid(11)], dangling: [uuid(11)] });
  });
});

describe('prior-art miner: promotion', () => {
  it('drafts a row from bytes captured at run time only', async () => {
    seed();
    append(feedback(uuid(10), uuid(1)));
    const candidate = must((await queue()).candidates[0]);
    const result = draftRow(candidate, promoteInput(labelUrl), telemetry);
    if (!result.ok) throw new Error(result.errors.join('; '));
    const { draft } = result;
    const archived = JSON.stringify(SEED[0]?.response);
    expect(draft.prompt.startsWith(SEED[0]?.request ?? '')).toBe(true);
    for (const line of draft.prompt.split('REFERENCE EXCERPTS')[1]?.split('\n').slice(1) ?? [])
      expect(archived).toContain(line.replace(/^\[E\d+ · [^\]]+\] /, ''));
    expect(draft.prompt).not.toContain('FEEDBACK-REASON-TEXT');
    expect(draft).toMatchObject({
      provenance: 'mined',
      caseId: 'size-cap-physical-lines',
      expectVerdict: ['DISSOLVE_FRAME'],
      source: { url: labelUrl, invocationId: uuid(1) },
      legs: { local: { status: 'reached', declared: 1, resolved: 1 }, github: 'reached' },
    });
    // A draft is not a row: it cannot pass the corpus lint until a human authors it.
    expect(lintRows([draft])).toEqual(
      expect.arrayContaining([expect.stringContaining('missing "category"')]),
    );
  });

  it('refuses a feedback claim or the run’s own telemetry as the label source', async () => {
    seed();
    const candidate = must((await queue()).candidates[0]);
    const errors = (labelSource: string) => {
      const result = draftRow(candidate, promoteInput(labelSource), telemetry);
      return result.ok ? [] : result.errors;
    };
    expect(errors(uuid(10))).toEqual(['a feedback id is a claim, not a label source']);
    expect(errors(sink)).toEqual(['the run’s own telemetry cannot label it']);
    const receipt = path.join(mkdtempSync(path.join(tmpdir(), 'receipt-')), 'review.md');
    writeFileSync(receipt, 'independent review');
    expect(errors(receipt)).toEqual([]);
    const link = path.join(path.dirname(receipt), 'linked.md');
    symlinkSync(sink, link);
    expect(errors(link)).toEqual(['the run’s own telemetry cannot label it']);
    const dotted = path.join(telemetry, '..notes.json');
    writeFileSync(dotted, '{}');
    expect(errors(dotted)).toEqual(['the run’s own telemetry cannot label it']);
  });

  it('refuses to promote a run recorded with two different payloads', async () => {
    append(run(uuid(1), SEED[0]?.request ?? '', JSON.stringify(SEED[0]?.response)));
    append(run(uuid(1), 'another request', JSON.stringify(SEED[0]?.response)));
    const result = draftRow(must((await queue()).candidates[0]), promoteInput(labelUrl), telemetry);
    expect(result.ok ? [] : result.errors).toEqual([
      'the run was recorded with conflicting payloads; resolve which one is real first',
    ]);
  });

  it('refuses without a privacy review, a family, valid evidence or a valid response', async () => {
    seed();
    const { candidates } = await queue();
    const first = must(candidates[0]);
    const third = must(candidates[2]);
    const bare = { ...promoteInput(labelUrl), caseId: ' ', privacyReviewed: false };
    const refused = draftRow(first, bare, telemetry);
    expect(refused.ok ? [] : refused.errors).toHaveLength(2);
    const missing = { ...third, output: { ...third.output, sha256: 'f'.repeat(64) } };
    expect(draftRow(missing, promoteInput(labelUrl), telemetry).ok).toBe(false);
    append(run(uuid(9), 'request', 'not json'));
    const invalid = must((await queue()).candidates.at(-1));
    const result = draftRow(invalid, promoteInput(labelUrl), telemetry);
    expect(result.ok ? [] : result.errors).toEqual([
      'the archived response is invalid: response is not valid JSON',
    ]);
  });

  it('promote writes one draft, never rewrites it, and never touches the corpus', async () => {
    seed();
    const corpus = readFileSync(casesPath);
    const drafts = path.join(telemetry, '..', `${path.basename(telemetry)}-drafts`);
    const argv = [
      'promote',
      uuid(1),
      '--sink',
      sink,
      '--drafts',
      drafts,
      '--case-id',
      'size-cap-physical-lines',
      '--verdict',
      'DISSOLVE_FRAME',
      '--label-source',
      labelUrl,
      '--privacy-reviewed',
    ];
    expect(await main(argv)).toBe(0);
    expect(JSON.parse(readFileSync(path.join(drafts, `${uuid(1)}.json`), 'utf8'))).toMatchObject({
      caseId: 'size-cap-physical-lines',
    });
    expect(await main(argv)).toBe(2);
    expect(await main(argv.filter((a) => a !== '--privacy-reviewed'))).toBe(2);
    expect(readFileSync(casesPath).equals(corpus)).toBe(true);
  });

  it('names an unwritable drafts directory instead of claiming the draft exists', async () => {
    seed();
    const drafts = path.join(telemetry, 'locked');
    mkdirSync(drafts);
    chmodSync(drafts, 0o500);
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line) => errors.push(String(line)));
    try {
      const argv = ['promote', uuid(1), '--sink', sink, '--drafts', drafts, '--case-id', 'c'];
      const flags = ['--verdict', 'DISSOLVE_FRAME', '--label-source', labelUrl];
      expect(await main([...argv, ...flags, '--privacy-reviewed'])).toBe(2);
    } finally {
      spy.mockRestore();
      chmodSync(drafts, 0o700);
    }
    expect(errors.join('\n')).not.toContain('already exists');
    expect(errors.join('\n')).toContain('cannot write');
  });

  it('writes the candidate queue without touching the corpus', async () => {
    seed();
    const out = path.join(telemetry, 'queue', 'candidates.jsonl');
    expect(await main(['--sink', sink, '--out', out])).toBe(0);
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(3);
    process.env.DEVKIT_GATE_EVENTS = path.join(telemetry, 'absent.jsonl');
    try {
      expect(await main(['--out', out])).toBe(2);
    } finally {
      delete process.env.DEVKIT_GATE_EVENTS;
    }
    expect(await main(['promote', uuid(99), '--sink', sink])).toBe(2);
  });

  it('reads a date-only cutoff as that instant and refuses one it cannot parse', async () => {
    seed();
    const out = path.join(telemetry, 'queue', 'candidates.jsonl');
    expect(await main(['--sink', sink, '--out', out, '--as-of', '2026-09-30'])).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('');
    // A string compare against `yesterday` would admit every event and freeze nothing.
    expect(await main(['--sink', sink, '--out', out, '--as-of', 'yesterday'])).toBe(2);
  });

  it('refuses an unknown verdict or framing and evidence that is not UTF-8', async () => {
    append(run(uuid(1), 'request', 'response'));
    const bytes = Buffer.from([0xff, 0xfe]);
    writeFileSync(path.join(telemetry, 'evidence', `${sha(bytes)}.gz`), gzipSync(bytes));
    const candidate = must((await queue()).candidates[0]);
    const binary = { ...candidate, output: { ...candidate.output, sha256: sha(bytes) } };
    const input = { ...promoteInput(labelUrl), verdict: 'MAYBE', framing: 'SIDEWAYS' };
    const result = draftRow(binary, input, telemetry);
    expect(result.ok ? [] : result.errors).toEqual([
      'verdict "MAYBE" is not a prior-art verdict',
      'framing "SIDEWAYS" is not a framing',
      'response evidence is not UTF-8',
    ]);
  });
});

describe('prior-art corpus families', () => {
  it('rejects variants of one case split across holdout partitions', () => {
    const row = must(loadRows()[0]);
    const variant = (id: string, holdout: boolean) => ({ ...row, id, caseId: 'fam', holdout });
    const split = lintRows([variant('a', true), variant('b', false)]);
    expect(split).toContain('case fam: variants split across holdout partitions');
    expect(lintRows([variant('a', true), variant('b', true)])).toEqual([]);
    const unsourced = { ...variant('a', true), source: { invocationId: uuid(1) } };
    expect(lintRows([unsourced])).toEqual(['row 1 (a): source needs a url or a receipt']);
  });
});
