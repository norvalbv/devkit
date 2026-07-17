#!/usr/bin/env node
// Fail-open provider hook for plan-critique evidence. Runtime state is written only beneath
// ~/.devkit/evidence and the worktree git directory; this script never writes into .claude,
// .cursor, .codex, or the repository working tree.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [provider, event] = process.argv.slice(2);
if (!['claude', 'codex', 'cursor'].includes(provider)) process.exit(0);
if (!['subagent-stop', 'stop', 'commit-projection'].includes(event)) process.exit(0);

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
const candidates = [
  join(cwd, 'node_modules', '@norvalbv', 'devkit', 'dist', 'gate-engine', 'critique', 'capture.mjs'),
  join(cwd, 'node_modules', '@norvalbv', 'devkit', 'gate-engine', 'critique', 'capture.mts'),
  join(cwd, 'gate-engine', 'critique', 'capture.mts'),
];
const modulePath = candidates.find(existsSync);
if (!modulePath) process.exit(0);

try {
  const capture = await import(pathToFileURL(resolve(modulePath)).href);
  if (event === 'subagent-stop') capture.captureSubagentStop(provider, input, cwd);
  else if (event === 'stop') capture.observePlanStop(provider, input, cwd);
  else capture.observeCommitProjection(cwd);
} catch {
  // Capture is telemetry and must never block the provider or commit chain.
}
