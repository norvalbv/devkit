import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runFlow } from '../lib/machine/flow.mts';
import {
  evidenceDir,
  provenance,
  readManifest,
  recordFlow,
  workingTree,
} from '../lib/machine/manifest.mts';
import { testExecFileSync } from './_helpers.mts';

const PAGE = `<h1 id="t">machine fixture</h1><button id="b" onclick="t.textContent='clicked'">Go</button>`;
const browserReady = await chromium.launch().then(
  (browser) => browser.close().then(() => true),
  () => false,
);

const temps: string[] = [];
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((_, res) => res.end(PAGE));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  // SAFETY: a server listening on a TCP port reports its address as AddressInfo, never a string.
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'machine-capture-'));
  temps.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  testExecFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-qm',
      'init',
    ],
    { cwd: root },
  );
  return root;
}

function flowFile(root: string, name: string, body: string): string {
  const file = join(root, `${name}.mjs`);
  writeFileSync(
    file,
    `import assert from 'node:assert/strict';\nexport default async ({ page, url, shot }) => {\n${body}\n};\n`,
  );
  return file;
}

async function capture(root: string, flowPath: string) {
  const profile = mkdtempSync(join(tmpdir(), 'machine-profile-'));
  temps.push(profile);
  const evidence = evidenceDir(root);
  return { evidence, result: await runFlow({ root, flowPath, url, profile, evidence }) };
}

const CLICK = `await page.goto(url);\nawait shot('start');\nawait page.click('#b');\nawait page.locator('#t', { hasText: 'clicked' }).waitFor();`;

describe.runIf(browserReady)('machine capture (headless browser)', () => {
  it('records a passing flow as a video plus named and final screenshots, all passed', async () => {
    const root = repo();
    const { evidence, result } = await capture(root, flowFile(root, 'click', CLICK));
    expect(result).toMatchObject({ flow: 'click', passed: true });
    const files = readManifest(evidence).map(({ file, kind, passed }) => ({ file, kind, passed }));
    expect(files).toEqual([
      { file: 'click.webm', kind: 'video', passed: true },
      { file: 'click.start.png', kind: 'screenshot', passed: true },
      { file: 'click.final.png', kind: 'screenshot', passed: true },
    ]);
    for (const { file, bytes, tree } of readManifest(evidence)) {
      expect(existsSync(join(evidence, file))).toBe(true);
      expect(bytes).toBeGreaterThan(0);
      expect(tree).toMatch(/^[0-9a-f]{40}$/);
    }
  }, 60_000);

  it('records a throwing flow as failed and keeps its video locally', async () => {
    const root = repo();
    const flow = flowFile(
      root,
      'wrong',
      `await page.goto(url);\nassert.equal(await page.locator('#t').textContent(), 'nope');`,
    );
    const { evidence, result } = await capture(root, flow);
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/nope/);
    expect(readManifest(evidence)).toMatchObject([{ file: 'wrong.webm', passed: false }]);
  }, 60_000);

  it('records a flow that cannot even be imported as failed, with its video', async () => {
    const root = repo();
    const broken = join(root, 'broken.mjs');
    writeFileSync(broken, 'export default async ({ page }) => { this is not javascript };\n');
    const { evidence, result } = await capture(root, broken);
    expect(result.passed).toBe(false);
    expect(readManifest(evidence)).toMatchObject([{ file: 'broken.webm', passed: false }]);
  }, 60_000);

  it('lists a screenshot taken twice under one name once', async () => {
    const root = repo();
    const twice = `await page.goto(url);\nawait shot('x');\nawait shot('x');\nawait shot('final');`;
    const { evidence } = await capture(root, flowFile(root, 'twice', twice));
    expect(readManifest(evidence).map(({ file }) => file)).toEqual([
      'twice.webm',
      'twice.x.png',
      'twice.final.png',
    ]);
  }, 60_000);

  it("keeps each flow's shots in files of their own, and refuses a shot name it would rewrite", async () => {
    const root = repo();
    const { evidence } = await capture(
      root,
      flowFile(root, 'checkout-cart', 'await page.goto(url);'),
    );
    const cart = `await page.goto(url);\nawait shot('cart-final');`;
    await capture(root, flowFile(root, 'checkout', cart));
    const shots = readManifest(evidence).filter(({ kind }) => kind === 'screenshot');
    expect(shots.map(({ file }) => file).sort()).toEqual([
      'checkout-cart.final.png',
      'checkout.cart-final.png',
      'checkout.final.png',
    ]);
    const renamed = await capture(root, flowFile(root, 'spaced', "await shot('cart final');"));
    expect(renamed.result.error).toContain('shot name "cart final" may hold only');
  }, 90_000);

  it("replaces a flow's earlier entries and files when it runs again", async () => {
    const root = repo();
    const flow = flowFile(root, 'click', CLICK);
    const { evidence } = await capture(root, flow);
    writeFileSync(flow, `export default async ({ page, url }) => { await page.goto(url); };\n`);
    await capture(root, flow);
    expect(readManifest(evidence).map(({ file }) => file)).toEqual([
      'click.webm',
      'click.final.png',
    ]);
    expect(existsSync(join(evidence, 'click.start.png'))).toBe(false);
  }, 90_000);
});

describe('machine evidence location and provenance', () => {
  it('records only the captures still on disk, so a clear mid-run leaves no dangling entry', () => {
    const root = repo();
    const evidence = evidenceDir(root);
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, 'f-kept.png'), 'png');
    const files = [
      { file: 'f-kept.png', kind: 'screenshot' as const },
      { file: 'f-cleared.png', kind: 'screenshot' as const },
    ];
    const entries = recordFlow(evidence, 'f', files, { ...provenance(root), passed: true });
    expect(entries.map(({ file }) => file)).toEqual(['f-kept.png']);
    expect(readManifest(evidence).map(({ file }) => file)).toEqual(['f-kept.png']);
  });

  it('refuses a flow name that would have to be rewritten to name its files', async () => {
    const root = repo();
    const flow = join(root, 'checkout flow.mjs');
    writeFileSync(flow, 'export default async () => {};\n');
    await expect(capture(root, flow)).rejects.toThrow('may hold only letters, digits');
  });

  it('keeps a linked worktree its own evidence dir', () => {
    const root = repo();
    const linked = `${root}-linked`;
    temps.push(linked);
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'other', linked], { cwd: root });
    expect(evidenceDir(linked)).not.toBe(evidenceDir(root));
    expect(evidenceDir(linked)).toContain(join('.git', 'worktrees'));
  });

  it('hashes the working tree, untracked files included, without touching the real index', () => {
    const root = repo();
    const before = workingTree(root);
    writeFileSync(join(root, 'new.txt'), 'x\n');
    expect(workingTree(root)).not.toBe(before);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe(
      '?? new.txt\n',
    );
  });
});
