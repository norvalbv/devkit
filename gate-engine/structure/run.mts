#!/usr/bin/env node
// Structure-lint gate — folder-structure enforcement run entirely from DEVKIT's own install, so a
// consumer needs NO eslint / eslint-plugin-project-structure / parser in their package.json (the
// point of the zero-consumer-dependency model). `buildStructureConfigs(cwd)` reads the CONSUMER's
// guard.config.json `structure` block + baselines and returns a runnable eslint flat-config that
// embeds the plugin as a LOADED OBJECT — so ESLint never resolves the plugin from the consumer.
//
//   guard-structure gate     # lint all declared structure roots (CI/manual)
//   guard-structure staged   # lint only staged structure input (generated pre-commit hook)
//
// PARAMETERIZED (W-3): the trees / roots / grammar / baselines all come from resolveGuardConfig(cwd)
// — the consumer's guard.config.json under the consumer cwd, never the package dir. Grandfathering is
// NOT done here: the baselines are frozen by `devkit init` (runStructureBaselines), same as the
// ratchets. Config-driven only — buildStructureConfigs skips electron preset trees (no `grammar`).
//
// Exit contract (the shared gate trichotomy guard-deterministic applies): 0 clean, 1 violations,
// 2 fail-open (could-not-run).

import { execFileSync } from 'node:child_process';
import { commitIndexEnv } from '../ratchets/commit-index.mts';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint, type Linter } from 'eslint'; // devkit's OWN eslint (now a dependency), never the consumer's
import { z } from 'zod';
import { resolveGuardConfig } from '../config.mts';
import { gitPrefix, splitNul } from '../ratchets/git-index.mts';
import { buildStructureConfigs } from './eslint-config.mts';
import { eslintNodeFlags } from './eslint-node-flags.mts';
import {
  clean,
  combineStructureResults,
  couldNotRun,
  type StructureGateResult,
  violations,
  withUncompiledWalls,
} from './verdict.mts';

export { combineStructureResults };

// The one field this gate reads off each structure.trees[] entry — its on-disk root.
interface StructureTree {
  root?: string;
  sourceExtensions?: string[];
  grammar?: unknown;
}

// Which runner lints a scope: the consumer's own pinned eslint (electron preset) or devkit's
// bundled grammar engine.
type StructureLeg = 'preset' | 'grammar';

interface StagedScope {
  root: string;
  extensions: string[];
  leg?: StructureLeg;
}

interface StagedPlan {
  targets: string[];
  probeScopes: StagedScope[];
  deferred: string[];
}

// ESLint throws "No files matching the pattern" for an absent tree and "…are ignored" when every file
// in a present tree is ignored — both mean "nothing to lint" (clean), not a failure. Hoisted (perf).
const NOTHING_TO_LINT_RE = /No files matching|are ignored/i;
const ELECTRON_SOURCE_EXTENSIONS = ['ts', 'tsx', 'css'];
const POLICY_PATH_RE =
  /^(?:(?:eslint\.config\.mjs|guard\.config\.json|eslint\/domains\.mjs|\.devkit\/(?:config\.json|structure\/exempt\.mjs|baselines\/imports\.mjs))$|eslint\/baselines\/|\.devkit\/baselines\/structure\/)/;

function pathInRoot(file: string, root: string): boolean {
  const cleanRoot = root.replace(/\/+$/, '');
  if (cleanRoot === '.') return true;
  return Boolean(cleanRoot) && (file === cleanRoot || file.startsWith(`${cleanRoot}/`));
}

function pathInScope(file: string, scope: StagedScope): boolean {
  return pathInRoot(file, scope.root) && scope.extensions.includes(extname(file).slice(1));
}

function isPolicyPath(file: string): boolean {
  return POLICY_PATH_RE.test(file);
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function planStagedStructureLint(
  scopes: StagedScope[],
  changed: string[],
  destructive: string[],
  unstaged: string[],
  routingInputs: string[] = [],
): StagedPlan {
  const isPolicy = (file: string) => isPolicyPath(file) || routingInputs.includes(file);
  const unstablePolicy = unstaged.some(isPolicy);
  // A staged deletion or rename of a policy file changes policy as surely as an edit does.
  const stagedPolicy = [...changed, ...destructive].some(isPolicy);
  const deferred: string[] = [];
  const probeScopes = new Map<string, StagedScope>();
  const unstableScopes = new Set(
    scopes
      .filter((scope) => unstaged.some((file) => pathInScope(file, scope)))
      .map((scope) => scope.root),
  );

  for (const scope of scopes) {
    const hasDestructiveChange = destructive.some((file) => pathInScope(file, scope));
    const hasRelevantInput =
      stagedPolicy || hasDestructiveChange || changed.some((file) => pathInScope(file, scope));
    if (!hasRelevantInput) continue;
    if (unstablePolicy || unstableScopes.has(scope.root)) {
      if (unstablePolicy) deferred.push('structure policy');
      if (hasDestructiveChange) deferred.push(scope.root);
      continue;
    }
    if (stagedPolicy || hasDestructiveChange) probeScopes.set(`${scope.leg}:${scope.root}`, scope);
  }

  const targets: string[] = [];
  for (const file of changed) {
    // Scopes may overlap (a grammar root nested in an electron scanRoot); a file is unstable when ANY
    // scope that owns it is.
    const owners = scopes.filter((candidate) => pathInScope(file, candidate));
    if (!owners.length) continue;
    if (unstablePolicy || owners.some((scope) => unstableScopes.has(scope.root))) {
      deferred.push(file);
      continue;
    }
    targets.push(file);
  }
  return {
    targets: unique(targets),
    probeScopes: [...probeScopes.values()],
    deferred: unique(deferred),
  };
}

function gitPaths(cwd: string, args: string[]): string[] {
  return splitNul(
    execFileSync('git', args, { cwd, env: commitIndexEnv(cwd), encoding: 'buffer' }).toString(),
  );
}

function untrackedPaths(cwd: string): string[] {
  return gitPaths(cwd, ['ls-files', '--full-name', '--others', '--exclude-standard', '-z']);
}

function destructivePaths(cwd: string): string[] {
  const fields = splitNul(
    execFileSync('git', ['diff', '--cached', '--name-status', '-z', '--diff-filter=DR'], {
      cwd,
      env: commitIndexEnv(cwd),
      encoding: 'buffer',
    }).toString(),
  );
  const paths: string[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++] ?? '';
    if (status.startsWith('R')) {
      paths.push(fields[index++] ?? '', fields[index++] ?? '');
    } else if (status.startsWith('D')) {
      paths.push(fields[index++] ?? '');
    }
  }
  return paths.filter(Boolean);
}

function toCwdPaths(paths: string[], prefix: string): string[] {
  if (!prefix) return paths;
  return paths.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
}

// init writes `stack` as a string; any other shape cannot say whether the preset leg applies.
const STACK_MARKER = z.object({ stack: z.string().optional() });
const DEPS = z.record(z.string(), z.unknown()).optional();
const MANIFEST = z.object({ dependencies: DEPS, devDependencies: DEPS });

// No recorded stack: detectStack's electron rule (cli/lib/detect-stack.mts), as upgrade resolves it.
function detectedElectron(cwd: string): boolean {
  const file = join(cwd, 'package.json');
  if (!existsSync(file)) return false; // no manifest is detectStack's 'generic', never electron
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e: unknown) {
    throw new Error(`package.json is unreadable (${e instanceof Error ? e.message : e})`);
  }
  const manifest = MANIFEST.safeParse(json);
  if (!manifest.success) throw new Error('package.json dependencies are not objects');
  const deps = { ...manifest.data.dependencies, ...manifest.data.devDependencies };
  return Boolean(deps.electron || deps['electron-vite']);
}

interface PresetStack {
  electron: boolean;
  detected: boolean; // decided by package.json, which is then a routing (policy) input too
}

// Keyed on the recorded stack (as migrate-config is), never on "no grammar" — that also matches the
// universal shim, which is itself the bundled engine, and would lint every file twice.
function electronPreset(cwd: string): PresetStack {
  const file = join(cwd, '.devkit/config.json');
  const detect = (): PresetStack => ({ electron: detectedElectron(cwd), detected: true });
  if (!existsSync(file)) return detect();
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e: unknown) {
    throw new Error(`.devkit/config.json is unreadable (${e instanceof Error ? e.message : e})`);
  }
  const marker = STACK_MARKER.safeParse(json);
  if (!marker.success)
    throw new Error('.devkit/config.json is not an object with a string `stack`');
  const { stack } = marker.data;
  return stack === undefined ? detect() : { electron: stack === 'electron', detected: false };
}

function stagedScopes(cwd: string, electron: boolean): StagedScope[] {
  const cfg = resolveGuardConfig(cwd);
  const trees: StructureTree[] = cfg.structure?.trees ?? [];
  const treeScope = (tree: StructureTree & { root: string }, leg: StructureLeg): StagedScope => ({
    root: tree.root,
    extensions: tree.sourceExtensions?.length ? tree.sourceExtensions : cfg.sourceExtensions,
    leg,
  });
  const rootedTrees = trees.filter((tree): tree is StructureTree & { root: string } =>
    Boolean(tree.root),
  );
  const scanRootScopes = (leg: StructureLeg): StagedScope[] =>
    cfg.scanRoots.map((root) => ({ root, extensions: ELECTRON_SOURCE_EXTENSIONS, leg }));
  if (electron) {
    // Additive: the preset keeps every scanRoot it covered before; grammar trees join alongside.
    const grammarScopes = rootedTrees
      .filter((tree) => tree.grammar)
      .map((tree) => treeScope(tree, 'grammar'));
    return [...scanRootScopes('preset'), ...grammarScopes];
  }
  // Only a recorded electron stack has a local preset; every other stack gates through the bundled
  // engine, which names a grammar-less tree as could-not-run rather than guessing a preset.
  const configScopes = rootedTrees.map((tree) => treeScope(tree, 'grammar'));
  return configScopes.length ? configScopes : scanRootScopes('grammar');
}

// The electron preset leg: the consumer's locally pinned eslint + its own eslint.config.mjs.
function runPresetLint(cwd: string, targets: string[]): StructureGateResult {
  const eslintBin = join(cwd, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!existsSync(eslintBin)) {
    return couldNotRun('electron structure lint needs the locally pinned eslint binary');
  }
  // An empty root is clean, not ESLint's exit-2 "no files matching".
  const args = [...eslintNodeFlags(cwd), eslintBin, '--no-error-on-unmatched-pattern', '--'];
  try {
    execFileSync(process.execPath, [...args, ...targets], { cwd, stdio: 'inherit' });
    return clean();
  } catch (e: unknown) {
    // ESLint exits 1 for lint errors only; a crash, a broken config or a failed spawn did not lint.
    const status = e instanceof Error && 'status' in e ? e.status : undefined;
    if (status === 1) return violations(0, 'guard-structure: local eslint failed');
    return couldNotRun(`local eslint exited abnormally (status ${String(status ?? 'unknown')})`);
  }
}

function firstProbeFile(
  cwd: string,
  scope: StagedScope,
  excluded: ReadonlySet<string>,
): string | null {
  const pending = [scope.root];
  while (pending.length) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(join(cwd, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile() && pathInScope(relative, scope) && !excluded.has(relative)) {
        return relative;
      }
    }
  }
  return null;
}

export async function runStagedStructureGate(cwd = process.cwd()): Promise<StructureGateResult> {
  try {
    // Read the routing inputs BEFORE the git snapshots: an edit racing this read then shows up in
    // `unstaged` below and defers as policy, instead of silently routing on bytes nobody staged.
    const stack = electronPreset(cwd);
    const prefix = gitPrefix(cwd);
    const changed = toCwdPaths(
      gitPaths(cwd, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']),
      prefix,
    );
    // Name-status preserves both sides of a rename, unlike name-only. Either side can remove a
    // required sibling, so either must probe its containing structure root.
    const destructive = toCwdPaths(destructivePaths(cwd), prefix);
    // Untracked sources also change the tree observed by a topology parser, so they carry the
    // same deferral rule as tracked working-tree edits.
    const unstaged = unique(
      toCwdPaths([...gitPaths(cwd, ['diff', '--name-only', '-z']), ...untrackedPaths(cwd)], prefix),
    );
    const routingInputs = stack.detected ? ['package.json'] : [];
    // An unstable routing input may have mis-detected the stack: widen to both legs' scopes so every
    // staged file that could matter is deferred as policy, not dropped as out of scope.
    const routingUnstable = ['.devkit/config.json', ...routingInputs].some((file) =>
      unstaged.includes(file),
    );
    const scopes = stagedScopes(cwd, stack.electron || routingUnstable);
    const plan = planStagedStructureLint(scopes, changed, destructive, unstaged, routingInputs);
    // A probe also reads worktree bytes. Do not select a dirty source as the representative file
    // for a deletion/rename check; its result would not describe the staged tree either.
    const unstableSources = new Set(unstaged);
    const probes = plan.probeScopes.map((scope) => ({
      scope,
      target: firstProbeFile(cwd, scope, unstableSources),
    }));
    const probeTargets = probes
      .map((probe) => probe.target)
      .filter((target): target is string => target !== null);
    const unprobedRoots = probes.filter((probe) => probe.target === null).map((p) => p.scope.root);
    // Deferred input was inspected by nothing, so it is could-not-run — never folded into a clean 0.
    const results: StructureGateResult[] = [];
    if (plan.deferred.length) {
      results.push(
        couldNotRun(`deferred mixed staged/unstaged input to CI: ${plan.deferred.join(', ')}`),
      );
    }
    if (unprobedRoots.length) {
      results.push(
        couldNotRun(
          `deletion probe deferred to CI (no remaining source): ${unprobedRoots.join(', ')}`,
        ),
      );
    }

    // Route each file to every leg whose scope owns it — a grammar root nested in a scanRoot is
    // linted by both, so neither leg's rules are lost to the other.
    const legFiles = (leg: StructureLeg) =>
      unique([...plan.targets, ...probeTargets]).filter((file) =>
        scopes.some((scope) => scope.leg === leg && pathInScope(file, scope)),
      );
    const presetFiles = legFiles('preset');
    const grammarFiles = legFiles('grammar');
    if (presetFiles.length) results.push(runPresetLint(cwd, presetFiles));
    if (grammarFiles.length) results.push(await runGrammarLint(cwd, grammarFiles));
    return withUncompiledWalls(cwd, combineStructureResults(results));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return couldNotRun(message);
  }
}

/** Gate a consumer root's declared structure roots (an electron consumer also runs its preset over
 * present scanRoots); explicit `targets` lint through the grammar leg only. */
export async function runStructureGate(
  cwd = process.cwd(),
  targets?: string[],
): Promise<StructureGateResult> {
  try {
    return withUncompiledWalls(cwd, await structureLegs(cwd, targets));
  } catch (e: unknown) {
    return couldNotRun(e instanceof Error ? e.message : String(e));
  }
}

async function structureLegs(cwd: string, targets?: string[]): Promise<StructureGateResult> {
  if (targets) return runGrammarLint(cwd, targets);
  if (!electronPreset(cwd).electron) return runGrammarLint(cwd);
  const cfg = resolveGuardConfig(cwd);
  const trees: StructureTree[] = cfg.structure?.trees ?? [];
  const presetRoots = cfg.scanRoots.filter((root) => existsSync(join(cwd, root)));
  const results: StructureGateResult[] = [];
  if (presetRoots.length) results.push(runPresetLint(cwd, presetRoots));
  if (trees.some((tree) => tree.grammar)) results.push(await runGrammarLint(cwd));
  if (!results.length) return couldNotRun('no electron scanRoot or grammar root is present');
  return combineStructureResults(results);
}

// The grammar leg: devkit's bundled eslint over the grammar trees (or the given targets).
async function runGrammarLint(cwd: string, targets?: string[]): Promise<StructureGateResult> {
  try {
    const cfg = resolveGuardConfig(cwd);
    const baseConfig = await buildStructureConfigs(cwd);
    if (!baseConfig.length)
      return couldNotRun(
        'no structure.trees[].grammar declared (preset-only consumer); the electron preset leg runs only for an electron stack (recorded, else detected)',
      );
    // Only GRAMMAR roots, and only those on disk: a preset root enclosing a grammar root would lint
    // that grammar root a second time.
    const trees: StructureTree[] = cfg.structure?.trees ?? [];
    const grammarRoots = trees.flatMap((tree) => (tree.grammar && tree.root ? [tree.root] : []));
    const roots = (targets ?? grammarRoots).filter((target) => existsSync(join(cwd, target)));
    if (!roots.length)
      return couldNotRun(
        'no structure root is both declared in guard.config.json and present on disk',
      );

    // The plugin's error cache drops a message already cached for another filename; persisted in the
    // repo root it silences the next run (sc-2309), so it lives for this run only.
    const cacheDir = mkdtempSync(join(tmpdir(), 'devkit-structure-cache-'));
    try {
      return await lintStructureRoots(cwd, roots, [
        ...baseConfig,
        { settings: { 'project-structure/cache-location': cacheDir } },
      ]);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  } catch (e: unknown) {
    // Fail OPEN (exit 2), like the ratchet gates when their baseline is missing — a structure gate
    // that can't run must never wedge a commit. guard-deterministic treats 2 as fail-open (continue).
    const message = e instanceof Error ? e.message : String(e);
    return couldNotRun(message);
  }
}

async function lintStructureRoots(
  cwd: string,
  roots: string[],
  baseConfig: Linter.Config[],
): Promise<StructureGateResult> {
  const eslint = new ESLint({ cwd, overrideConfigFile: true, baseConfig });
  // Lint each root INDEPENDENTLY: a batched lintFiles fail-fasts on the first empty/all-ignored root
  // and would mask a sibling's violation; per-root, that root is its own "clean".
  const allResults = [];
  for (const root of roots) {
    try {
      allResults.push(...(await eslint.lintFiles([root])));
    } catch (e: unknown) {
      // Nothing-to-lint for THIS root → clean; any other throw is a real failure → fail-open above.
      const message = e instanceof Error ? e.message : '';
      if (NOTHING_TO_LINT_RE.test(message)) continue;
      throw e;
    }
  }
  const errorCount = allResults.reduce((n, r) => n + r.errorCount, 0);
  if (errorCount === 0) return clean();
  const text = await (await eslint.loadFormatter('stylish')).format(allResults);
  return violations(errorCount, text);
}

export async function runCli(cmd = 'gate') {
  if (cmd !== 'gate' && cmd !== 'staged') {
    console.error('usage: guard-structure <gate|staged>');
    process.exit(2);
  }
  const { code, text } =
    cmd === 'staged'
      ? await runStagedStructureGate(process.cwd())
      : await runStructureGate(process.cwd());
  if (code === 1) {
    if (text) console.error(text);
    console.error(
      '🚫 Structure violations (folder-structure). Rename/relocate the file(s) to match the declared grammar, or (if intentional) re-grandfather via `devkit init`.',
    );
  } else if (code === 2 && text) {
    console.error(text); // fail-open notice on stderr; still exits 2 (pass)
  }
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runCli(process.argv[2]);
}
