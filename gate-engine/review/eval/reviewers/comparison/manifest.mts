// @ts-nocheck — BENCH-ONLY; validates the frozen PR605 artifact contract.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BENCH_REVIEWERS, buildAssets } from '../corpus.mts';
import { canonical, sha256 } from '../scale/claim-inventory.mts';
export { canonical, sha256 };
export const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
export const PREPARATION = 'docs/benchmarks/experiments/2026-09-06-correctness-reachable-witness';
// PR605 merge 05dcafae: changing this pin requires a separately reviewed experiment.
const PROTOCOL_SHA256 = '71ddd7fb5412fa53069b6a4845f123d5aa43af28e4bc17f84aae6ac8012a86d5';
export const GROUPS = [
  ['state-transitions'],
  ['concurrency-races'],
  ['writer-reader-contracts'],
  ['error-and-edge-classification'],
];
export const MODEL = 'gpt-5.6-sol';
function match(bytes, hash, label) {
  if (sha256(bytes) !== hash) throw new Error(`hash mismatch: ${label}`);
}
const sourceSchema = z.strictObject({
  base: z.record(z.string(), z.string()),
  staged: z.record(z.string(), z.string().nullable()),
});
const packetSchema = z.object({
  probeId: z.string(),
  files: z.array(z.strictObject({ path: z.string(), sha256: z.string() })).min(1),
  text: z.string(),
  sha256: z.string(),
});
export function validateSource(repo) {
  const parsed = sourceSchema.parse(repo);
  for (const view of ['base', 'staged']) {
    for (const file of Object.keys(parsed[view])) {
      if (
        !/^(api\/|web\/|src\/|package\.json$)/.test(file) ||
        file.includes('\\') ||
        file.split('/').some((p) => !p || p === '..' || p === '.')
      )
        throw new Error(`invalid source path/value: ${file}`);
    }
  }
}
export function validatePacket(probe, packet) {
  packet = packetSchema.parse(packet);
  if (packet.probeId !== probe.id) throw new Error('missing probe packet');
  const seen = new Set();
  const texts = packet.files.map((file) => {
    const source = probe.repo.base[file.path];
    if (
      seen.has(file.path) ||
      Object.hasOwn(probe.repo.staged, file.path) ||
      !Object.hasOwn(probe.repo.base, file.path)
    )
      throw new Error('packet requires unique unchanged source');
    seen.add(file.path);
    match(source, file.sha256, file.path);
    return `FILE: ${file.path}\n${source}`;
  });
  const text =
    'Supplemental source context (unchanged files; not part of the staged diff):\n\n' +
    texts.join('\n');
  if (text !== packet.text) throw new Error('packet text differs from source');
  match(text, packet.sha256, 'packet');
  return text;
}
const INSTRUCTION_ASSETS = new Map([
  ['agents/correctness-reviewer.md', '.claude/agents/correctness-reviewer.md'],
  ['skills/correctness/SKILL.md', '.claude/skills/correctness/SKILL.md'],
]);
function candidateAssets(dir, arm, baseline, historicalInstructions) {
  const patch = readFileSync(path.join(dir, arm.artifact));
  match(patch, arm.patchSha256, arm.artifact);
  const changes = arm.sourceChanges ?? [
    { path: arm.target, beforeSha256: arm.beforeSha256, afterSha256: arm.afterSha256 },
  ];
  const temp = mkdtempSync(path.join(tmpdir(), 'comparison-assets-'));
  try {
    for (const change of changes) {
      if (!INSTRUCTION_ASSETS.has(change.path))
        throw new Error('candidate path outside reviewer instructions');
      const source = baseline[INSTRUCTION_ASSETS.get(change.path)];
      match(source, change.beforeSha256, change.path);
      const dest = path.join(temp, change.path);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, source);
    }
    const args = ['apply', '--check', '-'];
    const options = { cwd: temp, input: patch, timeout: 30_000, maxBuffer: 1024 * 1024 };
    execFileSync('git', args, options);
    execFileSync('git', ['apply', '-'], options);
    const overrides = { ...historicalInstructions };
    for (const change of changes) {
      const source = readFileSync(path.join(temp, change.path), 'utf8');
      match(source, change.afterSha256, change.path);
      overrides[INSTRUCTION_ASSETS.get(change.path)] = source;
    }
    return { overrides, sha256: sha256(canonical({ ...baseline, ...overrides })) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
/** Hashes validate consistency, never provenance truth or a claimed clean label. */
export function loadComparison(root = ROOT) {
  const dir = path.join(root, PREPARATION),
    protocolText = readFileSync(path.join(dir, 'protocol.json'), 'utf8');
  match(protocolText, PROTOCOL_SHA256, 'frozen PR605 protocol');
  const protocol = z
    .object({ sourceFilesSha256: z.record(z.string(), z.string()) })
    .passthrough()
    .parse(JSON.parse(protocolText));
  const reviewer = BENCH_REVIEWERS.find((r) => r.name === 'correctness-reviewer');
  if (reviewer.model !== MODEL)
    throw new Error('effective correctness model differs from registration');
  const historicalSources = {};
  const historicalInstructions = {};
  for (const [file, hash] of Object.entries(protocol.sourceFilesSha256)) {
    const old = execFileSync('git', ['show', `${protocol.sourceRevision}:${file}`], {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    match(old, hash, `preparation source ${file}`);
    const asset = INSTRUCTION_ASSETS.get(file);
    if (asset) historicalInstructions[asset] = old.toString('utf8');
    const current = readFileSync(path.join(root, file));
    historicalSources[file] = {
      prepared: hash,
      current: sha256(current),
    };
    // Corpus growth may append rows; the frozen experiment still requires every historical byte.
    if (file.endsWith('cases-correctness.jsonl') && !current.subarray(0, old.length).equals(old))
      throw new Error(`fixed experiment corpus must preserve its historical prefix: ${file}`);
    if (
      (file.startsWith('agents/') ||
        file.startsWith('skills/') ||
        file === 'gate-engine/review/reviewers.mts') &&
      !INSTRUCTION_ASSETS.has(file) &&
      historicalSources[file].current !== hash
    )
      throw new Error(`fixed experiment source changed: ${file}`);
  }
  const lines = readFileSync(
    path.join(root, 'gate-engine/review/eval/reviewers/cases-correctness.jsonl'),
    'utf8',
  ).match(/[^\n]+\n/g);
  const rawRows = new Map(lines.map((line) => [JSON.parse(line).id, line]));
  const rows = protocol.cohort.map((entry) => {
    const line = rawRows.get(entry.id);
    match(line ?? '', entry.rawLineSha256, entry.id);
    const row = JSON.parse(line);
    validateSource(row.repo);
    return row;
  });
  const draftsText = readFileSync(path.join(dir, 'draft-cases.json'), 'utf8');
  match(draftsText, protocol.exploratoryProbes.sha256, 'probes');
  const drafts = JSON.parse(draftsText),
    pins = new Map(protocol.exploratoryProbes.probes.map((p) => [p.id, p]));
  const probes = drafts.probes.map((entry) => {
    const p = entry.probe,
      pin = pins.get(p.id);
    if (
      !pin ||
      entry.scoring !== 'forbidden-unanchored-probe' ||
      Object.keys(p).some((k) => !['id', 'familyId', 'repo'].includes(k))
    )
      throw new Error('invalid unscored probe');
    match(canonical(p), pin.probeSha256, p.id);
    validateSource(p.repo);
    return p;
  });
  if (rows.length !== 8 || probes.length !== 7 || new Set(probes.map((p) => p.id)).size !== 7)
    throw new Error('unexpected roster');
  const packetText = readFileSync(path.join(dir, 'context-packets.json'), 'utf8');
  match(packetText, protocol.arms.find((a) => a.id === 'C').sha256, 'packets');
  const packetEntries = JSON.parse(packetText).packets;
  const packets = new Map(packetEntries.map((p) => [p.probeId, p]));
  if (packets.size !== 7 || packetEntries.length !== 7) throw new Error('unexpected packet roster');
  for (const probe of probes) validatePacket(probe, packets.get(probe.id));
  const baseline = { ...buildAssets(reviewer), ...historicalInstructions },
    base = { overrides: historicalInstructions, sha256: sha256(canonical(baseline)) };
  const assets = { B: base, C: base };
  for (const id of ['P', 'L'])
    assets[id] = candidateAssets(
      dir,
      protocol.arms.find((a) => a.id === id),
      baseline,
      historicalInstructions,
    );
  return {
    rows,
    probes,
    packets,
    assets,
    historicalSources,
    protocolSha256: PROTOCOL_SHA256,
    protocol,
  };
}
export function schedule(comparison, phase) {
  if (!['scored', 'exploratory'].includes(phase))
    throw new Error('phase must be scored or exploratory');
  const sources = phase === 'scored' ? comparison.rows : comparison.probes;
  const arms = phase === 'scored' ? ['B', 'P', 'L'] : ['B', 'P', 'L', 'C'];
  const family = (row) => row.familyId ?? row.caseId ?? row.id;
  return [0, 1].flatMap((round) =>
    [...new Set(sources.map(family))].flatMap((id) =>
      (round ? [...arms].reverse() : arms).flatMap((arm) =>
        sources
          .filter((row) => family(row) === id)
          .map((row) => ({
            key: `${phase}/${round + 1}/${arm}/${row.id}`,
            round: round + 1,
            arm,
            id: row.id,
            family: id,
            phase,
          })),
      ),
    ),
  );
}
