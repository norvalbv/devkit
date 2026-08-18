/** Pinned upstream identity and the complete Devkit-managed anti-slop rule surface. */

export const ANTI_SLOP_UPSTREAM = '446268e5d15baa968eaec669ff65358d36ae6259';
export const ANTI_SLOP_PLUGIN_API_VERSION = '1.78.0';
export const ANTI_SLOP_MANAGED_REL = '.devkit/anti-slop';
export const ANTI_SLOP_MANIFEST_REL = `${ANTI_SLOP_MANAGED_REL}/manifest.json`;
export const ANTI_SLOP_CONFIG_REL = `${ANTI_SLOP_MANAGED_REL}/oxlint.json`;
export const ANTI_SLOP_BASELINE_REL = '.anti-slop-baseline.json';
export const ANTI_SLOP_LOCK_REL = '.devkit/anti-slop.lock';
export const ANTI_SLOP_BASELINE_LOCK_REL = '.devkit/anti-slop-baseline.lock';

export const ANTI_SLOP_RULE_NAMES = [
  'no-chained-type-assertions',
  'no-conditional-empty-object-spread',
  'no-known-value-widening',
  'no-module-mocking',
  'no-object-parameters',
  'no-reflect-apply',
  'no-reflect-get',
  'no-runtime-typeof',
  'no-shape-in-symbol-names',
  'no-unknown-parameters',
  'no-unknown-returns',
  'no-unknown-type-aliases',
  'no-unsafe-dictionary-type',
  'no-widen-then-assert',
  'require-safety-comment-for-type-assertion',
] as const;

export const ANTI_SLOP_RULE_IDS = ANTI_SLOP_RULE_NAMES.map((name) => `anti-slop/${name}`);

export const ANTI_SLOP_IGNORE_PATTERNS = [
  '.agent/**',
  '.agents/**',
  '.claude/**',
  '.codex/**',
  '.continue/**',
  '.cursor/**',
  '.devkit/anti-slop/**',
  '.gemini/**',
  '.opencode/**',
  '.pi/**',
  '.roo/**',
  '.windsurf/**',
];

const ANTI_SLOP_CONFIG_DISABLE_PATTERNS = ANTI_SLOP_IGNORE_PATTERNS.flatMap((pattern) =>
  pattern === '.devkit/anti-slop/**' ? ['.devkit/anti-slop/plugin/**'] : [pattern],
);

/** Render the config fragment inherited by Devkit's managed Oxlint base. */
export function renderAntiSlopConfig(pluginEntry: string): string {
  return `${JSON.stringify(
    {
      jsPlugins: [{ name: 'anti-slop', specifier: pluginEntry }],
      overrides: [
        {
          files: ANTI_SLOP_CONFIG_DISABLE_PATTERNS,
          rules: Object.fromEntries(ANTI_SLOP_RULE_IDS.map((id) => [id, 'off'])),
        },
      ],
      rules: Object.fromEntries(ANTI_SLOP_RULE_IDS.map((id) => [id, 'error'])),
    },
    null,
    2,
  )}\n`;
}
