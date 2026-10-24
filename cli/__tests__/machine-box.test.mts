import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import getPort from 'get-port';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Box,
  boxOutput,
  boxRunning,
  ensureImage,
  removeBox,
  screenshot,
  startBox,
  startRecording,
  stopRecording,
  viewUrl,
} from '../lib/machine/box.mts';
import { waitForHttp } from '../lib/machine/app.mts';
import { runFlow } from '../lib/machine/flow.mts';
import { evidenceDir, readManifest } from '../lib/machine/manifest.mts';
import { testExecFileSync } from './_helpers.mts';

const execFileAsync = promisify(execFile);

// A real box needs Docker Desktop: on a Linux engine the box cannot reach a host app on 127.0.0.1.
const dockerReady =
  process.platform === 'darwin' && spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

const PAGE = `<h1 id="t">box fixture</h1><button id="b" style="position:fixed;left:0;top:0;width:400px;height:300px" onclick="t.textContent='clicked'">Go</button>`;

const temps: string[] = [];
let server: Server;
let port: number;
let box: Box;
let root: string;

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'machine-box-'));
  temps.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  const identity = ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t'];
  testExecFileSync('git', [...identity, 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

function flowFile(name: string, body: string): string {
  const file = join(root, `${name}.mjs`);
  const head = "import assert from 'node:assert/strict';";
  writeFileSync(
    file,
    `${head}\nexport default async ({ page, url, shot, exec }) => {\n${body}\n};\n`,
  );
  return file;
}

const run = (flowPath: string) =>
  runFlow({
    root,
    flowPath,
    url: `http://127.0.0.1:${port}`,
    profile: '',
    evidence: evidenceDir(root),
    box,
  });

beforeAll(async () => {
  if (!dockerReady) return;
  ensureImage(join(tmpdir(), 'machine-box-image.log'), () => undefined);
  server = createServer((_, res) => res.end(PAGE));
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => done());
  });
  // SAFETY: a server listening on a TCP port reports its address as AddressInfo, never a string.
  port = (server.address() as AddressInfo).port;
  root = repo();
  const [view, cdp] = [await getPort(), await getPort()];
  box = { name: `devkit-machine-test-${process.pid}`, view, cdp, password: 'testpass' };
  startBox(box, root, port, null);
  const devtools = `http://127.0.0.1:${cdp}/json/version`;
  if (!(await waitForHttp(devtools, () => boxRunning(box.name), 60_000)))
    throw new Error(`the test box never answered DevTools; see \`docker logs ${box.name}\``);
}, 600_000);

afterAll(() => {
  if (box) removeBox(box.name);
  server?.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(dockerReady)('machine box (full mode, real Docker)', () => {
  it("opens the host app at the slot's own 127.0.0.1 URL and drives it with xdotool and CDP", async () => {
    const flow = flowFile(
      'click',
      [
        'await page.goto(url);',
        "exec(['xdotool', 'mousemove', '200', '250', 'click', '1']);",
        "await page.locator('#t', { hasText: 'clicked' }).waitFor({ timeout: 10_000 });",
        "assert.match(exec(['uname', '-s']), /Linux/);",
      ].join('\n'),
    );
    const result = await run(flow);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ flow: 'click', passed: true });
    expect(readManifest(evidenceDir(root)).map(({ file, kind }) => ({ file, kind }))).toEqual([
      { file: 'click.mp4', kind: 'video' },
      { file: 'click.final.png', kind: 'screenshot' },
    ]);
  }, 120_000);

  it('records a 15 fps mp4 a PR plays inline: its index sits before its media', () => {
    const file = join(evidenceDir(root), 'click.mp4');
    const mp4 = readFileSync(file);
    expect(mp4.indexOf('moov')).toBeGreaterThan(0);
    expect(mp4.indexOf('moov')).toBeLessThan(mp4.indexOf('mdat'));
    execFileSync('docker', ['cp', file, `${box.name}:/tmp/click.mp4`]);
    const probe = [
      'ffprobe',
      '-v',
      'error',
      '-show_entries',
      'stream=r_frame_rate',
      '-of',
      'csv=p=0',
    ];
    expect(boxOutput(box.name, [...probe, '/tmp/click.mp4']).trim()).toBe('15/1');
  });

  it('screenshots the whole 1280x800 screen, in the pixels xdotool clicks', () => {
    const file = join(root, 'screen.png');
    screenshot(box.name, file);
    const png = readFileSync(file);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 800]);
  });

  it('fails a flow whose box command fails, and keeps that capture local', async () => {
    const result = await run(flowFile('broken', "exec(['false']);"));
    expect(result.passed).toBe(false);
    expect(readManifest(evidenceDir(root)).find(({ flow }) => flow === 'broken')).toMatchObject({
      passed: false,
    });
  }, 120_000);

  it('streams its live view to the password the URL carries, and refuses any other', async () => {
    const browser = await chromium.launch();
    const status = async (url: string) => {
      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForTimeout(3000);
      return (await page.locator('#noVNC_status').textContent()) ?? '';
    };
    try {
      expect(await status(viewUrl(box))).toContain('Connected');
      expect(await status(viewUrl(box).replace('testpass', 'wrong'))).toContain(
        'password check failed',
      );
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("refuses a second run of a flow being recorded, leaving the first one's video and the flow's earlier capture whole", async () => {
    const flow = flowFile('dup', 'await page.goto(url);');
    expect((await run(flow)).passed).toBe(true);
    const earlier = readManifest(evidenceDir(root)).filter((e) => e.flow === 'dup');
    await startRecording(box.name, 'dup');
    const second = await run(flow);
    expect(second.passed).toBe(false);
    expect(second.error).toContain('another run is recording');
    expect(readManifest(evidenceDir(root)).filter((e) => e.flow === 'dup')).toEqual(earlier);
    const kept = join(root, 'dup-first.mp4');
    expect(await stopRecording(box.name, 'dup', kept)).toBe(true);
    expect(readFileSync(kept).indexOf('moov')).toBeGreaterThan(0);
  }, 60_000);

  it('lets only one of two runs that start recording at once record', async () => {
    const boxModule = join(import.meta.dirname, '..', 'lib', 'machine', 'box.mts');
    const start = (flow: string) =>
      execFileAsync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { startRecording } = await import(${JSON.stringify(boxModule)}); await startRecording(${JSON.stringify(box.name)}, '${flow}');`,
        ],
        { timeout: 30_000 },
      );
    const both = await Promise.allSettled([start('race-1'), start('race-2')]);
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = both.find((r) => r.status === 'rejected');
    expect(lost?.status === 'rejected' && String(lost.reason)).toContain(
      'another run is recording',
    );
    const won = both[0].status === 'fulfilled' ? 'race-1' : 'race-2';
    expect(await stopRecording(box.name, won, join(root, `${won}.mp4`))).toBe(true);
  }, 60_000);

  it('refuses a recording whose recorder died before it could finish the file', async () => {
    await startRecording(box.name, 'crashed');
    execFileSync('docker', ['exec', box.name, 'pkill', '-KILL', '-f', 'crashed.mp4']);
    const copy = join(root, 'crashed.mp4');
    expect(await stopRecording(box.name, 'crashed', copy)).toBe(false);
    expect(existsSync(copy)).toBe(false);
  }, 60_000);

  it('fails to start a recording when the desktop yields no frames, and frees the box', async () => {
    const stale = [
      'sh',
      '-c',
      'mkdir -p /tmp/devkit-recordings && echo old > /tmp/devkit-recordings/dark.mp4',
    ];
    boxOutput(box.name, stale);
    execFileSync('docker', ['exec', box.name, 'pkill', '-x', 'Xvfb']);
    await expect(startRecording(box.name, 'dark')).rejects.toThrow('never started');
    const left = spawnSync('docker', ['exec', box.name, 'pgrep', '-f', 'dark.mp4']);
    expect(left.status).toBe(1);
    await expect(startRecording(box.name, 'dark-again')).rejects.toThrow('never started');
  }, 90_000);

  it('is gone soon after removeBox', async () => {
    removeBox(box.name);
    const deadline = Date.now() + 20_000;
    while (boxRunning(box.name) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 300));
    expect(boxRunning(box.name)).toBe(false);
  }, 30_000);
});
