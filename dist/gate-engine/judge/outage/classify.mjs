/** Why a judge spawn produced no verdict — the ONE classifier every judge-consuming gate reads.
 *  Unknown stays `transient`; Node's message is NEVER scanned (it renders the judge's own diff). */
import { codexFailure } from '../codex/result.mjs';
/** The execFile cap kill (SIGKILL, sc-1317) — the original outage a retry cannot fix.
 *  `killed` first; SIGTERM/ETIMEDOUT are fallbacks for platforms that report those instead. */
export function isJudgeTimeout(e) {
    return e.killed === true || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
}
/** Long enough for any real provider diagnostic; short enough that no regex here can be walked. */
const SCAN_CAP = 8192;
/** The provider's own sentence is the useful part of a warning; a transcript dump is not. */
const DETAIL_CAP = 200;
/** Quota exhaustion, verified against codex 0.152.0's live wording. A bare 401/429 status with no
 *  text is deliberately NOT matched: codex exits 1 for quota, so a code alone proves nothing. */
const RATE_LIMITED = /\b(?:usage limit|rate limit|rate-limit|quota (?:exceeded|exhausted)|too many requests|out of credits|credits? (?:depleted|exhausted))\b/i;
/** Logged-out / credential wordings. `invalid api key` covers the key-auth path both CLIs support. */
const UNAUTHENTICATED = /\b(?:not logged in|please log ?in|log ?in required|unauthenticated|invalid api key|authentication (?:failed|required)|session (?:has )?expired)\b/i;
/** `1st`/`2nd`/`8th` — `Date.parse` rejects an ordinal, and every provider writes them. */
const ORDINAL = /(\d{1,2})(?:st|nd|rd|th)\b/gi;
/** "try again at Sep 8th, 2026 3:38 PM" / "resets at …" / "retry after …". */
const RESET_PHRASE = /(?:try again|resets?|retry)\s+(?:at|on|after)\s+([^.\n]{4,60})/i;
/** The HTTP header, when a CLI passes it through verbatim. Seconds. */
const RETRY_AFTER_SECONDS = /retry-after:\s*(\d{1,7})\b/i;
/** A reset further out than this is a parse artifact, not a quota window. */
const MAX_AHEAD_MS = 400 * 24 * 60 * 60 * 1000;
/** Clock skew and the seconds between the provider writing the time and us parsing it. */
const MAX_BEHIND_MS = 5 * 60 * 1000;
/** The reset instant as epoch ms, or undefined. TOTAL: never throws, never invents a value — so
 *  narration cannot change a verdict (blocking-gates-narrate-attribution-never-depend-on-it). */
/** One plausibility window for both the text parser and the app-server reader, so neither can
 *  report a time the other would refuse — e.g. a seconds→ms unit change reading as a year-billion. */
export function plausibleReset(at, now = Date.now()) {
    if (!Number.isFinite(at))
        return false;
    if (at < now - MAX_BEHIND_MS)
        return false;
    return at - now <= MAX_AHEAD_MS;
}
export function parseResetTime(text, now = Date.now()) {
    if (!text)
        return undefined;
    const scanned = text.slice(0, SCAN_CAP);
    const afterMatch = RETRY_AFTER_SECONDS.exec(scanned);
    if (afterMatch) {
        const seconds = Number(afterMatch[1]);
        if (Number.isFinite(seconds) && seconds > 0) {
            const at = now + seconds * 1000;
            if (at - now <= MAX_AHEAD_MS)
                return at;
        }
    }
    const phraseMatch = RESET_PHRASE.exec(scanned);
    if (!phraseMatch)
        return undefined;
    // A trailing "to purchase more credits or try again at X" leaves X clean; ordinals are the only
    // routine token Date.parse refuses.
    const parsed = Date.parse(phraseMatch[1].replace(ORDINAL, '$1').trim());
    return plausibleReset(parsed, now) ? parsed : undefined;
}
/** "5d 19h" / "3h 20m" / "45m" / "under a minute" — what a reader actually needs from a reset. */
export function formatResetDelta(resetsAt, now = Date.now()) {
    const ms = resetsAt - now;
    // `<=` covers a reset already in the PAST too: a window that rolled while the report was being
    // built is "about to clear", never a negative or absurd duration.
    if (ms <= 60_000)
        return 'under a minute';
    const minutes = Math.round(ms / 60_000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0)
        return `${days}d ${hours % 24}h`;
    if (hours > 0)
        return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
}
/** SGR colour. FORCE_COLOR=1 is routine in CI, and an escape flush against the first letter kills
 *  every `\b` anchor — so strip rather than loosen. Char code: a literal ESC is a control char. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
/** A CLI USAGE error echoes the invocation, and a judge's argv carries `-p <prompt>` — i.e. the
 *  staged diff. Such a line is dropped, or rule 2 leaks back in through stderr. */
const ARGV_ECHO = /(^|\s)(-p|--model|--allowedTools|--append-system-prompt)(\s|=)/;
/** The provider's own words, bounded and de-coloured. Rule 2 lives here: `e.message` is NEVER
 *  read, and any stderr line echoing the argv is dropped for the same reason. */
function providerText(e) {
    const streamFailure = e.providerFailure ?? codexFailure(e.stdout ?? null) ?? '';
    const stderr = (e.stderr ?? '')
        .split('\n')
        .filter((line) => !ARGV_ECHO.test(line))
        .join('\n');
    return `${streamFailure}\n${stderr}`.slice(0, SCAN_CAP).replace(ANSI, '');
}
function firstSentence(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return undefined;
    return trimmed.length > DETAIL_CAP ? `${trimmed.slice(0, DETAIL_CAP).trimEnd()}…` : trimmed;
}
/** Classify one failed spawn. Order matters: a cap kill is decided before any provider text, so a
 *  judge killed mid-quota-warning still reads as a timeout — the remedy that actually works. */
export function classifyJudgeOutage(e) {
    if (isJudgeTimeout(e))
        return { kind: 'timeout', permanent: true };
    if (e.code === 'ENOENT')
        return { kind: 'absent', permanent: true };
    const text = providerText(e);
    if (RATE_LIMITED.test(text)) {
        const outage = {
            kind: 'rate-limited',
            permanent: true,
            detail: firstSentence(text),
        };
        // Assigned only when the provider actually named a time — an absent reset must stay absent, not
        // become a fabricated instant the remedy would then quote back as fact.
        const resetsAt = parseResetTime(text);
        if (resetsAt !== undefined)
            outage.resetsAt = resetsAt;
        return outage;
    }
    if (UNAUTHENTICATED.test(text))
        return { kind: 'unauthenticated', permanent: true, detail: firstSentence(text) };
    return { kind: 'transient', permanent: false, detail: firstSentence(text) };
}
