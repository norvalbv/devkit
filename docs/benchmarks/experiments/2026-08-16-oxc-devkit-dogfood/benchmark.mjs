#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
const LOCAL_FIXTURE = 'skills/_devkit/checklist-store.mjs';

const FULL_COMMANDS = {
  control: 'bun run lint && bun run lint:structure && bun run typecheck',
  candidate:
    'bun run format:check && bun run lint && bun run lint:anti-slop && bun run lint:structure && bun run typecheck',
};

const LOCAL_COMMANDS = {
  control:
    'sh "$DEVKIT_FORMAT_FRAGMENT" && bun run lint && bun run lint:structure && bun run benchmarks:check -- --mode staged',
  candidate:
    'sh "$DEVKIT_FORMAT_FRAGMENT" && bun run lint && node cli/index.mts anti-slop check --staged && bun run lint:structure && bun run benchmarks:check -- --mode staged',
};

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

async function measure(command, cwd, env = {}) {
  const started = performance.now();
  const child = spawn(TIME_BIN, ['-lp', 'sh', '-c', command], {
    cwd,
    env: { ...process.env, NO_COLOR: '1', ...env },
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

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', ...options }).trim();
}

function commitFixture(root) {
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  git(root, [
    '-c',
    'user.name=Devkit benchmark',
    '-c',
    'user.email=benchmark@invalid',
    'commit',
    '-qm',
    'benchmark fixture',
  ]);
}

function extractFormatFragment(root, outputPath) {
  const hook = readFileSync(join(root, '.husky', 'pre-commit'), 'utf8');
  const fragment = hook.match(/# devkit:biome-format[\s\S]*?# \/devkit:biome-format/)?.[0];
  if (!fragment) throw new Error(`formatter fragment missing from ${root}/.husky/pre-commit`);
  writeFileSync(outputPath, `${fragment}\n`);
}

function prepareMirrors(tempRoot) {
  const control = join(tempRoot, 'control');
  const candidate = join(tempRoot, 'candidate');
  mkdirSync(control, { recursive: true });
  mkdirSync(candidate, { recursive: true });

  const archive = execFileSync('git', ['archive', CONTROL_REF], {
    cwd: REPO_ROOT,
    maxBuffer: 128 * 1024 * 1024,
  });
  const extracted = spawnSync('tar', ['-x', '-C', control], { input: archive });
  if (extracted.status !== 0) throw new Error(`control archive extraction failed: ${extracted.stderr}`);
  execFileSync('git', ['checkout-index', '--all', `--prefix=${candidate}/`], { cwd: REPO_ROOT });

  for (const root of [control, candidate]) {
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    commitFixture(root);
  }

  const fragments = {
    control: join(tempRoot, 'control-format.sh'),
    candidate: join(tempRoot, 'candidate-format.sh'),
  };
  extractFormatFragment(control, fragments.control);
  extractFormatFragment(candidate, fragments.candidate);
  return { control, candidate, fragments };
}

function stageLocalFixture(root) {
  git(root, ['checkout', '--', LOCAL_FIXTURE]);
  const path = join(root, LOCAL_FIXTURE);
  writeFileSync(path, `${readFileSync(path, 'utf8').trimEnd()}\n\n`);
  git(root, ['add', LOCAL_FIXTURE]);
}

async function runLane(name, roots, fragments, commands, reset) {
  const samples = { control: [], candidate: [] };
  for (let index = 0; index < WARMUPS; index += 1) {
    for (const side of ['control', 'candidate']) {
      reset?.(roots[side]);
      await measure(commands[side], roots[side], {
        DEVKIT_FORMAT_FRAGMENT: fragments[side],
      });
    }
  }
  for (let index = 0; index < SAMPLES; index += 1) {
    const order = index % 2 === 0 ? ['control', 'candidate'] : ['candidate', 'control'];
    for (const side of order) {
      reset?.(roots[side]);
      samples[side].push(
        await measure(commands[side], roots[side], {
          DEVKIT_FORMAT_FRAGMENT: fragments[side],
        }),
      );
    }
  }
  return {
    name,
    commands,
    samples,
    summary: {
      control: summarize(samples.control),
      candidate: summarize(samples.candidate),
    },
  };
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'devkit-dogfood-benchmark-'));
  try {
    const { control, candidate, fragments } = prepareMirrors(tempRoot);
    const roots = { control, candidate };
    const local = await runLane(
      'local deterministic quality segment',
      roots,
      fragments,
      LOCAL_COMMANDS,
      stageLocalFixture,
    );
    const full = await runLane('full repository static-quality segment', roots, fragments, FULL_COMMANDS);
    const results = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      source: {
        controlRef: CONTROL_REF,
        controlCommit: git(REPO_ROOT, ['rev-parse', CONTROL_REF]),
        candidateTree: git(REPO_ROOT, ['write-tree']),
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
        control: 'clean origin/main archive',
        candidate: 'exact staged index exported with git checkout-index',
        dependencies: 'shared installed node_modules, excluded from timing',
        localFixture: `one extra trailing blank line staged in ${LOCAL_FIXTURE} before every sample`,
        scope:
          'unchanged ratchet, benchmark-evidence, test, reviewer, and completeness lanes excluded from both sides',
        rss: '10ms sampling; sum RSS of /usr/bin/time wrapper and all descendants',
        cpu: '/usr/bin/time -lp aggregate user + sys',
      },
      lanes: { local, full },
    };
    const outputIndex = process.argv.indexOf('--output');
    if (outputIndex >= 0) {
      writeFileSync(join(process.cwd(), process.argv[outputIndex + 1]), `${JSON.stringify(results, null, 2)}\n`);
    } else {
      console.log(JSON.stringify(results, null, 2));
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
