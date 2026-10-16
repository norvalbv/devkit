#!/usr/bin/env node
// Build a commit-guard corpus fixture from a base commit and one or more diffs against it.
//
//   node context.mjs --base <sha> --diff <a.diff> [--diff <b.diff>] [--redact FROM=TO] > fixture.json
//
// Prints { base: {path: content}, staged: [{path: content | null}, …] }, one staged map per diff
// and ONE shared base, so the rows of a minimal pair differ only in what they stage. The rule reads
// git and the diffs, never a row's label:
//   1. the pre-image of every staged file;
//   2. the base file each staged post-image imports by a relative specifier;
//   3. every non-test base file under the scan roots that defines a top-level symbol a non-test
//      staged file adds, so a copy that keeps its original's name finds that original;
//   4. the co-occurrence allowlist.
// A context file that would fail the corpus leak scan is dropped; a staged one aborts the row
// unless --redact rewrites the literal token in every staged file and its pre-image (the row is
// then provenance 'adapted').
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCAN_ROOTS = ['cli', 'gate-engine'];
const ALLOWLIST = '.co-occurrence-allowlist.json';
// The corpus leak scan in gate-engine/review/eval/reviewers/finalize.mts.
const LEAK_RE = /frink/i;
const DECL_RE =
  /^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

const git = (args, env) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, ...env },
  });
const isTest = (file) => /(^|\/)__tests__\/|\.test\./.test(file);
const showAt = (rev, file) => git(['show', `${rev}:${file}`]);
const declared = (text) => new Set([...(text ?? '').matchAll(DECL_RE)].map((m) => m[1]));

/** Apply a diff to a scratch index at `base`; return each staged path's post-image (null = deleted). */
function stagedPostImages(base, diffFile) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cg-context-'));
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    git(['read-tree', base], env);
    git(['apply', '--cached', diffFile], env);
    const staged = {};
    for (const line of git(['diff', '--cached', '--name-status', '--no-renames', base], env)
      .trim()
      .split('\n')) {
      const [status, file] = line.split('\t');
      staged[file] = status === 'D' ? null : git(['show', `:${file}`], env);
    }
    return staged;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const existsAt = (base, file) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${base}:${file}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const preImage = (base, file) => (existsAt(base, file) ? showAt(base, file) : null);

/** Step 2: base files a post-image imports by a relative specifier. */
const importTargets = (base, file, post) =>
  [...(post ?? '').matchAll(IMPORT_RE)]
    .map(([, spec]) => path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)))
    .filter((target) => existsAt(base, target));

/** Step 3: non-test base files under the scan roots that declare `name` at top level. */
function sameNameDefiners(base, name) {
  // POSIX ERE (git grep -E): no \s or \b.
  const pattern = `^(export[[:space:]]+)?(async[[:space:]]+)?(function\\*?|const|let|class)[[:space:]]+${name.replace(/\$/g, '\\$')}([^A-Za-z0-9_$]|$)`;
  try {
    return git(['grep', '-l', '-E', pattern, base, '--', ...SCAN_ROOTS])
      .trim()
      .split('\n')
      .map((hit) => hit.slice(base.length + 1))
      .filter((rel) => !isTest(rel) && rel.endsWith('.mts'));
  } catch {
    return []; // git grep exits 1 on no match
  }
}

/** Steps 1–3 of the rule for one staged map. */
function contextPaths(base, staged) {
  const paths = new Set();
  for (const [file, post] of Object.entries(staged)) {
    const pre = preImage(base, file);
    if (pre !== null) paths.add(file);
    for (const target of importTargets(base, file, post)) paths.add(target);
    if (isTest(file)) continue;
    const before = declared(pre);
    for (const name of declared(post))
      if (!before.has(name)) for (const rel of sameNameDefiners(base, name)) paths.add(rel);
  }
  return paths;
}

/** `--redact FROM=TO` as a function over file text (identity when absent). */
function redactor(argv) {
  if (!argv.includes('--redact')) return (text) => text;
  const [from, to] = (argv[argv.indexOf('--redact') + 1] ?? '').split('=');
  if (!from || to === undefined) throw new Error('usage: --redact FROM=TO with a non-empty FROM');
  return (text) => (text === null ? text : text.replaceAll(from, to));
}

/** Redact one diff's staged files in place; a staged file still failing the leak scan stops the row. */
function redactStaged(base, staged, redact) {
  for (const [file, post] of Object.entries(staged)) {
    staged[file] = redact(post);
    const pre = preImage(base, file);
    if (LEAK_RE.test(staged[file] ?? '') || LEAK_RE.test(redact(pre) ?? ''))
      throw new Error(`staged file ${file} fails the leak scan: defer this row`);
  }
}

function main(argv) {
  const base = argv[argv.indexOf('--base') + 1];
  const diffs = argv.flatMap((arg, i) => (arg === '--diff' ? [argv[i + 1]] : []));
  if (!base || diffs.length === 0)
    throw new Error('usage: context.mjs --base <sha> --diff <file>…');
  const redact = redactor(argv);
  const stagedMaps = diffs.map((diff) => stagedPostImages(base, diff));
  const paths = new Set([ALLOWLIST]);
  for (const staged of stagedMaps) {
    redactStaged(base, staged, redact);
    for (const file of contextPaths(base, staged)) paths.add(file);
  }
  const stagedPaths = new Set(stagedMaps.flatMap((staged) => Object.keys(staged)));
  const baseMap = {};
  for (const file of [...paths].sort()) {
    const text = stagedPaths.has(file) ? redact(showAt(base, file)) : showAt(base, file);
    if (!LEAK_RE.test(text)) baseMap[file] = text;
  }
  process.stdout.write(`${JSON.stringify({ base: baseMap, staged: stagedMaps })}\n`);
}

main(process.argv.slice(2));
