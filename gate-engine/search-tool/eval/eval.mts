#!/usr/bin/env node

/**
 * search-tool-eval: score the classifier in search-tool-guard.mjs against a
 * fixed query set. Designed for fast local runs (no API calls).
 *
 * Usage:
 *   node eval.mjs           # full table
 *   node eval.mjs --fail    # exit 1 on regression
 *
 * Live-agent runs (calling the model API and observing tool choice) are
 * intentionally out of scope here — they cost real tokens. The classifier
 * is a proxy: if the hook can correctly distinguish conceptual from literal
 * patterns, the agent's worst-case grep is at least flagged.
 *
 * SEED corpus: queries.json ships a generic, frink-agnostic starter set. A
 * consumer copies it and adds their own domain queries — it is a seed, not data
 * the engine reads at runtime.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SELF_EXT = import.meta.url.endsWith('.mts') ? '.mts' : '.mjs';
const guard = resolve(here, '..', `search-tool-guard${SELF_EXT}`);
const queriesPath = resolve(here, 'queries.json');

const { queries } = JSON.parse(readFileSync(queriesPath, 'utf8'));
const failOnRegression = process.argv.includes('--fail');

const results = queries.map((q) => {
  const expectedFlag = q.expected_tool !== 'grep' && q.expected_tool !== 'find_glob';
  // Build a plausible bash command for this pattern.
  const cmd = `grep -rn "${q.pattern}" src/`;
  const proc = spawnSync('node', [guard], {
    input: JSON.stringify({ tool_input: { command: cmd } }),
    encoding: 'utf8',
  });
  const flagged = proc.stdout.trim().length > 0;
  const correct = flagged === expectedFlag;
  return { ...q, flagged, expectedFlag, correct };
});

const correct = results.filter((r) => r.correct).length;
const total = results.length;
const accuracy = ((correct / total) * 100).toFixed(1);

const falsePositives = results.filter((r) => r.flagged && !r.expectedFlag);
const falseNegatives = results.filter((r) => !r.flagged && r.expectedFlag);

console.log(`search-tool-eval: ${correct}/${total} correct (${accuracy}%)`);
console.log(`  false positives (flagged literal): ${falsePositives.length}`);
console.log(`  false negatives (missed conceptual): ${falseNegatives.length}`);
console.log('');

for (const r of results) {
  const mark = r.correct ? 'OK   ' : 'FAIL ';
  const got = r.flagged ? 'flag' : 'pass';
  const want = r.expectedFlag ? 'flag' : 'pass';
  console.log(`  ${mark} ${r.id}  got=${got} want=${want}  "${r.pattern}"  →  ${r.expected_tool}`);
}

if (failOnRegression && correct < total) {
  console.error(`\nFAIL: ${total - correct} regression(s).`);
  process.exit(1);
}
