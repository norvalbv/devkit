#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const CONTROL_REF = 'origin/main';
const WARMUPS = 3;
const SAMPLES = 10;
const TIME_BIN = '/usr/bin/time';
const PS_BIN = '/bin/ps';

const COMMANDS = {
  control: 'bun run lint',
  candidate: 'bun run lint',
};

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', ...options }).trim();
}

function processTreeRss(rootPid) {
  try {
    const rows = execFileSync(PS_BIN, ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, parent, rss]) => pid > 0 && parent >= 0 && rss >= 0);
    const children = new Map();
    const rssByPid = new Map();
    for (const [pid, parent, rss] of rows) {
      rssByPid.set(pid, rss);
      const siblings = children.get(parent) ?? [];
      siblings.push(pid);
      children.set(parent, siblings);
    }
    const pending = [rootPid];
    const seen = new Set();
    let kib = 0;
    while (pending.length > 0) {
      const pid = pending.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      kib += rssByPid.get(pid) ?? 0;
      pending.push(...(children.get(pid) ?? []));
    }
    return kib * 1024;
  } catch {
    return 0;
  }
}

function parseTime(stderr) {
  const value = (pattern, label) => {
    const match = stderr.match(pattern);
    if (!match) throw new Error(`/usr/bin/time output omitted ${label}`);
    return Number(match[1]);
  };
  return {
    userMs: value(/([0-9.]+)\s+user/, 'user CPU') * 1000,
    systemMs: value(/([0-9.]+)\s+sys/, 'system CPU') * 1000,
    directPeakRssBytes: value(
      /([0-9]+)\s+maximum resident set size/,
      'maximum resident set size',
    ),
  };
}

async function measure(command, cwd) {
  const started = performance.now();
  const child = spawn(TIME_BIN, ['-lp', 'sh', '-c', command], {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let treePeakRssBytes = 0;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const sampler = setInterval(() => {
    treePeakRssBytes = Math.max(treePeakRssBytes, processTreeRss(child.pid));
  }, 10);
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  clearInterval(sampler);
  if (status !== 0) throw new Error(`timed command failed (${status}): ${stdout}\n${stderr}`);
  const timing = parseTime(stderr);
  return {
    wallMs: performance.now() - started,
    cpuMs: timing.userMs + timing.systemMs,
    userMs: timing.userMs,
    systemMs: timing.systemMs,
    treePeakRssBytes: Math.max(treePeakRssBytes, timing.directPeakRssBytes),
    directPeakRssBytes: timing.directPeakRssBytes,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function p95(values) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
}

function summarize(samples) {
  return Object.fromEntries(
    ['wallMs', 'cpuMs', 'userMs', 'systemMs', 'treePeakRssBytes', 'directPeakRssBytes'].map(
      (field) => [
        field,
        {
          median: median(samples.map((sample) => sample[field])),
          p95: p95(samples.map((sample) => sample[field])),
        },
      ],
    ),
  );
}

function prepareControl(tempRoot) {
  const control = join(tempRoot, 'control');
  mkdirSync(control, { recursive: true });
  const archive = execFileSync('git', ['archive', CONTROL_REF], {
    cwd: REPO_ROOT,
    maxBuffer: 128 * 1024 * 1024,
  });
  const extracted = spawnSync('tar', ['-x', '-C', control], { input: archive });
  if (extracted.status !== 0) throw new Error(`control archive extraction failed: ${extracted.stderr}`);
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(control, 'node_modules'), 'dir');
  return control;
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'devkit-oxlint-adoption-benchmark-'));
  try {
    const control = prepareControl(tempRoot);
    const roots = { control, candidate: REPO_ROOT };
    for (let index = 0; index < WARMUPS; index += 1) {
      await measure(COMMANDS.control, roots.control);
      await measure(COMMANDS.candidate, roots.candidate);
    }
    const samples = { control: [], candidate: [] };
    for (let index = 0; index < SAMPLES; index += 1) {
      const order = index % 2 === 0 ? ['control', 'candidate'] : ['candidate', 'control'];
      for (const side of order) samples[side].push(await measure(COMMANDS[side], roots[side]));
    }
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          recordedAt: new Date().toISOString(),
          source: {
            controlRef: CONTROL_REF,
            controlCommit: git(REPO_ROOT, ['rev-parse', CONTROL_REF]),
            candidateCommit: git(REPO_ROOT, ['rev-parse', 'HEAD']),
          },
          host: {
            uname: execFileSync('uname', ['-a'], { encoding: 'utf8' }).trim(),
            node: process.version,
            bun: execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(),
            logicalCpuCount: Number(
              execFileSync('sysctl', ['-n', 'hw.logicalcpu'], { encoding: 'utf8' }).trim(),
            ),
          },
          protocol: {
            warmups: WARMUPS,
            samples: SAMPLES,
            order: 'alternating control-first/candidate-first',
            control: 'clean origin/main archive with its original bun run lint script',
            candidate: 'this candidate worktree with its proposed bun run lint script',
            dependencies: 'shared installed node_modules, excluded from timing',
            cpu: '/usr/bin/time -lp aggregate user + sys; primary decision metric',
            rss: '10ms sampling; sum RSS of /usr/bin/time wrapper and all descendants',
          },
          commands: COMMANDS,
          samples,
          summary: { control: summarize(samples.control), candidate: summarize(samples.candidate) },
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
