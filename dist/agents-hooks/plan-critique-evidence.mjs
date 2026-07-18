#!/usr/bin/env node
// Fail-open provider hook for plan-critique evidence. Runtime state is written only beneath
// ~/.devkit/evidence and the worktree git directory; this script never writes into .claude,
// .cursor, .codex, or the repository working tree.

import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [provider, event] = process.argv.slice(2);
if (!['claude', 'codex', 'cursor'].includes(provider)) process.exit(0);
if (!['subagent-stop', 'stop', 'commit-projection'].includes(event)) process.exit(0);
const method =
  event === 'subagent-stop'
    ? 'captureSubagentStop'
    : event === 'stop'
      ? 'observePlanStop'
      : 'observeCommitProjection';

let input = {};
if (event !== 'commit-projection') {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.exit(0);
  }
}

const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
const roots = [];
for (let current = resolve(cwd); ; current = dirname(current)) {
  roots.push(current);
  if (dirname(current) === current) break;
}
const candidates = roots.flatMap((root) => [
  join(root, 'node_modules', '@norvalbv', 'devkit', 'dist', 'gate-engine', 'critique', 'capture.mjs'),
  join(root, 'node_modules', '@norvalbv', 'devkit', 'gate-engine', 'critique', 'capture.mts'),
  join(root, 'gate-engine', 'critique', 'capture.mts'),
]);
let capture = null;
for (const candidate of candidates) {
  try {
    if (!statSync(candidate).isFile()) continue;
    const loaded = await import(pathToFileURL(resolve(candidate)).href);
    if (typeof loaded[method] !== 'function') continue;
    capture = loaded;
    break;
  } catch {
    // A broken nearer runtime must not suppress a valid ancestor installation.
  }
}
if (!capture) process.exit(0);

try {
  if (event === 'commit-projection') capture[method](cwd);
  else capture[method](provider, input, cwd);
} catch {
  // Capture is telemetry and must never block the provider or commit chain.
}
