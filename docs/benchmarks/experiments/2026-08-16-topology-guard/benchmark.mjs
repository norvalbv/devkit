#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { CASES, createFixture } from "./fixture.mjs";
import { runImportWallFixture } from "./import-wall-current.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const WARMUPS = 3;
const SAMPLES = 20;
const TIME_BIN = "/usr/bin/time";
const PS_BIN = "/bin/ps";

function processTreeRss(rootPid) {
  try {
    const rows = execFileSync(PS_BIN, ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
      .trim()
      .split("\n")
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
    userMs: value(/([0-9.]+)\s+user/, "user CPU") * 1000,
    systemMs: value(/([0-9.]+)\s+sys/, "system CPU") * 1000,
    directPeakRssBytes: value(/([0-9]+)\s+maximum resident set size/, "maximum resident set size"),
  };
}

async function measure(script, cwd, args) {
  const started = performance.now();
  const child = spawn(TIME_BIN, ["-lp", process.execPath, script, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let treePeakRssBytes = 0;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const sampler = setInterval(() => {
    treePeakRssBytes = Math.max(treePeakRssBytes, processTreeRss(child.pid));
  }, 10);
  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  clearInterval(sampler);
  if (status !== 0) {
    throw new Error(`timed command failed (${status}): ${stdout}\n${stderr}`);
  }
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

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const summarize = (samples) =>
  Object.fromEntries(
    ["wallMs", "cpuMs", "userMs", "systemMs", "treePeakRssBytes", "directPeakRssBytes"].map(
      (field) => [
        field,
        {
          median: median(samples.map((sample) => sample[field])),
          p95: p95(samples.map((sample) => sample[field])),
        },
      ],
    ),
  );

function resetFixture(root) {
  for (const relativePath of [
    "src",
    "eslint",
    "guard.config.json",
    "projectStructure.cache.json",
  ]) {
    rmSync(join(root, relativePath), { recursive: true, force: true });
  }
}

function runCurrentCase(root, bin) {
  const result = spawnSync(process.execPath, [bin, "gate"], { cwd: root, encoding: "utf8" });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    code: result.status ?? 2,
    errorCount: Number(text.match(/✖\s+(\d+)\s+problem/)?.[1] ?? 0),
    text,
  };
}

function runCandidateCase(root) {
  const output = execFileSync(process.execPath, [join(HERE, "candidate.mjs"), "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  return JSON.parse(output);
}

async function coverageMatrix(root, currentBin) {
  const rows = [];
  for (const fixtureCase of CASES) {
    resetFixture(root);
    createFixture(root, { caseId: fixtureCase.id, componentCount: 2 });
    const current = runCurrentCase(root, currentBin);
    const candidate = runCandidateCase(root);
    rows.push({
      ...fixtureCase,
      current: { code: current.code, errorCount: current.errorCount, text: current.text ?? "" },
      candidate: { code: candidate.code, diagnostics: candidate.diagnostics },
    });
  }

  resetFixture(root);
  mkdirSync(join(root, "src", "feature-a"), { recursive: true });
  mkdirSync(join(root, "src", "feature-b"), { recursive: true });
  writeFileSync(join(root, "src", "feature-a", "index.js"), "import '../feature-b/internal.js';\n");
  writeFileSync(join(root, "src", "feature-b", "internal.js"), "export const internal = true;\n");
  writeFileSync(
    join(root, "guard.config.json"),
    `${JSON.stringify({
      scanRoots: ["src"],
      sourceExtensions: ["js"],
      structure: {
        trees: [],
        walls: [{ from: "src/feature-a/**", disallow: "src/feature-b/**" }],
      },
    })}\n`,
  );
  const current = await runImportWallFixture(root);
  const candidate = runCandidateCase(root);
  rows.push({
    id: "import-wall",
    expectedViolation: true,
    currentBroaderEslintOwner: current,
    candidate: { code: candidate.code, diagnostics: candidate.diagnostics },
  });
  return rows;
}

function installPackedDevkit(root, packRoot) {
  writeFileSync(join(root, "package.json"), '{"private":true,"type":"module"}\n');
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", packRoot], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }),
  );
  const tarball = join(packRoot, packed[0].filename);
  execFileSync("bun", ["add", "--cwd", root, tarball, "--ignore-scripts"], { stdio: "ignore" });
  const packageRoot = join(root, "node_modules", "@norvalbv", "devkit");
  const installedPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const driver = join(root, "current-driver.mjs");
  writeFileSync(
    driver,
    "import { runStructureGate } from './node_modules/@norvalbv/devkit/dist/gate-engine/structure/run.mjs';\nawait runStructureGate(process.cwd());\n",
  );
  return {
    bin: join(packageRoot, "dist", "gate-engine", "structure", "run.mjs"),
    driver,
    version: installedPackage.version,
  };
}

async function benchmarkLane(root, caseId, currentScript, candidateScript) {
  resetFixture(root);
  createFixture(root, { caseId, componentCount: 80 });
  for (let index = 0; index < WARMUPS; index += 1) {
    await measure(currentScript, root, []);
    await measure(candidateScript, root, ["--bench"]);
  }
  const samples = { current: [], candidate: [] };
  for (let index = 0; index < SAMPLES; index += 1) {
    const order =
      index % 2 === 0
        ? [
            ["current", currentScript, []],
            ["candidate", candidateScript, ["--bench"]],
          ]
        : [
            ["candidate", candidateScript, ["--bench"]],
            ["current", currentScript, []],
          ];
    for (const [name, script, args] of order) {
      samples[name].push(await measure(script, root, args));
    }
  }
  return {
    fixtureCase: caseId,
    samples,
    summary: { current: summarize(samples.current), candidate: summarize(samples.candidate) },
  };
}

async function main() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "topology-benchmark-"));
  const packRoot = mkdtempSync(join(tmpdir(), "topology-package-"));
  const candidateScript = join(HERE, "candidate.mjs");
  try {
    const installed = installPackedDevkit(fixtureRoot, packRoot);
    const lanes = {
      clean: await benchmarkLane(fixtureRoot, "clean", installed.driver, candidateScript),
      placement: await benchmarkLane(fixtureRoot, "placement", installed.driver, candidateScript),
    };
    const results = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).trim(),
      host: {
        uname: execFileSync("uname", ["-a"], { encoding: "utf8" }).trim(),
        node: process.version,
        logicalCpuCount: Number(
          execFileSync("sysctl", ["-n", "hw.logicalcpu"], { encoding: "utf8" }).trim(),
        ),
      },
      protocol: {
        warmups: WARMUPS,
        samples: SAMPLES,
        order: "alternating current-first/candidate-first",
        fixture: { componentCount: 80, files: 481, roots: 1 },
        current: `packed @norvalbv/devkit@${installed.version} installed inside the fixture; driver invokes its runStructureGate API`,
        rss: "10ms sampling; sum RSS of /usr/bin/time wrapper and all descendants, floored by wait4 direct-child peak RSS",
        cpu: "/usr/bin/time -lp aggregate user + sys",
      },
      coverage: await coverageMatrix(fixtureRoot, installed.bin),
      lanes,
    };
    const outputIndex = process.argv.indexOf("--output");
    if (outputIndex >= 0) {
      const output = join(process.cwd(), process.argv[outputIndex + 1]);
      writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
    } else {
      console.log(JSON.stringify(results, null, 2));
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(packRoot, { recursive: true, force: true });
  }
}

await main();
