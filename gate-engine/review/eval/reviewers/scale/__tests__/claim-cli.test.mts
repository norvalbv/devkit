import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runClaimCli } from '../claim-cli.mts';
import { sha256 } from '../claim-inventory.mts';
import { archivedDiffPath, readArchivedDiff, readArchivedDiffEvidence } from '../labels.mts';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'claim-cli-'));
  roots.push(root);
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const diff = 'diff --git a/private.ts b/private.ts\n-private\n+private-new\n';
  const hash = sha256(diff);
  const archive = path.join(root, '.devkit', 'telemetry', 'diffs');
  mkdirSync(archive, { recursive: true });
  writeFileSync(path.join(archive, `${hash}.diff.gz`), gzipSync(diff));
  const bank = path.join(root, 'bank');
  mkdirSync(bank);
  const file = path.join(bank, 'results.json');
  writeFileSync(
    file,
    JSON.stringify({
      diff: hash,
      labels: [],
      rows: [
        {
          key: 'task',
          diff: hash,
          identity: 'identity',
          at: '2026-09-05T12:00:00Z',
          model: 'private-model',
          arm: 'private-arm',
          status: 'fail',
          issues: [],
          capture: {
            version: 1,
            provenance: 'exact-checklist',
            items: [
              {
                itemIndex: 0,
                lens: 'state',
                status: 'fail',
                issues: ['private.ts:10 private full claim'],
              },
            ],
          },
        },
      ],
    }),
  );
  return { root, bank, file, hash, out: path.join(root, '.devkit', 'research', 'census') };
}

it('decodes valid archived UTF-8 without stripping a recorded byte-order mark', () => {
  const { root } = fixture();
  const text = '\uFEFFdiff --git a/café.ts b/café.ts\n';
  const hash = sha256(text);
  writeFileSync(
    path.join(root, '.devkit', 'telemetry', 'diffs', `${hash}.diff.gz`),
    gzipSync(text),
  );
  expect(readArchivedDiffEvidence(hash)).toEqual({ text });
});

it('does not resolve a malformed census diff through a path outside the archive', () => {
  const { root } = fixture();
  writeFileSync(
    path.join(root, '.devkit', 'telemetry', 'escaped.diff.gz'),
    gzipSync('outside archive'),
  );
  expect(() => archivedDiffPath('../escaped')).toThrow(/SHA-256/);
  expect(readArchivedDiff('../escaped')).toBeNull();
});

function childClaimCli(root: string, argv: string[], movePublished = false) {
  const script = `import os from 'node:os';
    import { renameSync } from 'node:fs';
    os.homedir = () => process.argv[1];
    const { runClaimCli } = await import(process.argv[2]);
    const rename = process.argv[3] === 'move-published' ? (from, to) => {
      renameSync(from, to);
      renameSync(to, to + '.moved');
    } : renameSync;
    try { runClaimCli(process.argv.slice(4), rename); }
    catch (error) { console.error(error.message); process.exitCode = 1; }`;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    script,
    root,
    new URL('../claim-cli.mts', import.meta.url).href,
    movePublished ? 'move-published' : 'ordinary',
    ...argv,
  ]);
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.resume();
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

function childCensus(root: string, bank: string, file: string, out: string, movePublished = false) {
  return childClaimCli(root, ['census', '--namespace', bank, '--out', out, file], movePublished);
}

describe('offline claim CLI', () => {
  it.each([
    { state: 'absent', code: 'missing-diff' },
    { state: 'corrupt', code: 'invalid-diff-archive' },
    { state: 'invalid-utf8', code: 'invalid-diff-archive' },
    { state: 'unreadable', code: 'unreadable-diff-archive' },
  ])('preserves $state archive provenance without losing captured claims', ({ state, code }) => {
    const { bank, file, hash, out } = fixture();
    const archive = archivedDiffPath(hash);
    rmSync(archive);
    if (state === 'corrupt') writeFileSync(archive, 'not gzip');
    if (state === 'invalid-utf8') writeFileSync(archive, gzipSync(Buffer.from([0xff])));
    if (state === 'unreadable') mkdirSync(archive);
    expect(readArchivedDiffEvidence(hash)).toEqual({ text: null, error: code });
    runClaimCli(['census', '--namespace', bank, '--out', out, file]);
    const inventory = JSON.parse(readFileSync(path.join(out, 'inventory.json'), 'utf8'));
    expect(inventory.occurrences).toHaveLength(1);
    expect(inventory.tasks[0].errors).toContain(code);
    if (state !== 'absent') expect(inventory.tasks[0].errors).not.toContain('missing-diff');
    expect(inventory.errors).toContainEqual({ source: file, code });
  });

  it('writes blinded/private census files and a sanitized captured-only report', () => {
    const { root, bank, file, out } = fixture();
    runClaimCli(['census', '--namespace', bank, '--out', out, file]);
    const blind = readFileSync(path.join(out, 'phase1.json'), 'utf8');
    expect(blind).toContain('private full claim');
    expect(blind).not.toContain('private-model');
    expect(blind).not.toContain('private-arm');
    expect(readFileSync(path.join(out, 'mapping.private.json'), 'utf8')).toContain('private-model');
    const judgments = path.join(out, 'judgments.json');
    writeFileSync(judgments, '[]');
    const report = path.join(root, 'report.json');
    runClaimCli([
      'report',
      '--inventory',
      path.join(out, 'inventory.json'),
      '--judgments',
      judgments,
      '--out',
      report,
    ]);
    const raw = readFileSync(report, 'utf8');
    expect(JSON.parse(raw).factualPrecision).toMatchObject({ unresolved: 1, bounds: [0, 1] });
    for (const secret of ['private.ts', 'private full claim', 'private-model', bank])
      expect(raw).not.toContain(secret);
  });
  it('publishes one complete report, rejects conflicts, and accepts identical retries outside research', async () => {
    const { root, bank, file, out } = fixture();
    runClaimCli(['census', '--namespace', bank, '--out', out, file]);
    const other = path.join(root, '.devkit', 'research', 'other-census');
    const contender = path.join(bank, 'other-results.json');
    writeFileSync(
      contender,
      readFileSync(file, 'utf8').replace('private full claim', 'other full claim'),
    );
    runClaimCli(['census', '--namespace', bank, '--out', other, contender]);
    const judgments = path.join(root, 'judgments.json');
    writeFileSync(judgments, '[]');
    const args = (inventory: string, destination: string) => [
      'report',
      '--inventory',
      path.join(inventory, 'inventory.json'),
      '--judgments',
      judgments,
      '--out',
      destination,
    ];
    const expected = [out, other].map((inventory, i) => {
      const destination = path.join(root, `expected-${i}.json`);
      runClaimCli(args(inventory, destination));
      return readFileSync(destination, 'utf8');
    });
    expect(expected[0]).not.toBe(expected[1]);
    const publicDirectory = path.join(root, 'public-reports');
    mkdirSync(publicDirectory);
    chmodSync(publicDirectory, 0o755);
    const reportPath = path.join(publicDirectory, 'report.json');
    const results = await Promise.all([
      childClaimCli(root, args(out, reportPath)),
      childClaimCli(root, args(other, reportPath)),
    ]);
    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    const winner = results[0].code === 0 ? 0 : 1;
    const loser = 1 - winner;
    expect(results[loser].stderr).toContain('immutable conflict');
    const published = readFileSync(reportPath, 'utf8');
    expect(published).toBe(expected[winner]);
    expect(JSON.parse(published).schemaVersion).toBe(1);
    expect(statSync(publicDirectory).mode & 0o777).toBe(0o755);
    expect(statSync(reportPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(publicDirectory, '.pending')).mode & 0o777).toBe(0o700);
    const retry = await childClaimCli(root, args([out, other][winner], reportPath));
    expect(retry).toEqual({ code: 0, stderr: '' });
    const conflict = await childClaimCli(root, args([out, other][loser], reportPath));
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain('immutable conflict');
    expect(readFileSync(reportPath, 'utf8')).toBe(published);
  }, 30_000);
  it('records unreadable input files as errors instead of silently selecting a complete subset', () => {
    const { bank, file, out } = fixture();
    runClaimCli([
      'census',
      '--namespace',
      bank,
      '--out',
      out,
      file,
      path.join(bank, 'absent.json'),
    ]);
    expect(
      JSON.parse(readFileSync(path.join(out, 'inventory.json'), 'utf8')).errors,
    ).toContainEqual({ source: path.join(bank, 'absent.json'), code: 'unreadable-results-file' });
  });
  it('classifies readable malformed JSON as invalid input through the actual CLI process', async () => {
    const { root, bank, file, out } = fixture();
    writeFileSync(file, '{');
    const result = await childCensus(root, bank, file, out);
    expect(result).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(readFileSync(path.join(out, 'inventory.json'), 'utf8')).errors).toEqual([
      { source: file, code: 'invalid-results-file' },
    ]);
    expect(readFileSync(file, 'utf8')).toBe('{');
  });
  it('refuses success when the real published directory disappears before final verification', async () => {
    const { root, bank, file, out } = fixture();
    const result = await childCensus(root, bank, file, out, true);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Published census directory disappeared or changed');
    expect(existsSync(out)).toBe(false);
    expect(existsSync(path.join(`${out}.moved`, 'inventory.json'))).toBe(true);
  });
  it('rejects raw artifact destinations outside private research', () => {
    const { root, bank, file } = fixture();
    expect(() => runClaimCli(['census', '--namespace', bank, '--out', root, file])).toThrow(
      'must remain',
    );
  });
  it('refuses symlinked output ancestry before raw evidence can escape research', () => {
    const { root, bank, file } = fixture();
    const research = path.join(root, '.devkit', 'research');
    const outside = path.join(root, 'public');
    mkdirSync(research);
    mkdirSync(outside);
    symlinkSync(outside, path.join(research, 'redirect'));
    expect(() =>
      runClaimCli([
        'census',
        '--namespace',
        bank,
        '--out',
        path.join(research, 'redirect', 'census'),
        file,
      ]),
    ).toThrow('symlink');
    expect(existsSync(path.join(outside, 'census'))).toBe(false);
  });
  it('refuses every existing output without following or overwriting its entries', () => {
    const { root, bank, file, out } = fixture();
    mkdirSync(out, { recursive: true });
    const victim = path.join(root, 'unrelated.json');
    writeFileSync(victim, 'unchanged');
    symlinkSync(victim, path.join(out, 'inventory.json'));
    expect(() => runClaimCli(['census', '--namespace', bank, '--out', out, file])).toThrow(
      'already exists',
    );
    expect(readFileSync(victim, 'utf8')).toBe('unchanged');
    expect(existsSync(path.join(out, 'phase1.json'))).toBe(false);
  });
  it('publishes one complete private generation when two processes compete for the same output', async () => {
    const { root, bank, file, out } = fixture();
    const contender = path.join(bank, 'other-results.json');
    writeFileSync(
      contender,
      readFileSync(file, 'utf8').replace('private full claim', 'other full claim'),
    );
    const results = await Promise.all([
      childCensus(root, bank, file, out),
      childCensus(root, bank, contender, out),
    ]);
    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    expect(results.find((result) => result.code !== 0)?.stderr).toContain('already exists');
    const winner = results[0].code === 0 ? 'private full claim' : 'other full claim';
    const inventory = JSON.parse(readFileSync(path.join(out, 'inventory.json'), 'utf8'));
    const packets = JSON.parse(readFileSync(path.join(out, 'phase1.json'), 'utf8'));
    const templates = JSON.parse(readFileSync(path.join(out, 'judgments.template.json'), 'utf8'));
    const phase2 = JSON.parse(readFileSync(path.join(out, 'phase2.json'), 'utf8'));
    const mapping = JSON.parse(readFileSync(path.join(out, 'mapping.private.json'), 'utf8'));
    expect(inventory.occurrences[0].text).toContain(winner);
    expect(packets[0].claim).toBe(inventory.occurrences[0].text);
    for (const occurrence of [
      packets[0],
      templates[0],
      phase2.occurrences[0],
      mapping.occurrenceTasks[0],
    ])
      expect(occurrence.occurrenceId).toBe(inventory.occurrences[0].occurrenceId);
    expect(mapping.tasks).toEqual(inventory.tasks);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    for (const name of [
      'inventory.json',
      'phase1.json',
      'judgments.template.json',
      'phase2.json',
      'mapping.private.json',
    ])
      expect(statSync(path.join(out, name)).mode & 0o777).toBe(0o600);
  }, 30_000);
  it('validates nested inventory fields before reporting instead of stripping malformed evidence', () => {
    const { root, bank, file, out } = fixture();
    runClaimCli(['census', '--namespace', bank, '--out', out, file]);
    const inventoryFile = path.join(out, 'inventory.json');
    const original = readFileSync(inventoryFile, 'utf8');
    const judgments = path.join(out, 'judgments.json');
    writeFileSync(judgments, '[]');
    const report = path.join(root, 'report.json');
    for (const corrupt of [
      original.replace('"terminal": true', '"terminal": [true]'),
      original.replace('"textSha256":', '"unsupportedEvidence": true, "textSha256":'),
      original.replace('"issueIndex": 0', '"issueIndex": "zero"'),
    ]) {
      expect(corrupt).not.toBe(original);
      writeFileSync(inventoryFile, corrupt);
      expect(() =>
        runClaimCli([
          'report',
          '--inventory',
          inventoryFile,
          '--judgments',
          judgments,
          '--out',
          report,
        ]),
      ).toThrow();
    }
  });
});
