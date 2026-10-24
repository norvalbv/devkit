import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EvidenceEntry } from '../../machine/manifest.mts';
import { EVIDENCE_BEGIN, EVIDENCE_END } from './block.mts';
import {
  type MediaPlan,
  planMedia,
  qaSectionOf,
  renderQaSection,
  replaceKeepingQa,
  shortSha,
  uploadedMedia,
  withQaSection,
} from './media.mts';

const MB = 1024 * 1024;

function entry(file: string, overrides: Partial<EvidenceEntry> = {}): EvidenceEntry {
  const kind = file.endsWith('.webm') ? 'video' : 'screenshot';
  return {
    file,
    kind,
    flow: file.replace(/(\.[a-z0-9]+)?\.(webm|png)$/, ''),
    passed: true,
    sourceHead: 'a'.repeat(40),
    dirty: false,
    tree: 'b'.repeat(40),
    sha256: createHash('sha256').update(file).digest('hex'),
    bytes: 2048,
    capturedAt: '2026-10-23T00:00:00.000Z',
    ...overrides,
  };
}

const eligible = () => null;
const URL_A = 'https://github.com/user-attachments/assets/aaaa-1111';
const URL_B = 'https://github.com/user-attachments/assets/bbbb-2222';

describe('planMedia: what is apt to upload', () => {
  it("takes each passing flow's video and final screenshot, not its other screenshots", () => {
    const entries = [entry('click.webm'), entry('click.start.png'), entry('click.final.png')];
    expect(planMedia(entries, eligible, null).picks.map((e) => e.file)).toEqual([
      'click.webm',
      'click.final.png',
    ]);
  });

  it('falls back to at most four screenshots when no flow has a video', () => {
    const shots = ['a.1.png', 'a.2.png', 'a.3.png', 'a.4.png', 'a.5.png'].map((f) =>
      entry(f, { flow: 'a' }),
    );
    expect(planMedia(shots, eligible, null).picks).toHaveLength(4);
  });

  it('picks per flow, so a screenshot-only flow beside a flow with a video is still uploaded', () => {
    const entries = [
      entry('a.webm'),
      entry('a.final.png'),
      entry('b.start.png'),
      entry('b.final.png'),
    ];
    expect(planMedia(entries, eligible, null).picks.map((e) => e.file)).toEqual([
      'a.webm',
      'a.final.png',
      'b.start.png',
      'b.final.png',
    ]);
  });

  it('never uploads a failed or ineligible flow, and says why', () => {
    const entries = [
      entry('bad.webm', { flow: 'bad', passed: false }),
      entry('old.webm', { flow: 'old' }),
      entry('ok.webm', { flow: 'ok' }),
    ];
    const why = (e: EvidenceEntry) => (e.flow === 'old' ? 'it ran different code' : null);
    const plan = planMedia(entries, why, null);
    expect(plan.picks.map((e) => e.flow)).toEqual(['ok']);
    expect(plan.notes).toEqual([
      '`bad`: not uploaded, the flow failed',
      '`old`: not uploaded, it ran different code',
    ]);
  });

  it('leaves out files over the size limit and past six files, naming each', () => {
    const big = entry('big.webm', { flow: 'big', bytes: 9.5 * MB });
    const many = Array.from({ length: 7 }, (_, i) => entry(`f${i}.webm`, { flow: `f${i}` }));
    const plan = planMedia([big, ...many], eligible, null);
    expect(plan.picks).toHaveLength(6);
    expect(plan.notes[0]).toBe('`big.webm`: not uploaded, 9.5 MB is over the 9.0 MB limit');
    expect(plan.notes[1]).toBe('`f6.webm`: not uploaded, over 6 files');
  });

  it('says a UI change recorded nothing only when there is no capture at all', () => {
    expect(planMedia([], eligible, 'UI paths changed: src/a.tsx').notes[0]).toMatch(
      /^UI changed \(UI paths changed: src\/a\.tsx\); no QA capture recorded/,
    );
    expect(planMedia([], eligible, null)).toEqual({ picks: [], notes: [] });
  });
});

describe('the QA section in the PR body', () => {
  const video = entry('click.webm');
  const shot = entry('click.final.png');
  const plan: MediaPlan = { picks: [video, shot], notes: ['`bad`: not uploaded, the flow failed'] };
  const refs = new Map([
    [shortSha(video), URL_A],
    [shortSha(shot), URL_B],
  ]);

  it('reads back the uploaded URL of each capture by its short sha', () => {
    const section = renderQaSection(plan, refs);
    expect(section).toContain('ran the code this PR ships');
    expect(section).toContain('flow passed');
    expect(uploadedMedia(withQaSection('', section))).toEqual(refs);
  });

  it('reads the bare URL gh leaves for a video as well as an image link', () => {
    const section = renderQaSection(plan, refs).replace(`![click video](${URL_A})`, URL_A);
    expect(uploadedMedia(withQaSection('', section)).get(shortSha(video))).toBe(URL_A);
  });

  it('renders only captures that have a ref yet', () => {
    const section = renderQaSection(plan, new Map([[shortSha(video), './x.webm']]));
    expect(section).toContain('![click video](./x.webm)');
    expect(section).not.toContain('click.final.png');
  });

  it('goes inside the evidence block before its data line, leaving caller text untouched', () => {
    const body = `caller text\n\n${EVIDENCE_BEGIN}\n#### Regression evidence\n<!-- devkit:evidence:data {} -->\n${EVIDENCE_END}\n`;
    const next = withQaSection(body, renderQaSection(plan, refs));
    expect(next.startsWith('caller text\n\n')).toBe(true);
    expect(next.indexOf('#### QA capture')).toBeLessThan(next.indexOf('<!-- devkit:evidence:data'));
    expect(withQaSection(next, renderQaSection({ picks: [], notes: [] }, refs))).not.toContain(
      URL_A,
    );
  });

  it('reads and replaces only the QA section inside the block, never one pasted above it', () => {
    const block = `${EVIDENCE_BEGIN}\n#### Regression evidence\n${EVIDENCE_END}`;
    const real = withQaSection(`caller\n\n${block}\n`, renderQaSection(plan, refs));
    const pasted = renderQaSection({ picks: [], notes: ['pasted'] }, refs);
    const body = `${pasted}\n\n${real}`;
    expect(qaSectionOf(body)).toBe(qaSectionOf(real));
    const next = withQaSection(body, renderQaSection({ picks: [], notes: ['new'] }, refs));
    expect(next.startsWith(`${pasted}\n\n`)).toBe(true);
    expect(qaSectionOf(next)).toContain('new');
  });

  it('opens a block of its own (no regression heading) when the PR has none', () => {
    const next = withQaSection('caller text', renderQaSection(plan, refs));
    expect(next).toContain(EVIDENCE_BEGIN);
    expect(next).not.toContain('Regression evidence');
  });

  it('survives a re-render of the evidence block', () => {
    const block = `${EVIDENCE_BEGIN}\n#### Regression evidence\nold\n${EVIDENCE_END}`;
    const withQa = withQaSection(`caller\n\n${block}\n`, renderQaSection(plan, refs));
    const rerendered = replaceKeepingQa(withQa, block.replace('old', 'new'));
    expect(rerendered).toContain('new');
    expect(qaSectionOf(rerendered)).toBe(qaSectionOf(withQa));
  });
});
