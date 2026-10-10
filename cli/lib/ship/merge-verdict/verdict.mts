/** The merge verdict for one shipped change, from its paths, line counts, bypasses and red/green
 * evidence alone. No model is consulted, and an input that cannot be read never reads as safe. */
import { z } from 'zod';
import { parseJsonObject } from '../../../../gate-engine/config-json.mts';
import { CONFIG_FILENAME, resolveGuardConfigJson } from '../../../../gate-engine/config.mts';
import { TEST_PATH } from '../../../../gate-engine/coverage/gate-shared.mts';
import { decisionFileRe, LOCKFILE_RE, PKG_RE } from '../../../../gate-engine/decisions/detect.mts';
import { FIXED_GATE_INPUTS } from '../../../../gate-engine/deterministic/gate-inputs.mts';
import { compileRepoGlob } from '../../../../skills/_devkit/review-roots.mjs';
import type { RegressionEvidence } from '../../baseline-status/regression-evidence.mts';
import { repoGlobSchema } from '../generated-paths/registry.mts';

export type Verdict = 'auto-merge-eligible' | 'human-review' | 'policy';

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
} as const satisfies Record<string, Verdict>;

export type ReasonCode = keyof typeof VERDICT_REASONS;

export interface ChangedPath {
  path: string;
  /** null where `git diff --numstat` prints `-`, as it does for a binary file. */
  added: number | null;
  deleted: number | null;
}

export interface EvidenceOutcome {
  status: RegressionEvidence['status'] | 'not-run';
  headSha: string;
  /** Why no proof was attempted, when status is 'not-run'. */
  abstention?: string;
}

export interface ShipChange {
  headSha: string;
  paths: readonly ChangedPath[];
  /** GUARD_* bypasses and waived findings; 'unknown' when they could not be read. */
  bypasses: readonly string[] | 'unknown';
  evidence: EvidenceOutcome | null;
}

export interface VerdictReason {
  code: ReasonCode;
  detail?: string;
}

/** Every reason that fired, in precedence order; the first one decides the verdict. */
export interface MergeVerdict {
  verdict: Verdict;
  reasons: VerdictReason[];
}

type PathClass =
  | 'merge-governance'
  | 'test'
  | 'dependency'
  | 'decision-record'
  | 'consumer-surface'
  | 'source';

interface Policy {
  governance: RegExp[];
  decisionRecord: RegExp;
  consumerSurface: RegExp[];
  maxSourceLines: number;
  maxSourceFiles: number;
}

const CLASS_REASONS = [
  'dependency',
  'merge-governance',
  'decision-record',
  'consumer-surface',
] as const satisfies readonly (PathClass & ReasonCode)[];

const LEADING_DOT_SLASH = /^(?:\.\/)+/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// The verdict is printed between HTML-comment markers, so nothing may end a comment or a line.
const UNPRINTABLE = /[^\x20-\x7e]|[<>`]/g;

// Manifests and lockfiles outside JavaScript, from GitHub's dependency-graph ecosystem table.
const OTHER_DEPENDENCY_RE = new RegExp(
  `(^|/)(${[
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
  ].join('|')})$`,
);

// What configures the gates or CI a merge relies on, so a change to it can never certify itself.
const GOVERNANCE_GLOBS = [
  ...FIXED_GATE_INPUTS.filter((input) => !input.cache && !input.localCache).map((input) =>
    input.kind === 'dir' ? `${input.path}/**` : input.path,
  ),
  '.devkit/config.json',
  '.husky/**',
  '.github/**',
];

const policySchema = z.looseObject({
  mergeVerdict: z
    .strictObject({
      consumerSurface: z.array(repoGlobSchema).default([]),
      maxSourceLines: z.int().min(0).default(50),
      maxSourceFiles: z.int().min(0).default(4),
    })
    .prefault({}),
});

const printable = (text: string): string => text.replace(UNPRINTABLE, '_');
const anyDepth = (glob: string): RegExp => compileRepoGlob(`**/${glob}`);
const counted = (n: number | null): boolean => n !== null && Number.isSafeInteger(n) && n >= 0;

/** guard.config.json text (null when absent) to a policy; malformed input throws. */
function parsePolicy(configText: string | null): Policy {
  const raw = configText === null ? {} : parseJsonObject<object>(configText, CONFIG_FILENAME);
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${CONFIG_FILENAME} ${issue.path.join('.')}: ${issue.message}`);
  }
  const { consumerSurface, maxSourceLines, maxSourceFiles } = parsed.data.mergeVerdict;
  const { decisionsDir, allowlistPath } = resolveGuardConfigJson(configText);
  return {
    governance: [...GOVERNANCE_GLOBS, allowlistPath.replace(LEADING_DOT_SLASH, '')].map(anyDepth),
    decisionRecord: decisionFileRe(decisionsDir),
    consumerSurface: consumerSurface.map((glob) => compileRepoGlob(glob)),
    maxSourceLines,
    maxSourceFiles,
  };
}

// Governance outranks the test name, so `.github/workflows/x.test.yml` still counts as CI.
function classify(path: string, policy: Policy): PathClass {
  if (policy.governance.some((re) => re.test(path))) return 'merge-governance';
  if (TEST_PATH.test(path)) return 'test';
  if ([LOCKFILE_RE, PKG_RE, OTHER_DEPENDENCY_RE].some((re) => re.test(path))) return 'dependency';
  if (policy.decisionRecord.test(path)) return 'decision-record';
  if (policy.consumerSurface.some((re) => re.test(path))) return 'consumer-surface';
  return 'source';
}

function proofReason({ evidence, headSha }: ShipChange): VerdictReason {
  if (!evidence) return { code: 'no-captured-proof', detail: 'missing' };
  if (evidence.status !== 'captured') {
    const why =
      evidence.status === 'not-run'
        ? `not-run: ${evidence.abstention ?? 'unspecified'}`
        : evidence.status;
    return { code: 'no-captured-proof', detail: printable(why) };
  }
  // An empty or abbreviated SHA proves nothing about which commit the evidence ran at.
  if (!FULL_SHA.test(headSha) || evidence.headSha !== headSha)
    return { code: 'no-captured-proof', detail: 'stale' };
  return { code: 'captured-proof' };
}

function sourceReasons(change: ShipChange, source: ChangedPath[], policy: Policy): VerdictReason[] {
  const { maxSourceLines, maxSourceFiles } = policy;
  const uncounted = source.some((p) => !counted(p.added) || !counted(p.deleted));
  const lines = source.reduce((sum, p) => sum + (p.added ?? 0) + (p.deleted ?? 0), 0);
  const size = uncounted
    ? 'unknown line count'
    : `${lines}/${maxSourceLines} lines, ${source.length}/${maxSourceFiles} files`;
  const over = uncounted || lines > maxSourceLines || source.length > maxSourceFiles;
  return [...(over ? [{ code: 'over-size' as const, detail: size }] : []), proofReason(change)];
}

const decide = (reasons: VerdictReason[]): MergeVerdict => ({
  verdict: VERDICT_REASONS[reasons[0].code],
  reasons,
});

/**
 * The verdict for `change` under the `mergeVerdict` policy in `configText`, the guard.config.json
 * text (null when the file is absent). A policy that cannot be read yields `config-invalid`.
 */
export function mergeVerdict(change: ShipChange, configText: string | null): MergeVerdict {
  let policy: Policy;
  try {
    policy = parsePolicy(configText);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return decide([{ code: 'config-invalid', detail: printable(message) }]);
  }
  const reasons: VerdictReason[] = [];
  if (change.bypasses === 'unknown') reasons.push({ code: 'bypass-unknown' });
  else if (change.bypasses.length)
    reasons.push({
      code: 'gate-bypassed',
      detail: printable([...new Set(change.bypasses)].join(', ')),
    });
  const classes = change.paths.map((p) => classify(p.path, policy));
  for (const code of CLASS_REASONS) if (classes.includes(code)) reasons.push({ code });
  const source = change.paths.filter((_, i) => classes[i] === 'source');
  if (!change.paths.length) reasons.push({ code: 'no-change' });
  else if (source.length) reasons.push(...sourceReasons(change, source, policy));
  else if (classes.includes('test')) reasons.push({ code: 'test-only' });
  return decide(reasons);
}

/** The line the evidence block ends with: the verdict and the reason that decided it. */
export function verdictLine({ verdict, reasons }: MergeVerdict): string {
  const { code, detail } = reasons[0];
  return `${verdict} (${code}${detail ? `: ${detail}` : ''})`;
}
