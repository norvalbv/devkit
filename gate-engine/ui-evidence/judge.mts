/**
 * The model half of ui-evidence: one light-judge call over the staged diff asking whether a user
 * could see the change. Both verdicts are cached on the exact input, so ship after commit is free.
 */
import { createHash } from 'node:crypto';
import { verdictKey } from '../decisions/verdict-cache.mts';
import { emitCacheHit } from '../judge/gate-events.mts';
import { makeVerdictParser } from '../judge/factory.mts';
import { JUDGE_ISOLATION, JUDGE_READ_ONLY } from '../judge/judge-isolation.mts';
import { execJudge } from '../judge/run-judge.mts';
import { devkitDataFile, loadEntries, saveEntries } from '../judge/verdict-store.mts';

export const LABEL = 'ui-evidence';
const STORE_FILE = 'ui-evidence-verdict-cache.json';
/** A classifier needs the shape of the change, not every hunk. */
export const DIFF_CAP = 6000;
const WHY_CAP = 120;
/** Measured calls take 4-10 s; a hung model must not stall a commit for a reminder. */
export const JUDGE_TIMEOUT_MS = 30000;

export const UI_JUDGE_PROMPT = [
  'You classify a staged change (its file list, then its diff, on stdin) for a screenshot reminder.',
  'Answer VISIBLE if the change could alter what a user sees or can do on a rendered app screen (web, desktop or mobile): a rendered component, page, style, layout or copy, OR a backend, API, schema, serializer, formatter, i18n, theme or token change whose result a UI renders (a new response field shown on a page, a price or date format, an error message, a colour).',
  'Answer NONE if it cannot: internal refactors, infra, CI, build config, tests, fixtures, types, docs, telemetry, terminal or CLI output, logs, or tooling with no rendered screen, even under a UI-looking directory.',
  'Judge by what the diff does, not by file paths; the file list is complete, the diff may be cut short.',
  'Reply with exactly two lines: first VISIBLE or NONE, then one short clause saying what a user would see change (or why nothing).',
].join(' ');

const parse = makeVerdictParser(['VISIBLE', 'NONE'], {
  firstLineOnly: true,
});

export interface UiVerdict {
  visible: boolean;
  why: string;
}

/** The judge's reply as a verdict, or null when it names neither or both. */
export function parseUiVerdict(raw: string): UiVerdict | null {
  const verdict = parse(raw);
  if (!verdict) return null;
  const why = raw.trim().split('\n').slice(1).join(' ').trim().slice(0, WHY_CAP);
  return { visible: verdict === 'VISIBLE', why };
}

function callJudge(input: string, model: string, cwd: string, exec: typeof execJudge) {
  const raw = exec({
    label: LABEL,
    args: ['-p', '--model', model, ...JUDGE_READ_ONLY, ...JUDGE_ISOLATION, UI_JUDGE_PROMPT],
    input,
    timeout: JUDGE_TIMEOUT_MS,
    cwd,
  });
  return raw === null ? null : parseUiVerdict(raw);
}

/** Judge `input` through the cache; null (outage, unparseable reply) is never remembered. */
export function judgeUiVisible(
  cwd: string,
  input: string,
  model: string,
  exec = execJudge,
): UiVerdict | null {
  const file = devkitDataFile(cwd, STORE_FILE);
  const promptDigest = createHash('sha256').update(UI_JUDGE_PROMPT).digest('hex');
  const key = verdictKey(LABEL, model, promptDigest, input);
  const hit = loadEntries(file)[key];
  const cached = hit ? parseUiVerdict(`${hit.verdict}\n${hit.why}`) : null;
  if (cached) {
    emitCacheHit(LABEL, hit?.model, hit?.duration_ms);
    return cached;
  }
  const started = Date.now();
  const verdict = callJudge(input, model, cwd, exec);
  if (verdict) {
    const at = new Date().toISOString();
    const duration_ms = Date.now() - started;
    const word = verdict.visible ? 'VISIBLE' : 'NONE';
    saveEntries(file, {
      [key]: { at, verdict: word, why: verdict.why, model, duration_ms },
    });
  }
  return verdict;
}
