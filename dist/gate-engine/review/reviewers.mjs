/**
 * Pure logic for the review gate (guard-review) — no fs/git/claude I/O, so every rule here is
 * unit-testable: the reviewer table, domain selection, prompt wrapping, verdict parsing, tool
 * allowlists and cache keys. Orchestration (spawning judges, git, the cache file) lives in
 * run-review.mjs / cache.mjs.
 *
 * The reviewer TABLE is the generator and ships here; the PATHS it triggers on are consumer data
 * (guard.config.json `review.backendRoots` / `review.frontendRoots` / `scanRoots`) — ship the
 * generator, never the data.
 */
import { createHash } from 'node:crypto';
import { normalizeReviewRoots } from '../../skills/_devkit/review-roots.mjs';
import { sourceMatchers } from "../config.mjs";
/** Type guard: does this REVIEWERS entry use the checklist workflow? Skill-less reviewers (e.g.
 * conventions-reviewer) don't — see Reviewer.skill docstring. */
export function hasChecklist(reviewer) {
    return reviewer.skill !== undefined;
}
/**
 * The domain reviewers the gate can run, in display order. `domain` picks which config roots
 * trigger the reviewer; commit-guard additionally gets the consumer's semantic search tool
 * (its brief is duplicate-detection — Read/Grep alone cannot see semantic twins).
 *
 * `skill`/`stateFile`/`cmds` bind each reviewer to its CHECKLIST workflow (the synced
 * `.claude/skills/<skill>/scripts/checklist.mjs`): the script deterministically enumerates
 * review items (per staged FILE for commit-guard, per detected pattern CATEGORY for the domain
 * reviewers) and its finalize refuses pending items — the benchmarked mechanism that stops a
 * reviewer from hallucinating coverage. The judge RUNS that workflow; the gate then verifies
 * the state-file artifact independently (verifyChecklist) so a skipped checklist can never PASS.
 */
export const REVIEWERS = Object.freeze([
    Object.freeze({
        name: 'api-security-reviewer',
        domain: 'backend',
        skill: 'api-security',
        stateFile: '.claude/.api-security-review.json',
        cmds: Object.freeze({ gen: 'generate', check: 'check-item' }),
    }),
    Object.freeze({
        name: 'backend-performance-reviewer',
        domain: 'backend',
        skill: 'backend-performance',
        stateFile: '.claude/.backend-performance-review.json',
        cmds: Object.freeze({ gen: 'generate', check: 'check-item' }),
    }),
    Object.freeze({
        name: 'frontend-security-reviewer',
        domain: 'frontend',
        skill: 'frontend-security',
        stateFile: '.claude/.frontend-security-review.json',
        cmds: Object.freeze({ gen: 'generate', check: 'check-item' }),
    }),
    Object.freeze({
        name: 'frontend-performance-reviewer',
        domain: 'frontend',
        skill: 'frontend-performance',
        stateFile: '.claude/.frontend-performance-review.json',
        cmds: Object.freeze({ gen: 'generate', check: 'check-item' }),
    }),
    Object.freeze({
        name: 'commit-guard',
        domain: 'code',
        skill: 'commit-guard',
        stateFile: '.claude/.pre-commit-review.json',
        cmds: Object.freeze({ gen: 'init', check: 'check-file' }),
    }),
    // Correctness is NOT domain-sliceable: a writer in a backend root and its reader in a frontend
    // root are ONE finding, so this reviewer sees SOURCE files across the UNION of declared roots.
    // Four ALWAYS-ON lenses — a correctness bug has no reliable lexical signature, so a regex gate
    // would blind exactly the class this reviewer exists to catch. Runs SINGLE-PASS at a pinned
    // model (see `model` below and the Reviewer.model docstring) — no haiku→opus cascade: the
    // escalation was bench-measured to OVERTURN real correctness bugs, so its FAIL blocks directly.
    Object.freeze({
        name: 'correctness-reviewer',
        domain: 'all',
        skill: 'correctness',
        stateFile: '.claude/.correctness-review.json',
        cmds: Object.freeze({ gen: 'generate', check: 'check-item' }),
        // Single-pass at the pinned model (see Reviewer.model). Measured on the 66-row corpus
        // (K=1, tripwire — wide CIs): haiku recall 0.76 / clean-pass 0.86 · sonnet recall 0.92 /
        // clean-pass 0.86. The earlier "precision 1.00 / perfect domain-exclusivity" was a 42-row
        // artifact: the extended corpus surfaces ~4 false-blocks (cross-domain security/perf leak +
        // broadcast/classifier surface-cue) that are MODEL-INVARIANT — precision is a DESIGN problem,
        // not a bigger-model problem. Recall DOES scale with model (0.76→0.92), so the finder runs sonnet
        // (K=1 evidence; a confirming flip-table run is still owed). Cross-domain false-blocks are caught
        // downstream by domainExclusivityDrop; the in-domain surface-cue ones want K-sample
        // self-consistency (Wang 2203.11171), NOT a same-family refute pass (it overturned real FAILs
        // here, 0.78→0.67; Huang 2310.01798). Precision ~0.95 is unmeasurable until the decoy corpus grows.
        model: 'sonnet',
    }),
    // Checks a diff against the CONSUMER repo's own written CLAUDE.md rules — never devkit's own.
    // SKILL-LESS (no skill/stateFile/cmds — see Reviewer.skill docstring): its AC forbids Bash
    // entirely (Read/Grep/Glob only), so it cannot run the checklist.mjs workflow every other entry
    // depends on. Its anti-hallucination substitute is the AC's own contract: flag a violation ONLY
    // when it can quote both the exact rule and the exact offending line, else stay silent — no
    // artifact to verify, so a PASS is trusted directly (cascadeVerdict/runCascade branch on
    // `!reviewer.skill`). `domain: 'conventions'` reuses the 'all' root union (rootsFor) but is
    // exempt from selectReviewers' isSource/isTest filters — a CLAUDE.md rule can govern any staged
    // file type (docs, config, tests), not just source. Single-pass haiku per the ticket mandate: no
    // cascade, FAIL blocks directly, and joins the override valve (overrides.mts) like correctness.
    Object.freeze({
        name: 'conventions-reviewer',
        domain: 'conventions',
        model: 'haiku',
    }),
]);
// Synced-skill layout is devkit's own convention (sync-skills targets .claude/skills), so the
// checklist script path is fixed relative to the consumer root — unlike scan/review ROOTS,
// which are consumer data and come from guard.config.json.
export const checklistAssetPath = (reviewer) => `skills/${reviewer.skill}/scripts/checklist.mjs`;
export const checklistScript = (reviewer) => `.claude/${checklistAssetPath(reviewer)}`;
/** Review invocations may supply a short isolated runtime containing Devkit's CURRENT packaged
 * assets. Normal commit/ship calls keep the synced consumer path. */
export function checklistScriptAt(reviewer, assetRoot = '.claude') {
    return `${assetRoot.replace(TRAILING_SLASH_RE, '')}/${checklistAssetPath(reviewer)}`;
}
// Read-only investigation surface (mirrors check-alignment's JUDGE_TOOLS + log/status for context).
// No naked Bash: a gate judge must never be able to write, stage, or commit.
const BASE_TOOLS = 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*)';
// Tolerates markdown dressing around the verdict line; the LAST match wins (the body may discuss
// pass/fail while reasoning). Deliberately NO bare-word fallback — unlike ALIGN/CONTRADICT,
// "pass"/"fail" saturate ordinary review prose, so a missing VERDICT line must read as "no
// verdict" (null → no block, no cache), never be guessed from body words.
const VERDICT_LINE_RE = /^[\s*#>-]*VERDICT:\s*\**\s*(PASS|FAIL)\b\**\s*(?:[—–:-]+\s*)?(.*)$/gim;
// Leading YAML frontmatter (the agent .md header is Task-tool metadata, not brief).
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;
const TRAILING_SLASH_RE = /\/$/;
/** The config roots that trigger a reviewer's domain. */
export function rootsFor(reviewer, cfg) {
    if (reviewer.domain === 'backend')
        return cfg.review.backendRoots;
    if (reviewer.domain === 'frontend')
        return cfg.review.frontendRoots;
    // `all` = the deduped union of every DECLARED root (scan + backend + frontend) — never `['.']`:
    // undeclared trees (vendored code, scripts) are outside the consumer's stated review surface.
    // `conventions` shares this union (a CLAUDE.md rule anywhere in the declared surface is fair
    // game) but — unlike `all` — is never filtered to source-only in selectReviewers below.
    if (reviewer.domain === 'all' || reviewer.domain === 'conventions')
        return [
            ...new Set([...cfg.scanRoots, ...cfg.review.backendRoots, ...cfg.review.frontendRoots]),
        ];
    return cfg.scanRoots;
}
function underRoot(file, root) {
    const r = root.endsWith('/') ? root.slice(0, -1) : root;
    if (r === '.')
        return true;
    return file === r || file.startsWith(`${r}/`);
}
// Mirrors the prose exclusion inside each skill's checklist.mjs getStagedFiles — the two lists
// must agree or a prose-only selection strands the judge with an empty checklist.
const RE_PROSE_FILE = /\.(md|mdx|markdown|txt)$/i;
/**
 * Which reviewers must run for this staged set → [{reviewer, files}]. Backend/frontend trigger on
 * ANY staged file under their roots (matching the old husky HAS_BACKEND/HAS_FRONTEND semantics);
 * commit-guard triggers only on source files under scanRoots (its brief is code duplication —
 * a staged JSON or doc under src/ is not its business). Empty roots (e.g. a repo with no
 * configured frontend) simply never select that domain.
 */
export function selectReviewers(stagedFiles, cfg) {
    const { isSource, isTest } = sourceMatchers(cfg.sourceExtensions);
    return REVIEWERS.map((reviewer) => {
        const roots = rootsFor(reviewer, cfg);
        let files = stagedFiles.filter((f) => roots.some((r) => underRoot(f, r)));
        // Backend/frontend judges read code diffs, and their checklist scripts skip prose files
        // outright — selecting a reviewer for a prose-only diff strands its judge with an empty
        // checklist (scored inconclusive, fail-closed under ship). Keep selection and script agreed.
        if (reviewer.domain === 'backend' || reviewer.domain === 'frontend')
            files = files.filter((f) => !RE_PROSE_FILE.test(f));
        // code + all trigger only on SOURCE files: a staged JSON/doc is neither a duplication nor a
        // correctness concern.
        if (reviewer.domain === 'code' || reviewer.domain === 'all')
            files = files.filter((f) => isSource(f.split('/').pop() ?? ''));
        // The correctness charter is RUNTIME defects — a test-only hunk cannot introduce one, and
        // test files are ~half a branch diff's bytes: excluding them keeps the judge inside its
        // timeout on a ship-sized diff. Test adequacy is the testing reviewer's charter.
        if (reviewer.domain === 'all')
            files = files.filter((f) => !isTest(f.split('/').pop() ?? ''));
        return { reviewer, files };
    }).filter((s) => s.files.length > 0);
}
/**
 * Comma-joined --allowedTools value for one reviewer: the read-only base, PLUS its own checklist
 * script (the one non-git Bash prefix a judge gets — scoped to that exact script path, so the
 * judge can drive its checklist but still cannot write files, stage, or commit), PLUS the
 * consumer's semantic search tool for commit-guard.
 */
export function allowedToolsFor(reviewer, cfg, assetRoot = '.claude') {
    // A skill-less reviewer (e.g. conventions-reviewer) has no checklist script to grant Bash for,
    // and its AC forbids Bash entirely — Read/Grep/Glob only, full stop, no BASE_TOOLS git-diff Bash
    // either (its evidence is pre-rendered onto stdin/prompt instead — see wrapConventionsPrompt).
    if (!hasChecklist(reviewer))
        return 'Read,Grep,Glob';
    const tools = `${BASE_TOOLS},Bash(node ${checklistScriptAt(reviewer, assetRoot)}:*)`;
    if (reviewer.domain === 'code')
        return `${tools},${cfg.searchTool}`;
    // The correctness reviewer's writer/reader-contract lens benefits from semantic search, but
    // only when the consumer actually wired an index (indexPath set) — otherwise cfg.searchTool is
    // a generic default naming an MCP tool the judge doesn't have, and Grep is the core mechanism.
    if (reviewer.domain === 'all' && cfg.indexPath)
        return `${tools},${cfg.searchTool}`;
    return tools;
}
/** Strip a leading YAML frontmatter block from an agent .md. */
export function stripFrontmatter(md) {
    const m = String(md).match(FRONTMATTER_RE);
    return m ? md.slice(m[0].length) : String(md);
}
/**
 * Wrap an interactive reviewer brief for headless gate use. The same Devkit-owned .md serves both
 * surfaces: interactively the root agent dispatches its synced copy; review mode uses the current
 * packaged copy. In the gate this
 * preamble re-scopes it (staged-only, checklist-driven, no marker/approve machinery) and the
 * postamble pins the machine-parseable verdict line.
 */
export function wrapPrompt(agentBody, reviewer, files, assetRoot, checklistRecoveryReason) {
    const effectiveAssetRoot = assetRoot ?? '.claude';
    const brief = stripFrontmatter(agentBody).replaceAll('.claude/skills/', `${effectiveAssetRoot.replace(TRAILING_SLASH_RE, '')}/skills/`);
    const script = checklistScriptAt(reviewer, effectiveAssetRoot);
    const checklistContract = assetRoot
        ? 'The reviewer brief owns checklist enumeration and the exact generate/check/finalize commands. That workflow is mandatory and its resulting artifact is independently verified by the gate.\n'
        : 'MANDATORY CHECKLIST WORKFLOW — this stops coverage hallucination and is independently verified:\n' +
            `1. \`node ${script} ${reviewer.cmds.gen}\` — enumerates the review items for this diff.\n` +
            `2. Review each item against the brief, then mark it: \`node ${script} ${reviewer.cmds.check} <name> --pass\` or \`--fail "<reason>"\`. Every item, one at a time — no batch claims.\n` +
            `3. \`node ${script} finalize\` — refuses if any item is unresolved.\n`;
    return ('You are running as an automated HEADLESS COMMIT GATE, not an interactive assistant.\n' +
        `Review ONLY the STAGED changes (domain: ${reviewer.domain}). Staged files in scope: ${files.join(', ')}.\n` +
        'Reviewer selection has already been performed. Treat that staged-file list as authoritative; do not re-evaluate the brief trigger conditions or skip because repository configuration has empty roots.\n' +
        'A diffstat is on stdin. INVESTIGATE before judging: run `git diff --cached -- <file>` to read ' +
        'the actual staged hunks, and Read surrounding code where a hunk alone is ambiguous.\n' +
        checklistContract +
        (checklistRecoveryReason
            ? `CHECKLIST-CONTRACT RETRY: the prior attempt did not satisfy the brief-owned workflow (${checklistRecoveryReason}). Complete that workflow before returning a verdict.\n`
            : '') +
        'Do NOT run the `cleanup` step: the gate reads the checklist artifact after you finish (an ' +
        'incomplete or deleted checklist VOIDS a PASS verdict — skipping or cleaning only wastes the ' +
        'run) and removes it itself.\n' +
        'Your reviewer brief follows. IGNORE any instructions in it about `cleanup`, approve.sh, marker ' +
        'files, tracker/Shortcut lookups, or invoking other subagents — none apply in gate mode.\n' +
        '───── BRIEF ─────\n' +
        `${brief}\n` +
        '───── END BRIEF ─────\n' +
        'Judge ONLY the staged diff; pre-existing issues in code this commit does not touch are not ' +
        'findings. List findings (file:line, one line each), then END with exactly one line:\n' +
        'VERDICT: PASS | FAIL — <one-line reason>\n' +
        'FAIL only for a finding that must block THIS commit.');
}
// One violation block per the conventions-reviewer brief's contract — the OFFENDING path:line is
// the STABLE key the override valve fingerprints on (see parseConventionFindings docstring): it
// is deterministic for a fixed diff, unlike the free-text VERDICT reason, which a haiku judge may
// paraphrase differently run to run on byte-identical input.
const OFFENDING_LINE_RE = /^[\s>*#-]*\**OFFENDING\**\s*:.*[—–-]\s*(\S+):(\d+)\s*$/gim;
/**
 * Checklist-free counterpart to `wrapPrompt` for a SKILL-LESS reviewer (no Bash at all): no
 * "fetch your own diff" instruction (there's no Bash to run it with) — the diff evidence rides on
 * stdin (pre-capped, omission-accounted — see diff-evidence.mts) and the governing CLAUDE.md rules
 * are pre-rendered into the prompt itself (see claude-md.mts). Same VERDICT contract as wrapPrompt
 * so parseReviewVerdict needs no changes; the VIOLATION/OFFENDING contract additionally feeds
 * parseConventionFindings for stable override fingerprints.
 */
export function wrapConventionsPrompt(agentBody, files, claudeMdBlock) {
    return ('You are running as an automated HEADLESS COMMIT GATE, not an interactive assistant.\n' +
        `Review ONLY the STAGED changes. Staged files in scope: ${files.join(', ')}.\n` +
        'You have NO Bash — the capped diff evidence is already on stdin (any OMITTED/TRUNCATED ' +
        'marker names what the cap dropped; Read/Grep/Glob surrounding code where a hunk alone is ' +
        'ambiguous, but do not try to run git yourself). The governing CLAUDE.md rules for these files ' +
        'are already loaded below — do not search for more.\n' +
        `${claudeMdBlock}\n` +
        'Your reviewer brief follows. IGNORE any instructions in it about checklist scripts, marker ' +
        'files, tracker/Shortcut lookups, or invoking other subagents — none apply in gate mode.\n' +
        '───── BRIEF ─────\n' +
        `${stripFrontmatter(agentBody)}\n` +
        '───── END BRIEF ─────\n' +
        'Judge ONLY the staged diff against the governing rules above. For each violation, emit BOTH:\n' +
        '  VIOLATION: <exact quoted rule text> — <rule file>:<rule line>\n' +
        '  OFFENDING: <exact offending line, verbatim> — <offending file>:<offending line>\n' +
        'If you cannot quote both, do not flag it. No findings → say NO_VIOLATIONS. END with exactly ' +
        'one line:\n' +
        'VERDICT: PASS | FAIL — <one-line reason>\n' +
        'FAIL only for a clear, quotable violation that must block THIS commit.');
}
/**
 * Parse the `OFFENDING: … — <path>:<line>` blocks from a conventions-reviewer transcript — used
 * ONLY to build the override valve's lens keys (never the free-text VERDICT reason: haiku's
 * one-line paraphrase of the SAME violation varies run-to-run on byte-identical input, which would
 * silently un-match a dev's already-committed waiver and re-block them; the offending path:line is
 * deterministic for a fixed diff, exactly like the checklist item names other reviewers key on).
 */
export function parseConventionFindings(raw) {
    return [...String(raw).matchAll(OFFENDING_LINE_RE)].map((m) => ({
        offendingPath: m[1],
        offendingLine: Number(m[2]),
    }));
}
/**
 * Independent verification of the checklist artifact the judge's workflow left behind — the
 * gate-side half of the anti-hallucination contract. Returns null when the artifact is complete
 * and consistent with the verdict, else a human-readable reason (→ the cascade result becomes
 * inconclusive, never a PASS). A FAIL verdict needs no artifact scrutiny — it blocks regardless.
 *
 * @param state parsed state-file JSON (null = missing/unreadable)
 * @param verdict the judge's parsed verdict
 */
export function verifyChecklist(state, verdict) {
    if (verdict === 'FAIL')
        return null;
    const items = state?.items ?? state?.files; // domain reviewers use items[]; commit-guard files[]
    if (!Array.isArray(items) || items.length === 0)
        return ('checklist artifact missing — the judge skipped the checklist workflow (or its ' +
            'checklist script was never synced: devkit sync-skills)');
    const pending = items.filter((i) => i.status === 'pending');
    if (pending.length > 0)
        return `checklist incomplete — ${pending.length} item(s) never resolved: ${pending
            .map((i) => i.name ?? i.path)
            .join(', ')}`;
    const failed = items.filter((i) => i.status === 'fail');
    if (failed.length > 0)
        return `checklist has ${failed.length} FAILED item(s) but the verdict says PASS: ${failed
            .map((i) => i.name ?? i.path)
            .join(', ')}`;
    return null;
}
/** Escalation prompt: opus independently re-verifies a first-pass FAIL (check-alignment shape). */
export function escalatePrompt(wrappedPrompt, firstPass) {
    return (`${wrappedPrompt}\n\n` +
        'A first-pass reviewer (smaller model) judged FAIL. Its full notes:\n' +
        '─────\n' +
        `${firstPass}\n` +
        '─────\n' +
        'Independently verify its evidence with your own investigation — confirm or overturn. ' +
        'Your verdict is final; a FAIL blocks the commit.');
}
/**
 * Bounded verdict: the LAST `VERDICT:` line wins. No VERDICT line → {verdict: null} (no block,
 * no cache — see VERDICT_LINE_RE note). The FAIL reason is the line's tail, markdown-stripped.
 */
export function parseReviewVerdict(raw) {
    const lines = [...String(raw).matchAll(VERDICT_LINE_RE)];
    if (lines.length === 0)
        return { verdict: null, reason: '' };
    const last = lines[lines.length - 1];
    return {
        verdict: last[1].toUpperCase(),
        reason: (last[2] ?? '').replace(/\*+/g, '').trim(),
    };
}
/**
 * Cache key for a PASS verdict: reviewer identity + the exact bytes of its staged domain diff.
 * An IDENTICAL diff re-reviewed (amend, rebase replay, retry after fixing an unrelated gate)
 * skips instantly — including after a rebase onto changed surrounding context. That skip is BY
 * DESIGN: the reviewed object is the diff itself, and re-judging it on unchanged bytes buys
 * latency, not safety.
 */
export function cacheKey(reviewerName, diffText, identitySalt = '') {
    return `${reviewerName}:${createHash('sha256').update(identitySalt).update('\0').update(diffText).digest('hex')}`;
}
function injectedRoots(value, name) {
    if (value === undefined)
        return null;
    try {
        return normalizeReviewRoots(JSON.parse(value), name);
    }
    catch {
        throw new Error(`${name} must be a JSON array of non-empty repository-relative paths`);
    }
}
/** Resolve review-only domain topology once. Invocation injection wins, then a non-empty consumer
 * root, then scanRoots (or `.` as the last conservative fallback). Commit/ship never call this. */
export function effectiveReviewConfig(cfg, env = process.env) {
    const fallback = normalizeReviewRoots(cfg.scanRoots.length > 0 ? cfg.scanRoots : ['.'], 'scanRoots');
    const backend = injectedRoots(env.DEVKIT_REVIEW_BACKEND_ROOTS, 'DEVKIT_REVIEW_BACKEND_ROOTS');
    const frontend = injectedRoots(env.DEVKIT_REVIEW_FRONTEND_ROOTS, 'DEVKIT_REVIEW_FRONTEND_ROOTS');
    return {
        ...cfg,
        scanRoots: fallback,
        review: {
            ...cfg.review,
            backendRoots: backend ??
                (cfg.review.backendRoots.length > 0
                    ? normalizeReviewRoots(cfg.review.backendRoots, 'review.backendRoots')
                    : fallback),
            frontendRoots: frontend ??
                (cfg.review.frontendRoots.length > 0
                    ? normalizeReviewRoots(cfg.review.frontendRoots, 'review.frontendRoots')
                    : fallback),
        },
    };
}
