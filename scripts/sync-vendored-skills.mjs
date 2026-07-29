#!/usr/bin/env node
/**
 * Maintainer command for the third-party skills devkit vendors (cli/lib/install/vendored-skills.mts).
 * Deliberately NOT wired into init/upgrade: it hits the network, and a consumer install must never
 * depend on GitHub being reachable. Lives in scripts/, which copy-dist-assets.mjs does not ship.
 *
 *   node scripts/sync-vendored-skills.mjs                # verify: vendored bytes == upstream @ pin
 *   node scripts/sync-vendored-skills.mjs --check-latest # also report whether upstream has moved on
 *   node scripts/sync-vendored-skills.mjs --update <sha> # re-vendor from <sha> and rewrite the pin
 *
 * Verify exits non-zero on any mismatch. --update rewrites both the file and its commit/sha256 in
 * vendored-skills.mts, so bumping an upstream is a reviewable diff rather than a silent refresh.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PIN_FILE = join(root, 'cli', 'lib', 'install', 'vendored-skills.mts');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// The pin module is TypeScript, so it can't just be imported here. Parse the object literals —
// the shape is a hand-maintained constant, so a strict regex is a feature: a malformed entry fails
// loudly rather than being skipped.
function readPins() {
  const src = readFileSync(PIN_FILE, 'utf8');
  const field = (block, key) => block.match(new RegExp(`${key}:\\s*'([^']*)'`))?.[1];
  const pins = [];
  for (const block of src.match(/\{[^{}]*name:[\s\S]*?\}/g) ?? []) {
    const pin = {
      name: field(block, 'name'),
      repo: field(block, 'repo'),
      commit: field(block, 'commit'),
      path: field(block, 'path'),
      sha256: field(block, 'sha256'),
    };
    if (Object.values(pin).every(Boolean)) pins.push(pin);
  }
  if (!pins.length) {
    console.error(`sync-vendored-skills: no pins parsed from ${PIN_FILE} — has its shape changed?`);
    process.exit(1);
  }
  return pins;
}

const rawUrl = (pin, commit) =>
  `${pin.repo.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/${commit}/${pin.path}`;

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function latestCommit(pin) {
  const repoPath = pin.repo.replace('https://github.com/', '');
  const res = await fetch(`https://api.github.com/repos/${repoPath}/commits?per_page=1`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return null;
  return (await res.json())?.[0]?.sha ?? null;
}

const args = process.argv.slice(2);
const updateIdx = args.indexOf('--update');
const updateSha = updateIdx === -1 ? null : args[updateIdx + 1];
const checkLatest = args.includes('--check-latest');

if (updateIdx !== -1 && !/^[0-9a-f]{40}$/.test(updateSha ?? '')) {
  console.error('sync-vendored-skills: --update needs a full 40-character commit SHA.');
  process.exit(1);
}

let failed = false;
for (const pin of readPins()) {
  const local = join(root, 'skills', pin.name, 'SKILL.md');
  if (!existsSync(local)) {
    console.error(`✗ ${pin.name}: vendored file missing at skills/${pin.name}/SKILL.md`);
    failed = true;
    continue;
  }

  if (updateSha) {
    const upstream = await fetchText(rawUrl(pin, updateSha));
    const digest = sha256(upstream);
    writeFileSync(local, upstream);
    const rewritten = readFileSync(PIN_FILE, 'utf8')
      .replace(pin.commit, updateSha)
      .replace(pin.sha256, digest);
    writeFileSync(PIN_FILE, rewritten);
    console.log(`✓ ${pin.name}: re-vendored @ ${updateSha.slice(0, 12)} (sha256 ${digest.slice(0, 12)}…)`);
    console.log('  Review the diff — upstream wording changes reach every consumer repo on upgrade.');
    continue;
  }

  const localDigest = sha256(readFileSync(local));
  if (localDigest !== pin.sha256) {
    console.error(`✗ ${pin.name}: vendored file does not match its recorded sha256 (local edit?)`);
    console.error(`    recorded ${pin.sha256}\n    on disk  ${localDigest}`);
    failed = true;
    continue;
  }

  const upstream = await fetchText(rawUrl(pin, pin.commit)).catch((err) => err);
  if (upstream instanceof Error) {
    console.error(`✗ ${pin.name}: could not fetch upstream — ${upstream.message}`);
    failed = true;
    continue;
  }
  if (sha256(upstream) !== pin.sha256) {
    console.error(`✗ ${pin.name}: upstream @ ${pin.commit.slice(0, 12)} differs from the vendored copy`);
    failed = true;
    continue;
  }
  console.log(`✓ ${pin.name}: vendored copy matches upstream @ ${pin.commit.slice(0, 12)}`);

  if (checkLatest) {
    const head = await latestCommit(pin);
    if (!head) console.log(`  • could not resolve upstream HEAD (rate limited?)`);
    else if (head === pin.commit) console.log('  • pin is at upstream HEAD');
    else
      console.log(
        `  • upstream has moved to ${head.slice(0, 12)} — bump with --update ${head} after reviewing`,
      );
  }
}

process.exit(failed ? 1 : 0);
