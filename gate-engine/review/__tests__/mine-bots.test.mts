import { describe, expect, it } from 'vitest';
import {
  categorize,
  classifyOutcome,
  computeScopeConfirmed,
  hasAddressedMarker,
  hasAuthorWithdrawal,
  hasHumanReply,
  hasWithdrawal,
  isBotLogin,
  isLineTouchedLater,
  isPathInFilesJson,
  parseCoderabbitMarker,
  sqlString,
} from '../eval/reviewers/mine-bots-lib.mts';

describe('mine-bots-lib: parseCoderabbitMarker', () => {
  it('extracts category and severity from a CodeRabbit tag line', () => {
    const body = '_Security_ | _🔴 Critical_\n\nThis concatenates user input into SQL.';
    expect(parseCoderabbitMarker(body)).toEqual({ crCategory: 'Security', crSeverity: 'Critical' });
  });

  it('handles the other severity emoji variants', () => {
    expect(parseCoderabbitMarker('_Performance_ | _🟡 Minor_')).toEqual({
      crCategory: 'Performance',
      crSeverity: 'Minor',
    });
    expect(parseCoderabbitMarker('_Style_ | _🔵 Nit_')).toEqual({
      crCategory: 'Style',
      crSeverity: 'Nit',
    });
    expect(parseCoderabbitMarker('_Bug_ | _🟠 Major_')).toEqual({
      crCategory: 'Bug',
      crSeverity: 'Major',
    });
  });

  it('returns nulls when no marker line is present', () => {
    expect(parseCoderabbitMarker('just a plain comment with no tag')).toEqual({
      crCategory: null,
      crSeverity: null,
    });
  });

  it('returns nulls for empty/undefined body', () => {
    expect(parseCoderabbitMarker('')).toEqual({ crCategory: null, crSeverity: null });
    expect(parseCoderabbitMarker(undefined)).toEqual({ crCategory: null, crSeverity: null });
  });

  it('strips stray emoji from the captured groups', () => {
    // Defensive: even if an emoji leaks into a captured group, it should not survive.
    expect(parseCoderabbitMarker('_Security ⚠️_ | _🔴 Critical_').crCategory).toBe('Security');
  });
});

describe('mine-bots-lib: hasAddressedMarker / hasWithdrawal / hasHumanReply', () => {
  it('detects the addressed marker in the own body', () => {
    expect(hasAddressedMarker(['review_comment_addressed by PR #12', 'unrelated'])).toBe(true);
  });

  it('detects the addressed marker in a reply', () => {
    expect(hasAddressedMarker(['original body', 'fixed! review_comment_addressed'])).toBe(true);
  });

  it('is false when no text contains the marker', () => {
    expect(hasAddressedMarker(['nope', 'still nope'])).toBe(false);
    expect(hasAddressedMarker([])).toBe(false);
  });

  it('detects a CodeRabbit withdrawal reply', () => {
    const replies = [
      { author: 'coderabbitai[bot]', body: "You're right, this doesn't apply here." },
    ];
    expect(hasWithdrawal(replies)).toBe(true);
  });

  it('ignores a withdrawal-shaped reply from a non-bot author', () => {
    const replies = [{ author: 'someone-else', body: 'you are right, withdrawing my objection' }];
    expect(hasWithdrawal(replies)).toBe(false);
  });

  it('does not match withdrawal for an unrelated bot reply', () => {
    const replies = [{ author: 'coderabbitai[bot]', body: 'Looks good, thanks!' }];
    expect(hasWithdrawal(replies)).toBe(false);
  });

  it('matches the "agreed—" / "agreed," / "agreed-" withdrawal forms', () => {
    expect(
      hasWithdrawal([{ author: 'coderabbitai[bot]', body: 'Agreed, closing this out.' }]),
    ).toBe(true);
    expect(hasWithdrawal([{ author: 'coderabbitai[bot]', body: 'Agreed—no action needed.' }])).toBe(
      true,
    );
  });

  it('detects a human reply among the thread replies', () => {
    const replies = [
      { author: 'coderabbitai[bot]', body: 'flagged' },
      { author: 'a-human-dev', body: 'fixed it' },
    ];
    expect(hasHumanReply(replies)).toBe(true);
  });

  it('is false when every reply is from a bot author', () => {
    const replies = [
      { author: 'coderabbitai[bot]', body: 'x' },
      { author: 'macroscopeapp[bot]', body: 'y' },
    ];
    expect(hasHumanReply(replies)).toBe(false);
    expect(hasHumanReply([])).toBe(false);
  });

  it('normalizes GraphQL (suffixless) and REST ([bot]) login forms', () => {
    // GraphQL thread-reply authors have NO [bot] suffix; REST comment authors do. The un-normalized
    // comparisons never matched GraphQL replies: bot-withdrawal never fired, and CodeRabbit's own
    // replies counted as human pushback (false 'human-rebuttal' outcomes).
    expect(isBotLogin('coderabbitai')).toBe(true);
    expect(isBotLogin('coderabbitai[bot]')).toBe(true);
    expect(isBotLogin('macroscopeapp')).toBe(true);
    expect(isBotLogin('norvalbv')).toBe(false);
    expect(hasWithdrawal([{ author: 'coderabbitai', body: 'Agreed, this does not apply.' }])).toBe(
      true,
    );
    expect(hasHumanReply([{ author: 'coderabbitai', body: 'analysis chain' }])).toBe(false);
    expect(hasHumanReply([{ author: 'a-human-dev', body: 'fixed' }])).toBe(true);
  });

  it('hasAuthorWithdrawal fires only on the comment author retracting their own concern', () => {
    const author = 'norvalbv';
    // The author themself withdrawing — the human analog of a bot withdrawal.
    expect(
      hasAuthorWithdrawal([{ author, body: "You're right, this does not apply here." }], author),
    ).toBe(true);
    // A withdrawal-shaped reply from someone ELSE is agreement/pushback, not a retraction.
    expect(
      hasAuthorWithdrawal([{ author: 'someone-else', body: 'Agreed, withdraw it.' }], author),
    ).toBe(false);
    // The author's ordinary follow-up is not a withdrawal.
    expect(
      hasAuthorWithdrawal([{ author, body: 'Bumping this — still needs the guard.' }], author),
    ).toBe(false);
    expect(hasAuthorWithdrawal([], author)).toBe(false);
  });
});

describe('mine-bots-lib: classifyOutcome priority order', () => {
  const base = {
    addressedMarker: false,
    withdrawal: false,
    threadResolved: false,
    threadOutdated: false,
    lineTouchedLater: false,
    hasHumanReply: false,
  };

  it('addressedMarker wins over every other signal', () => {
    expect(
      classifyOutcome({
        ...base,
        addressedMarker: true,
        withdrawal: true,
        threadResolved: true,
        threadOutdated: true,
        lineTouchedLater: true,
        hasHumanReply: true,
      }),
    ).toEqual({ outcome: 'fixed', outcomeEvidence: 'addressed-marker' });
  });

  it('withdrawal wins over thread/line signals when no addressed marker', () => {
    expect(
      classifyOutcome({
        ...base,
        withdrawal: true,
        threadResolved: true,
        lineTouchedLater: true,
        hasHumanReply: true,
      }),
    ).toEqual({ outcome: 'rebutted', outcomeEvidence: 'bot-withdrawal' });
  });

  it('resolved + line-touched → fixed/resolved+line-touched', () => {
    expect(classifyOutcome({ ...base, threadResolved: true, lineTouchedLater: true })).toEqual({
      outcome: 'fixed',
      outcomeEvidence: 'resolved+line-touched',
    });
  });

  it('resolved + human reply + NOT line-touched → rebutted/human-rebuttal', () => {
    expect(
      classifyOutcome({
        ...base,
        threadResolved: true,
        hasHumanReply: true,
        lineTouchedLater: false,
      }),
    ).toEqual({ outcome: 'rebutted', outcomeEvidence: 'human-rebuttal' });
  });

  it('resolved + line-touched beats resolved + human reply (line-touched checked first)', () => {
    expect(
      classifyOutcome({
        ...base,
        threadResolved: true,
        hasHumanReply: true,
        lineTouchedLater: true,
      }),
    ).toEqual({ outcome: 'fixed', outcomeEvidence: 'resolved+line-touched' });
  });

  it('outdated alone (no other signal) → unresolved/outdated-only', () => {
    expect(classifyOutcome({ ...base, threadOutdated: true })).toEqual({
      outcome: 'unresolved',
      outcomeEvidence: 'outdated-only',
    });
  });

  it('falls through to unresolved/null when nothing matched', () => {
    expect(classifyOutcome(base)).toEqual({ outcome: 'unresolved', outcomeEvidence: null });
  });

  it('unresolved, non-outdated thread with no other signal is also unresolved/null', () => {
    expect(classifyOutcome({ ...base, threadResolved: false, threadOutdated: false })).toEqual({
      outcome: 'unresolved',
      outcomeEvidence: null,
    });
  });
});

describe('mine-bots-lib: isLineTouchedLater', () => {
  it('is true when a later commit touches the comment path', () => {
    const commits = [
      { sha: 'a', committedDate: '2026-01-02T00:00:00Z', files: ['src/other.ts'] },
      { sha: 'b', committedDate: '2026-01-03T00:00:00Z', files: ['src/target.ts'] },
    ];
    expect(isLineTouchedLater(commits, 'src/target.ts', '2026-01-01T00:00:00Z')).toBe(true);
  });

  it('is false when the touching commit is BEFORE the comment', () => {
    const commits = [{ sha: 'a', committedDate: '2025-12-31T00:00:00Z', files: ['src/target.ts'] }];
    expect(isLineTouchedLater(commits, 'src/target.ts', '2026-01-01T00:00:00Z')).toBe(false);
  });

  it('is false when no later commit touches the path', () => {
    const commits = [{ sha: 'a', committedDate: '2026-01-05T00:00:00Z', files: ['src/other.ts'] }];
    expect(isLineTouchedLater(commits, 'src/target.ts', '2026-01-01T00:00:00Z')).toBe(false);
  });

  it('is false for an empty commit list', () => {
    expect(isLineTouchedLater([], 'src/target.ts', '2026-01-01T00:00:00Z')).toBe(false);
  });

  it('is false when the comment createdAt is unparseable', () => {
    const commits = [{ sha: 'a', committedDate: '2026-01-05T00:00:00Z', files: ['src/target.ts'] }];
    expect(isLineTouchedLater(commits, 'src/target.ts', 'not-a-date')).toBe(false);
  });
});

describe('mine-bots-lib: scope-membership decision', () => {
  it('isPathInFilesJson: true when the path is present', () => {
    expect(isPathInFilesJson('["a.ts","b.ts"]', 'a.ts')).toBe(true);
  });

  it('isPathInFilesJson: false when the path is absent', () => {
    expect(isPathInFilesJson('["a.ts","b.ts"]', 'c.ts')).toBe(false);
  });

  it('isPathInFilesJson: null for missing files_json', () => {
    expect(isPathInFilesJson(null, 'a.ts')).toBeNull();
    expect(isPathInFilesJson(undefined, 'a.ts')).toBeNull();
  });

  it('isPathInFilesJson: null for unparseable JSON', () => {
    expect(isPathInFilesJson('not json', 'a.ts')).toBeNull();
  });

  it('isPathInFilesJson: null when the parsed value is not an array', () => {
    expect(isPathInFilesJson('{"a":1}', 'a.ts')).toBeNull();
  });

  it('computeScopeConfirmed: confirmed when a reviewer scope contains the path', () => {
    const rows = [
      { reviewer: 'api-security', files_json: '["a.ts"]' },
      { reviewer: 'correctness', files_json: '["b.ts"]' },
    ];
    expect(computeScopeConfirmed(rows, 'a.ts')).toEqual({
      scopeConfirmed: 'confirmed',
      scopedReviewers: ['api-security'],
    });
  });

  it('computeScopeConfirmed: out-of-scope when rows exist but none cover the path', () => {
    const rows = [{ reviewer: 'api-security', files_json: '["b.ts","c.ts"]' }];
    expect(computeScopeConfirmed(rows, 'a.ts')).toEqual({
      scopeConfirmed: 'out-of-scope',
      scopedReviewers: [],
    });
  });

  it('computeScopeConfirmed: unverifiable when there are no rows at all', () => {
    expect(computeScopeConfirmed([], 'a.ts')).toEqual({
      scopeConfirmed: 'unverifiable',
      scopedReviewers: [],
    });
  });

  it('computeScopeConfirmed: unverifiable when every row has unparseable files_json', () => {
    const rows = [{ reviewer: 'api-security', files_json: null }];
    expect(computeScopeConfirmed(rows, 'a.ts')).toEqual({
      scopeConfirmed: 'unverifiable',
      scopedReviewers: [],
    });
  });

  it('computeScopeConfirmed: a parseable non-covering row plus an unparseable row is still out-of-scope', () => {
    const rows = [
      { reviewer: 'api-security', files_json: '["b.ts"]' },
      { reviewer: 'correctness', files_json: null },
    ];
    expect(computeScopeConfirmed(rows, 'a.ts')).toEqual({
      scopeConfirmed: 'out-of-scope',
      scopedReviewers: [],
    });
  });
});

describe('mine-bots-lib: categorize (legacy keyword field)', () => {
  it('picks security before performance when both keywords are present', () => {
    expect(categorize('this injection is also kind of slow')).toBe('security');
  });

  it('falls back to other when nothing matches', () => {
    expect(categorize('looks fine to me')).toBe('other');
  });
});

describe('mine-bots-lib: sqlString', () => {
  it('wraps a plain value in single quotes', () => {
    expect(sqlString('devkit')).toBe("'devkit'");
  });

  it('doubles embedded single quotes', () => {
    expect(sqlString("o'brien")).toBe("'o''brien'");
  });

  it('stringifies numbers', () => {
    expect(sqlString(42)).toBe("'42'");
  });
});
