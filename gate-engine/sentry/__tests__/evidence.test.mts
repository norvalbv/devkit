// Unit tests for the sentry gate's deterministic evidence assembly (sc-1984): what the judge is shown,
// and — the part that carries blocking authority — whether the gate can PROVE it showed the capture
// that would have cleared the commit. Tables over repetition, matching the sibling gate test.

import { describe, expect, it, vi } from 'vitest';
import { diffCacheIdentity, hunkAnchor, renderSelection } from '../../judge/diff-focus.mts';
import { capturesHunk, captureSymbols } from '../capture-lexer.mts';
import {
  buildEvidence,
  captureInventory,
  degradeCause,
  evidenceSufficient,
  packSelection,
  renderInventory,
  selectSentryHunks,
  type SentryEvidence,
  TRUNCATION_MARKER,
} from '../evidence.mts';

const CAP = 6000;

/** One file segment with an explicit function context, so hunk anchors are realistic. */
const file = (path: string, body: string, fn = 'run()') =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -10,2 +10,3 @@ ${fn}`,
    body,
  ].join('\n');

describe('captureSymbols (the receiver rule)', () => {
  it.each([
    ['captureContained(err);', ['captureContained']], // the wrapper the old identifier list missed
    ['Sentry.captureException(e);', ['captureException']],
    ['await Sentry.captureMessage("x");', ['captureMessage']],
    ['captureMainMessage(msg);', ['captureMainMessage']],
    ['captureContained?.(err);', ['captureContained']], // an optional CALL is still a call
    ['captureContained!(err);', ['captureContained']], // …so is a non-null-asserted one
    ['Sentry.captureException!(err);', ['captureException']],
    ['const c = captureCount!;', []], // …but an assertion without parens is not a call
    ['const pattern = /captureContained(err)/;', []], // a regex literal is DATA…
    ["str.replace(/captureContained/g, '');", []],
    ['const ok = /x/.test(s) && captureContained(e);', ['captureContained']], // …beside a real call
    ['const half = total / 2;', []], // and division is not a literal
    ['const sink = new captureContained(err);', []], // CONSTRUCTING is not reporting
    ['const n = newCount; captureContained(err);', ['captureContained']], // …and `newCount` is not `new`
    ['function captureContained(err) {}', []], // DEFINING a wrapper is not calling one
    ['const captureContained = (e) => report(e);', []], // an arrow WRAPPER is a declaration…
    ['const captureContained = (error: unknown) => report(error);', []], // …typed or not
    ['export const captureContained = (e: E): void => { report(e); };', []],
    ['const captureContained = async (e) => report(e);', []],
    ['class R { captureContained(err) {} }', []], // …nor is method shorthand
    ['  captureContained(err: E): Promise<void> {', []], // …even behind a return type
    ['  captureContained(e: Error): void;', []], // …or with no body at all (an interface member)
    ['const x = cond ? captureContained(e) : other;', ['captureContained']], // a ternary still calls
    ['captureContained({ a: 1 });', ['captureContained']], // an object key is not a param annotation
    ['captureContained(x ? y : z);', ['captureContained']], // …nor is a ternary's colon
    ['  captureContained(e?: Error): void;', []], // …but an OPTIONAL param annotation still is
    ['const v = captureContained(e) ? a : b;', ['captureContained']], // a ternary is still a call
    ['  async captureContained(err) {', []],
    ['const o = { captureContained(e) { report(e); } };', []],
    ['if (captureContained(e)) { doWork(); }', ['captureContained']], // …but this one really calls it
    ['export async function captureContained(err) {}', []],
    ['function* captureContained(err) {}', []],
    ['captureContained<Error>(err);', ['captureContained']], // explicit type arguments
    ['captureContained<Map<string, number>>(err);', ['captureContained']], // …including nested ones
    ['captureContained<(e: Error) => void>(handler);', ['captureContained']], // …and function types
    ['const c = captureCount;', []], // a bare reference is not a call
    ['if (captureCount < x && y > (z)) {}', []], // …but a comparison is not a generic call
    ['if (captureCount<x && y>(z)) {}', []], // …even written without spaces
    ['captureContained<A & B>(err);', ['captureContained']], // a single & is a real intersection type
    ['Sentry.captureException?.(e);', ['captureException']],
    ['client?.captureException?.(e);', []], // …but the receiver rule still applies
    ['Error.captureStackTrace(this, MyError);', []], // idiomatic custom-error plumbing, not a capture
    ['captureStackTrace(this);', []], // denylisted even unqualified
    ['page.captureScreenshot();', []], // UI media capture
    ['this.captureException(e);', []], // a different object's method
    ['    #captureContained(err);', []], // a bare private name is a class member, never a wrapper
    ['  #captureContained(err) {}', []], // …and its declaration is not a call either
    ['this.#captureContained(err);', []], // …private or not
    ['this.#captureContained?.(err);', []],
    ['client?.captureException(err);', []], // optional chain — still someone else's method
    ['client!.captureException(err);', []], // non-null assertion — likewise
    ['a?.b?.captureException(err);', []], // deep optional chain
    ['getClient().captureException(err);', []], // a call-expression receiver
    ['arr[0].captureException(err);', []], // an indexed receiver
    ['obj.client.captureException(err);', []], // a member chain
    ['mySentry.captureException(err);', []], // a look-alike identifier, not Sentry
    ['Sentry?.captureException(err);', ['captureException']], // …but Sentry itself still counts
    ['await Sentry.captureException(err);', ['captureException']],
    ["log.warn('captureException missing here');", []], // a string literal is not a call
    ['doWork(); // captureContained(err)', []], // a TRAILING comment instruments nothing
    ['doWork(); /* captureContained(err) */', []], // …nor a trailing block comment
    ['/* captureContained(err) */ doWork();', []], // …nor a leading one
    ['captureContained(err); // instrument the fan-out', ['captureContained']], // the call is real
    ['const m = `captureContained(x)`;', []], // template TEXT is data…
    ['const m = `x ${captureContained(e)} y`;', ['captureContained']], // …its interpolation is code
    ['const m = `${{ a: 1 }.a ? captureContained(e) : 0}`;', ['captureContained']], // nested braces
    ['const m = `${cond ? captureContained(e) : fallback(x)}`;', ['captureContained']],
    ['const m = `a ${`captureContained(y)`} b`;', []],
    ['const x = `${`inner ${captureContained(e)}`}`;', ['captureContained']], // a nested INTERPOLATION
    ['const x = `${`outer ${`inner ${captureContained(e)}`}`}`;', ['captureContained']], // …at depth 3
    ['const x = `a ${`b ${captureContained(err)} c`} d`;', ['captureContained']], // …amid template text // a NESTED template\'s text is still data
    ["const x = `don't ${captureContained(e)} won't`;", ['captureContained']], // apostrophes in TEXT
    ['const m = `${/}/.test(x) && captureContained(e)}`;', ['captureContained']], // a regex in one
    ['const x = `${/* } */ captureContained(e)}`;', ['captureContained']], // a comment brace in one
    ['const x = `${1} captureContained(err)`;', []], // …but template TEXT after one is still data
    ['/* note */ captureContained(err);', ['captureContained']], // a block that closes, then code
    ['throw /captureContained(err)/;', []], // a regex may follow any expression-start keyword
    ['const score = weight * /captureContained(err)/.test(t);', []], // …including multiplication
    ['if (ok) /captureContained(err)/.test(s);', []], // …and a control-flow condition's `)`
    ['const ratio = count++ / captureContained(err);', ['captureContained']], // postfix `++` divides
    ['const ratio = {} / captureContained(err);', ['captureContained']], // an object literal is a VALUE
    ['const r = values[0] / captureContained(err);', ['captureContained']], // …so is an index
    ['const r = arr[i] / total; captureContained(e);', ['captureContained']], // …and it ends at the `;`
    ['const arr = [/captureContained(x)/];', []], // …but `[` still OPENS an expression
    ['function f() {} /captureContained(e)/.test(s);', []], // …a block brace still opens a regex
    ['const r = a + /captureContained(x)/.source;', []], // …but a single `+` still opens a regex
    ['const r = getCount() / total; captureContained(e);', ['captureContained']], // …but a CALL's is division
    ['if (ok) captureContained(err);', ['captureContained']], // the call after one still counts
    ['const half = total / 2; captureContained(e);', ['captureContained']], // division is not one
    ['throw captureContained(err);', ['captureContained']], // …but the call after one still counts
    ["const s = 'don\\'t call captureContained(err)';", []], // an ESCAPED quote must not end the span
    ['const s = "say \\"captureContained(err)\\" aloud";', []], // …in either quote style
    ['const x = "prefix\\\n captureContained(err)";', []], // …or across an escaped-newline continuation
    ['const captureExceptionRef = 1;', []], // no call parens
    ['captureContained(a); Sentry.captureException(b);', ['captureContained', 'captureException']],
  ])('captureSymbols(%j) → %j', (line, expected) => {
    expect(captureSymbols(line)).toEqual(expected);
  });

  it('is WIDER than diffCacheIdentity’s erasure matcher — the two must never be merged', () => {
    // The erasure matcher deletes a line from the verdict-cache key, so every match there can never
    // invalidate an earned verdict and it MUST stay conservative. A bare wrapper call is real logic to
    // the cache (it survives the identity) while being real evidence to the judge (it is selected).
    const diff = file('src/a.ts', '+  captureContained(err);');
    expect(capturesHunk(diff)).toBe(true);
    expect(diffCacheIdentity(diff)).toContain('captureContained');
    // …whereas a qualified, inert Sentry line IS erased from the identity (asserted alongside a real
    // change, since an all-sentry diff degrades to exact-bytes keying by design).
    const withReal = file('src/a.ts', '+  const x = 1;\n+  Sentry.captureException(err);');
    expect(diffCacheIdentity(withReal)).toContain('const x = 1');
    expect(diffCacheIdentity(withReal)).not.toContain('captureException');
  });
});

describe('capturesHunk (hunk-level relevance)', () => {
  it.each([
    ['+  captureContained(err);', true],
    ['-  Sentry.captureException(e);', true], // a REMOVED capture is still capture-relevant
    ['-  // captureContained(err)', false], // …but a removed COMMENT instruments nothing
    ['+  // captureException(e) later', false], // a comment instruments nothing
    ['+  Error.captureStackTrace(this, E);', false],
    ['+  const x = 1;', false],
  ])('capturesHunk(%j) → %j', (line, expected) => {
    expect(capturesHunk(`@@ -1,2 +1,3 @@ run()\n${line}`)).toBe(expected);
  });

  it('a removed capture inside a context-opened block comment is not a call', () => {
    // The pre-image is context PLUS removed lines: the opener usually sits on an unchanged line.
    expect(capturesHunk('@@ -1,6 +1,3 @@ run()\n   /*\n-  captureContained(err);\n   */')).toBe(
      false,
    );
  });

  it('a REMOVED call split across lines is still one call', () => {
    // Removed lines are their own image, so they are scanned together rather than one at a time.
    expect(capturesHunk('@@ -1,4 +1,2 @@ run()\n-  captureContained\n-    (err);')).toBe(true);
  });

  it('the @@ header’s function context is not a call site', () => {
    expect(capturesHunk('@@ -1,2 +1,3 @@ function captureThing() {\n+  const x = 1;')).toBe(false);
  });
});

describe('selectSentryHunks (the wrapper-capture hunk the old selector dropped)', () => {
  it('keeps a hunk whose ONLY signal is a project capture wrapper — the sc-1984 regression', () => {
    const out = renderSelection(
      selectSentryHunks(file('src/exec.ts', "+  captureContained('fan-out not-ok', code);")),
      'non-error',
    );
    expect(out).toContain('captureContained');
    expect(out).not.toContain('omitted');
  });

  it('still drops a look-alike (Error.captureStackTrace) as a distractor', () => {
    const out = renderSelection(
      selectSentryHunks(file('src/err.ts', '+  Error.captureStackTrace(this, MyError);')),
      'non-error',
    );
    expect(out).not.toContain('captureStackTrace');
    expect(out).toContain('non-error hunk(s) omitted');
  });
});

describe('captureInventory block-comment scan (a line-local check cannot see these)', () => {
  const seg = (body: string[]) =>
    [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,6 @@ run()',
      ...body,
    ].join('\n');
  const found = (body: string[]) => captureInventory(seg(body)).entries.length;

  it.each([
    [
      ['+  /*', '+  captureContained(err);', '+  */'],
      0,
      'a commented-out block instruments nothing',
    ],
    [['   /*', '+  captureContained(err);', '   */'], 0, 'the block may open on a CONTEXT line'],
    [['+  /* note */ captureContained(err);'], 1, 'a closed inline block leaves the real call'],
    [
      ['   /*', '   note', '   */', '+  captureContained(err);'],
      1,
      'and a closed block stops swallowing',
    ],
    [['-  /*', '+  captureContained(err);'], 1, 'a REMOVED line is not in the post-image'],
    [
      ['+  /*', '@@ -50,2 +50,3 @@ other()', '+  captureContained(err);'],
      1,
      'a new hunk resets the scan',
    ],
    [
      // The hunk window opens INSIDE a block comment the diff never shows starting. A `*/` before
      // any `/*` is the tell — without it the added line reads as executable code.
      ['+  captureContained(err);', '   */'],
      0,
      'a hunk that opens inside a pre-existing block comment',
    ],
    [
      ['+  captureContained(err);', '   /* a later comment */'],
      1,
      '…but a `/*` that opens AFTER does not backdate',
    ],
    [['+  captureContained', '+    (err);'], 1, 'a call split across lines is still one call'],
    [
      ['+  client', '+    .captureException(err);'],
      0,
      '…and a receiver split across lines still disqualifies it',
    ],
    [
      // The interpolation must keep its own line, or the entry is attributed to the context line the
      // template opened on and then discarded as unchanged.
      ['   const s = `header', '+  ${captureContained(err)}', '   footer`;'],
      1,
      'a capture added inside a MULTILINE template interpolation',
    ],
    [
      // The seed must read CODE, not raw text: `*/` inside a string is not a comment boundary, and
      // treating it as one blanks the rest of the hunk and hides a real capture.
      ['   const marker = "*/";', '+  captureContained(err);'],
      1,
      'a string containing a block terminator is not a block terminator',
    ],
    [
      [`   const files = glob('**/*.ts');`, '+  captureContained(err);'],
      1,
      '…nor is a glob pattern',
    ],
    [
      ['   const re = /ab*/;', '+  captureContained(err);'],
      1,
      '…nor a regex literal whose text happens to end in a block terminator',
    ],
    [
      // A template can span lines, so its TEXT can look like code on every line but the first.
      ['+  const s = `', '+  captureContained(err);', '+  `;'],
      0,
      'a MULTILINE template’s text is data on every one of its lines',
    ],
    [
      ['+  const s = `x`;', '+  captureContained(err);'],
      1,
      '…and a closed template does not swallow what follows',
    ],
    [
      ['   const half = total / 2;', '+  captureContained(err);'],
      1,
      'and plain division is not mistaken for a regex literal',
    ],
  ])('%# → %i entries — %s', (body, expected) => {
    expect(found(body)).toBe(expected);
  });
});

describe('captureInventory (surface-bound ground truth over the WHOLE diff)', () => {
  it('names each added capture by file + hunk anchor', () => {
    const inv = captureInventory(
      file('src/exec.ts', '+  captureContained(err);', 'async fanOut()'),
    );
    expect(inv.ok).toBe(true);
    expect(inv.entries).toEqual(['src/exec.ts:async fanOut() — captureContained']);
  });

  it.each([
    ['-  captureContained(err);', 'a REMOVED capture is not an added one'],
    ['   captureContained(err);', 'a context-line capture predates this commit'],
    ['+  // captureContained(err);', 'a commented capture instruments nothing'],
    ['+  log.warn("captureContained");', 'a string literal is not a call'],
  ])('excludes %j — %s', (body) => {
    expect(captureInventory(file('src/a.ts', body)).entries).toEqual([]);
  });

  it('excludes test files: asserting a capture is evidence about the TEST, not the surface', () => {
    expect(
      captureInventory(file('src/__tests__/a.test.ts', '+  captureContained(e);')).entries,
    ).toEqual([]);
  });

  it('renders with the not-a-blanket-proof label so a capture ELSEWHERE cannot clear another surface', () => {
    const diff = `${file('src/cap.ts', '+  captureContained(err);', 'sendReport()')}\n${file('src/swallow.ts', '+  catch (e) { log.warn(e); }', 'saveDraft()')}`;
    const text = renderInventory(captureInventory(diff));
    expect(text).toContain('src/cap.ts:sendReport() — captureContained');
    expect(text).not.toContain('src/swallow.ts'); // the un-instrumented surface is NOT listed
    expect(text).toContain('does NOT instrument a different surface');
  });

  it('empty when the commit adds no capture at all', () => {
    expect(renderInventory(captureInventory(file('src/a.ts', '+  const x = 1;')))).toBe('');
  });
});

describe('packSelection (capture-priority, whole-hunk, cap-aware)', () => {
  const bulk = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `+  } catch (e${i}) { log.warn('swallow ${'x'.repeat(80)}'); }`,
    );

  /** Many swallow hunks, then ONE capture hunk last — the shape the blind slice used to decapitate. */
  const overCapDiff = (captureLast = true) => {
    const hunks = bulk(60).map(
      (line, i) => `@@ -${i * 10},2 +${i * 10},3 @@ handler${i}()\n${line}`,
    );
    if (captureLast) hunks.push('@@ -900,2 +900,3 @@ fanOut()\n+  captureContained(err);');
    return `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n${hunks.join('\n')}`;
  };

  it('keeps the LAST capture hunk when the cap bites, and says what it dropped', () => {
    const packed = packSelection(selectSentryHunks(overCapDiff()), CAP, 'non-error');
    expect(packed.text.length).toBeLessThanOrEqual(CAP);
    expect(packed.text).toContain('captureContained'); // survived — the whole point of sc-1984
    expect(packed.droppedByCap).toBeGreaterThan(0);
    expect(packed.text).toContain('dropped by the evidence cap'); // never a silent absence
    expect(packed.capturesComplete).toBe(true);
  });

  it('an over-cap commit whose capture evidence is COMPLETE keeps its hard block', () => {
    // The discriminator against a blanket degrade-on-truncation: this commit is big AND fully
    // evidenced, which is exactly where a real un-instrumented swallow is most likely to hide.
    const packed = packSelection(selectSentryHunks(overCapDiff()), CAP, 'non-error');
    expect(evidenceSufficient(packed, captureInventory(overCapDiff()))).toBe(true);
  });

  it('leaves a fitting diff byte-identical to a plain render (no reshape when the cap is slack)', () => {
    const sel = selectSentryHunks(file('src/a.ts', '+  catch (e) { log.warn(e); }'));
    const packed = packSelection(sel, CAP, 'non-error');
    expect(packed.text).toBe(renderSelection(sel, 'non-error'));
    expect(packed.droppedByCap).toBe(0);
    expect(packed.capturesComplete).toBe(true);
  });

  it('never drops the LAST hunk: a single oversized hunk is char-sliced, not erased', () => {
    const huge = `@@ -1,2 +1,3 @@ run()\n${bulk(200).join('\n')}`;
    const diff = `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n${huge}`;
    const packed = packSelection(selectSentryHunks(diff), CAP, 'non-error');
    expect(packed.text).toContain('catch'); // evidence, not an empty header
    expect(packed.text).toContain(TRUNCATION_MARKER);
    expect(packed.capturesComplete).toBe(false); // …but not BLOCKING evidence
    expect(evidenceSufficient(packed, captureInventory(diff))).toBe(false);
  });

  it('zero relevant hunks → nothing to block on (the dominant sc-1984 path)', () => {
    const packed = packSelection(
      selectSentryHunks(file('src/ui.tsx', '+  <span />')),
      CAP,
      'non-error',
    );
    expect(packed.keptCount).toBe(0);
    expect(evidenceSufficient(packed, { entries: [], extra: 0, ok: true })).toBe(false);
  });
});

describe('buildEvidence + degradeCause (the blocking floor)', () => {
  it('a wrapper-capture commit is sufficient and carries its inventory', () => {
    const ev = buildEvidence(file('src/exec.ts', '+  captureContained(err);', 'fanOut()'));
    expect(ev.sufficient).toBe(true);
    expect(ev.exempt).toBe(false);
    expect(ev.inventory.entries).toEqual(['src/exec.ts:fanOut() — captureContained']);
  });

  it('GUARD_SENTRY_DIFF_FULL waives the floor (the documented A/B escape hatch)', () => {
    vi.stubEnv('GUARD_SENTRY_DIFF_FULL', '1');
    try {
      const ev = buildEvidence(file('src/ui.tsx', `+  ${'x'.repeat(CAP + 100)}`));
      expect(ev.exempt).toBe(true);
      expect(ev.sufficient).toBe(true); // the owner asked for the raw diff; the block is theirs to keep
      expect(ev.packed.text).toContain(TRUNCATION_MARKER);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  const degraded = (inventoryOk: boolean, keptCount: number): SentryEvidence => ({
    packed: { text: '', capturesComplete: false, droppedByCap: 1, keptCount },
    inventory: { entries: [], extra: 0, ok: inventoryOk },
    sufficient: false,
    exempt: false,
  });

  it.each([
    [null, 'empty staged diff'],
    [degraded(false, 1), 'inventory could not be computed'],
    [degraded(true, 0), 'no error-handling hunk'],
    [degraded(true, 2), 'did not fit the evidence cap'],
  ])('degradeCause names the cause for telemetry (%#)', (evidence, expected) => {
    expect(degradeCause(evidence)).toContain(expected);
  });
});

describe('the cap note never overclaims (what the judge is told about what went)', () => {
  const swallow = (i: number) =>
    `@@ -${i * 10},2 +${i * 10},3 @@ handler${i}()\n+  } catch (e${i}) { log.warn('${'x'.repeat(90)}'); }`;
  const many = (n: number, tail: string[] = []) =>
    `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n${[
      ...Array.from({ length: n }, (_, i) => swallow(i)),
      ...tail,
    ].join('\n')}`;

  it('says the captures are all still shown while only non-capture hunks have gone', () => {
    const diff = many(60, ['@@ -900,2 +900,3 @@ fanOut()\n+  captureContained(err);']);
    const packed = packSelection(selectSentryHunks(diff), CAP, 'non-error');
    expect(packed.capturesComplete).toBe(true);
    expect(packed.text).toContain('every capture this commit adds is still shown below');
  });

  it('flips to the fail-safe instruction once a CAPTURE hunk itself is cut', () => {
    // Enough capture hunks that they cannot all fit: the packer drops the later ones, and the note
    // must stop reading as reassurance — the original truncation fail-safe's warning takes over.
    const captures = Array.from(
      { length: 80 },
      (_, i) =>
        `@@ -${1000 + i * 10},2 +${1000 + i * 10},3 @@ send${i}()\n+  captureContained('${'y'.repeat(90)}');`,
    );
    const packed = packSelection(selectSentryHunks(many(0, captures)), CAP, 'non-error');
    expect(packed.capturesComplete).toBe(false);
    expect(packed.text).toContain('do NOT infer SKIP or MONITOR from a capture missing here');
    expect(evidenceSufficient(packed, captureInventory(many(0, captures)))).toBe(false);
  });
});

describe('real-world diff shapes the fixtures never modelled', () => {
  // `git diff --cached` on Windows with core.autocrlf=true emits CRLF. Every line then carries a
  // trailing \r, which lands INSIDE a hunk anchor — polluting the judge payload with a control
  // character and splitting the inventory's dedup key (`fanOut()\r` vs `fanOut()`).
  it('CRLF (Windows core.autocrlf) leaves no carriage return in an anchor or inventory entry', () => {
    const crlf = file('src/exec.ts', '+  captureContained(err);', 'async fanOut()').replace(
      /\n/g,
      '\r\n',
    );
    expect(hunkAnchor('@@ -10,2 +10,3 @@ async fanOut()\r')).toBe('async fanOut()');
    const inv = captureInventory(crlf);
    expect(inv.entries).toEqual(['src/exec.ts:async fanOut() — captureContained']);
    expect(inv.entries.join()).not.toContain('\r');
    expect(selectSentryHunks(crlf).kept).toHaveLength(1); // the hunk is still selected
  });

  it.each([
    [
      'binary',
      'diff --git a/img.png b/img.png\nindex 111..222 100644\nBinary files a/img.png and b/img.png differ',
    ],
    [
      'rename-only',
      'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts',
    ],
    ['mode-only', 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755'],
  ])('a hunk-less %s segment is listed but never selected or inventoried', (_name, seg) => {
    const sel = selectSentryHunks(`${seg}\n${file('src/a.ts', '+  catch (e) {}')}`);
    expect(sel.files.length).toBe(2); // the judge still sees the commit's shape…
    expect(sel.kept).toHaveLength(1); // …but only the real error hunk is evidence
    expect(sel.omitted).toBe(0); // a hunk-less segment is not a REJECTED hunk
    expect(captureInventory(seg)).toEqual({ entries: [], extra: 0, ok: true });
  });

  it('a deleted file (+++ /dev/null) contributes no added capture', () => {
    const del =
      'diff --git a/src/gone.ts b/src/gone.ts\n--- a/src/gone.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@ run()\n-  captureContained(e);';
    expect(captureInventory(del).entries).toEqual([]);
    expect(selectSentryHunks(del).files).toEqual(['src/gone.ts']); // named via the a-side fallback
  });
});

describe('the blocking floor does not depend on the lexer being complete', () => {
  // Every lexical subtlety found in review (optional chains, escaped quotes, nested braces, regex
  // literals inside interpolations) has the SAME consequence: a capture the lexer cannot see lets a
  // capture-bearing hunk be cap-dropped while `capturesComplete` stays true, so the gate hard-blocks
  // on evidence it never showed. The floor therefore asks a deliberately dumb question of raw text —
  // could this hunk carry a capture at all — which no lexer gap can answer wrongly in the unsafe
  // direction.
  const noise = (i: number) =>
    `@@ -${i * 10},2 +${i * 10},3 @@ h${i}()\n+  } catch (e) { log.warn('${'x'.repeat(90)}'); }`;
  const withTail = (tail: string) =>
    `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n${[
      ...Array.from({ length: 60 }, (_, i) => noise(i)),
      `@@ -900,2 +900,3 @@ send()\n${tail}`,
    ].join('\n')}`;

  it.each([
    ['a plainly lexable capture', '+  captureContained(err);'],
    [
      'a capture the lexer cannot parse',
      '+  const m = `${/}/.test(x) ? captureContained(err) : 0}`;',
    ],
    [
      'a capture inside an unparsed shape',
      '+  const f = () => /}{/.test(s) && captureContained(e);',
    ],
  ])('%s is either shown to the judge or costs the run its block — %#', (_name, tail) => {
    const evidence = buildEvidence(withTail(tail));
    const shown = evidence.packed.text.includes('captureContained');
    // Exactly one of these may hold: the judge saw the capture, or the gate gave up blocking.
    expect(shown || !evidence.sufficient).toBe(true);
    if (!shown) expect(degradeCause(evidence)).toBeTruthy();
  });

  it('two hunks with IDENTICAL capture text: showing one does not vouch for the other', () => {
    // A presence test (`shown.includes(line)`) cannot tell two identical lines apart, so a dropped
    // hunk borrowed the proof of the one that survived. The floor counts instead.
    const dup = '+  captureContained(err);';
    const diff = `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n${[
      `@@ -1,2 +1,3 @@ first()\n${dup}`,
      ...Array.from({ length: 60 }, (_, i) => noise(i)),
      `@@ -900,2 +900,3 @@ second()\n${dup}`,
    ].join('\n')}`;
    const evidence = buildEvidence(diff);
    const shownTwice = evidence.packed.text.split('captureContained').length - 1 >= 2;
    expect(shownTwice || !evidence.sufficient).toBe(true);
  });
});

describe('boundaries', () => {
  const sel = () => selectSentryHunks(file('src/a.ts', '+  catch (e) { log.warn(e); }'));

  it.each([0, -1, Number.NaN])('a non-positive cap (%j) never GROWS the payload', (cap) => {
    // `slice(0, -1)` keeps everything but the last char and then appends the marker, so a negative
    // budget produced output LONGER than the input it was meant to bound. The cap is a module
    // constant today, but the repo is moving judge caps into resolvable config (sc-2107), so a bad
    // value must clamp rather than invert.
    const unbounded = packSelection(sel(), Number.MAX_SAFE_INTEGER, 'non-error');
    const packed = packSelection(sel(), cap, 'non-error');
    expect(packed.text.length).toBeLessThan(unbounded.text.length + TRUNCATION_MARKER.length);
    expect(packed.capturesComplete).toBe(false); // nothing was shown → nothing may block
    expect(packed.text).toContain(TRUNCATION_MARKER);
  });

  it('an effectively unbounded cap returns the plain render, uncut', () => {
    const packed = packSelection(sel(), Number.MAX_SAFE_INTEGER, 'non-error');
    expect(packed.text).not.toContain(TRUNCATION_MARKER);
    expect(packed.capturesComplete).toBe(true);
    expect(packed.droppedByCap).toBe(0);
  });

  it.each([
    [40, 40, 0], // exactly at the display cap — nothing is "more"
    [41, 40, 1], // one past it
  ])('an inventory of %i captures shows %i entries and counts %i extra', (n, shown, extra) => {
    const hunks = Array.from(
      { length: n },
      (_, i) => `@@ -${i * 10},2 +${i * 10},3 @@ fn${i}()\n+  captureContained(e${i});`,
    ).join('\n');
    const inv = captureInventory(
      `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n${hunks}`,
    );
    expect(inv.entries).toHaveLength(shown);
    expect(inv.extra).toBe(extra);
    expect(renderInventory(inv).endsWith(`… and ${extra} more`)).toBe(extra > 0);
  });
});
