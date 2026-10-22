/** The merge verdict for one shipped change, from its paths, line counts, bypasses and red/green
 * evidence alone. No model is consulted, and an input that cannot be read never reads as safe. */
import { z } from 'zod';
import { parseJsonObject } from '../../../../gate-engine/config-json.mjs';
import { CONFIG_FILENAME, resolveGuardConfigJson } from '../../../../gate-engine/config.mjs';
import { TEST_PATH } from '../../../../gate-engine/coverage/gate-shared.mjs';
import { decisionFileRe, LOCKFILE_RE, PKG_RE } from '../../../../gate-engine/decisions/detect.mjs';
import { FIXED_GATE_INPUTS } from '../../../../gate-engine/deterministic/gate-inputs.mjs';
import { compileRepoGlob } from '../../../../skills/_devkit/review-roots.mjs';
import { repoGlobSchema } from '../generated-paths/registry.mjs';
/** The closed set of reason codes, in precedence order, each with the verdict it yields. */
export const VERDICT_REASONS = {
    'config-invalid': 'human-review',
    'bypass-unknown': 'human-review',
    'gate-bypassed': 'human-review',
    dependency: 'policy',
    'merge-governance': 'policy',
    'decision-record': 'human-review',
    'consumer-surface': 'human-review',
    'no-change': 'human-review',
    'over-size': 'human-review',
    'no-captured-proof': 'human-review',
    'test-only': 'auto-merge-eligible',
    'captured-proof': 'auto-merge-eligible',
};
const BUILT_IN_LIMIT = { maxSourceLines: 50, maxSourceFiles: 4 };
// A breaking `type!:` subject does not match, so it gets the default limit.
const COMMIT_TYPE = /^([a-z]+)(?:\([^)]*\))?:/i;
const CLASS_REASONS = [
    'dependency',
    'merge-governance',
    'decision-record',
    'consumer-surface',
];
const LEADING_DOT_SLASH = /^(?:\.\/)+/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// The verdict is printed between HTML-comment markers, so nothing may end a comment or a line.
const UNPRINTABLE = /[^\x20-\x7e]|[<>`]/g;
// Manifests and lockfiles outside JavaScript, from GitHub's dependency-graph ecosystem table.
const OTHER_DEPENDENCY_RE = new RegExp(`(^|/)(${[
    'Cargo\\.(toml|lock)',
    'go\\.(mod|sum)',
    'composer\\.(json|lock)',
    'deno\\.(json|jsonc|lock)',
    'pyproject\\.toml',
    'poetry\\.lock',
    'uv\\.lock',
    'requirements[^/]*\\.txt',
    'Pipfile(\\.lock)?',
    'setup\\.py',
    'Gemfile(\\.lock)?',
    '[^/]+\\.gemspec',
    'pom\\.xml',
    'build\\.gradle(\\.kts)?',
    'gradle\\.lockfile',
    'pubspec\\.(yaml|lock)',
    'Package\\.(swift|resolved)',
    '(Project|Manifest)\\.toml',
    '[^/]+\\.(csproj|vbproj|fsproj|vcxproj|nuspec)',
    'packages\\.config',
    '([^/]+\\.)?MODULE\\.bazel(\\.lock)?',
    'WORKSPACE',
    'maven_install\\.json',
    '\\.terraform\\.lock\\.hcl',
].join('|')})$`);
// What configures the gates or CI a merge relies on, so a change to it can never certify itself.
const GOVERNANCE_GLOBS = [
    ...FIXED_GATE_INPUTS.filter((input) => !input.localCache).map((input) => input.kind === 'dir' ? `${input.path}/**` : input.path),
    '.devkit/config.json',
    '.husky/**',
    '.github/**',
];
const policySchema = z.looseObject({
    mergeVerdict: z
        .strictObject({
        consumerSurface: z.array(repoGlobSchema).default([]),
        limits: z
            .record(z.string().regex(/^[a-z]+$/, 'a lowercase commit type or "default"'), z.strictObject({
            maxSourceLines: z.int().min(0).optional(),
            maxSourceFiles: z.int().min(0).optional(),
        }))
            .default({}),
    })
        .prefault({}),
});
const printable = (text) => text.replace(UNPRINTABLE, '_');
const anyDepth = (glob) => compileRepoGlob(`**/${glob}`);
const counted = (n) => n !== null && Number.isSafeInteger(n) && n >= 0;
/** guard.config.json text (null when absent) to a policy; malformed input throws. */
function parsePolicy(configText) {
    const raw = configText === null ? {} : parseJsonObject(configText, CONFIG_FILENAME);
    const parsed = policySchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`${CONFIG_FILENAME} ${issue.path.join('.')}: ${issue.message}`);
    }
    const { consumerSurface, limits } = parsed.data.mergeVerdict;
    const { decisionsDir, allowlistPath } = resolveGuardConfigJson(configText);
    return {
        governance: [...GOVERNANCE_GLOBS, allowlistPath.replace(LEADING_DOT_SLASH, '')].map(anyDepth),
        decisionRecord: decisionFileRe(decisionsDir),
        consumerSurface: consumerSurface.map((glob) => compileRepoGlob(glob)),
        limits,
    };
}
/** The size limit for `subject`'s commit type: its entry, then `default`, then the built-in limit. */
function limitFor(subject, limits) {
    const type = COMMIT_TYPE.exec(subject)?.[1].toLowerCase();
    const name = type && Object.hasOwn(limits, type) ? type : 'default';
    return { name, limit: { ...BUILT_IN_LIMIT, ...limits.default, ...limits[name] } };
}
// Governance outranks the test name, so `.github/workflows/x.test.yml` still counts as CI.
function classify(path, policy) {
    if (policy.governance.some((re) => re.test(path)))
        return 'merge-governance';
    if (TEST_PATH.test(path))
        return 'test';
    if ([LOCKFILE_RE, PKG_RE, OTHER_DEPENDENCY_RE].some((re) => re.test(path)))
        return 'dependency';
    if (policy.decisionRecord.test(path))
        return 'decision-record';
    if (policy.consumerSurface.some((re) => re.test(path)))
        return 'consumer-surface';
    return 'source';
}
function proofReason({ evidence, headSha }) {
    if (!evidence)
        return { code: 'no-captured-proof', detail: 'missing' };
    if (evidence.status !== 'captured') {
        const why = evidence.status === 'not-run'
            ? `not-run: ${evidence.reason ?? 'unspecified'}`
            : evidence.status;
        return { code: 'no-captured-proof', detail: printable(why) };
    }
    // An empty or abbreviated SHA proves nothing about which commit the evidence ran at.
    if (!FULL_SHA.test(headSha) || evidence.headSha !== headSha)
        return { code: 'no-captured-proof', detail: 'stale' };
    return { code: 'captured-proof' };
}
function sourceReasons(change, source, policy) {
    const { name, limit } = limitFor(change.subject, policy.limits);
    const { maxSourceLines, maxSourceFiles } = limit;
    const uncounted = source.some((p) => !counted(p.added) || !counted(p.deleted));
    const lines = source.reduce((sum, p) => sum + (p.added ?? 0) + (p.deleted ?? 0), 0);
    const size = uncounted
        ? 'unknown line count'
        : `${lines}/${maxSourceLines} lines, ${source.length}/${maxSourceFiles} files, ${name} limit`;
    const over = uncounted || lines > maxSourceLines || source.length > maxSourceFiles;
    return [...(over ? [{ code: 'over-size', detail: size }] : []), proofReason(change)];
}
const decide = (reasons) => ({
    verdict: VERDICT_REASONS[reasons[0].code],
    reasons,
});
/**
 * The verdict for `change` under the `mergeVerdict` policy in `configText`, the guard.config.json
 * text (null when the file is absent). A policy that cannot be read yields `config-invalid`.
 */
export function mergeVerdict(change, configText) {
    let policy;
    try {
        policy = parsePolicy(configText);
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return decide([{ code: 'config-invalid', detail: printable(message) }]);
    }
    const reasons = [];
    if ('unknown' in change.bypasses)
        reasons.push({ code: 'bypass-unknown', detail: printable(change.bypasses.unknown) });
    else if (change.bypasses.length)
        reasons.push({
            code: 'gate-bypassed',
            detail: printable([...new Set(change.bypasses)].join(', ')),
        });
    const classes = change.paths.map((p) => classify(p.path, policy));
    for (const code of CLASS_REASONS)
        if (classes.includes(code))
            reasons.push({ code });
    const source = change.paths.filter((_, i) => classes[i] === 'source');
    if (!change.paths.length)
        reasons.push({ code: 'no-change' });
    else if (source.length)
        reasons.push(...sourceReasons(change, source, policy));
    else if (classes.includes('test'))
        reasons.push({ code: 'test-only' });
    return decide(reasons);
}
/** The block's verdict text: the verdict and every reason that yields it, the deciding one first. */
export function verdictLine({ verdict, reasons }) {
    const why = reasons
        .filter(({ code }) => VERDICT_REASONS[code] === verdict)
        .map(({ code, detail }) => (detail ? `${code}: ${detail}` : code));
    return `${verdict} (${why.join('; ')})`;
}
