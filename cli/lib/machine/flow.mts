/** `devkit machine run`: drive the slot's app with the agent's asserted flow while recording it. The
 * assertions are the proof; the video and screenshots are what a reviewer watches. */
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { z } from 'zod';
import { errorMessage } from '../ship/review/shared/common.mts';
import { type Box, boxOutput, screenshot, startRecording, stopRecording } from './box.mts';
import {
  type CapturedFile,
  type EvidenceEntry,
  provenance,
  recordFlow,
  shotFile,
} from './manifest.mts';

export const VIEWPORT = { width: 1280, height: 720 };
const FLOW_TIMEOUT_MS = 5 * 60_000;

/** What a flow module's default export is called with. `exec` runs a command in the full mode's
 * box and returns its stdout (xdotool input, reading app state); a failing command fails the flow. */
export interface FlowContext {
  page: Page;
  url: string;
  shot: (name: string) => Promise<void>;
  exec: (argv: string[]) => string;
}
type Flow = (context: FlowContext) => Promise<void>;

const flowModuleSchema = z.object({
  default: z.custom<Flow>((value) => value instanceof Function, 'a default-exported function'),
});

/** Installs the headless shell THIS devkit's pinned playwright-core drives, never npm's latest. */
export function browserRemedy(): string {
  const pkg = createRequire(import.meta.url).resolve('playwright-core/package.json');
  return `node "${join(dirname(pkg), 'cli.js')}" install chromium-headless-shell`;
}

/** A flow's name is its files' prefix and its manifest key, so it is taken as given, never slugged:
 * two names that slugged alike would overwrite each other's captures. */
const FLOW_NAME = /^[A-Za-z0-9._-]+$/;
/** A shot name holds no ".", so `shotFile` never gives two flows' shots one file. */
const SHOT_NAME = /^[A-Za-z0-9_-]+$/;

interface Opened {
  page: Page;
  close: () => Promise<void>;
}

/** A page in the slot's own headless Chromium profile. */
async function openHeadless(profile: string): Promise<Opened> {
  try {
    const options = { headless: true, viewport: VIEWPORT };
    const context = await chromium.launchPersistentContext(profile, options);
    return { page: context.pages()[0] ?? (await context.newPage()), close: () => context.close() };
  } catch (cause) {
    if (!errorMessage(cause).includes("Executable doesn't exist")) throw cause;
    throw new Error(`the headless browser is not installed; run: ${browserRemedy()}`);
  }
}

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the flow did not finish within ${ms / 1000}s`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/** The first page of whatever answers the box's DevTools port: its Chromium, or an app the agent
 * started with --remote-debugging-port=9222. Closing only disconnects. */
async function openInBox(box: Box): Promise<Opened> {
  const devtools = `http://127.0.0.1:${box.cdp}`;
  const browser = await chromium.connectOverCDP(devtools).catch((cause) => {
    const remedy = 'start Chromium or your app in the box with --remote-debugging-port=9222';
    throw new Error(
      `nothing in the box answers DevTools at ${devtools} (${errorMessage(cause)}); ${remedy}`,
    );
  });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  return { page: context.pages()[0] ?? (await context.newPage()), close: () => browser.close() };
}

/** How a run films itself: the page's own screencast when headless, the whole screen in a box. */
interface Recorder {
  video: string;
  start: () => Promise<void>;
  shot: (file: string) => Promise<void>;
  /** False when the recording was lost. */
  stop: () => Promise<boolean>;
}

function pageRecorder(page: Page, evidence: string, flow: string): Recorder {
  const video = `${flow}.webm`;
  return {
    video,
    start: async () => {
      await page.screencast.start({ path: join(evidence, video), size: VIEWPORT });
      // The action overlay is cosmetic: failing it must not leave the screencast running.
      await page.screencast.showActions().catch(() => undefined);
    },
    shot: async (file) => void (await page.screenshot({ path: join(evidence, file) })),
    stop: async () => {
      await page.screencast.stop().catch(() => undefined);
      return existsSync(join(evidence, video));
    },
  };
}

const execIn = (box: Box | null | undefined) => (argv: string[]) => {
  if (!box) throw new Error('exec needs full mode: `devkit machine up --full`');
  return boxOutput(box.name, argv);
};

function boxRecorder(box: Box, evidence: string, flow: string): Recorder {
  const video = `${flow}.mp4`;
  return {
    video,
    start: () => startRecording(box.name, flow),
    shot: async (file) => screenshot(box.name, join(evidence, file)),
    stop: () => stopRecording(box.name, flow, join(evidence, video)),
  };
}

export interface RunInput {
  root: string;
  flowPath: string;
  name?: string;
  url: string;
  profile: string;
  evidence: string;
  box?: Box | null;
}

export interface RunResult {
  flow: string;
  passed: boolean;
  entries: EvidenceEntry[];
  error?: string;
}

/** Record `flowPath` on the slot's page; a throw or a timeout fails it (passed:false, kept locally). */
export async function runFlow(input: RunInput): Promise<RunResult> {
  const { root, flowPath, url, profile, evidence, box } = input;
  const flow = input.name ?? basename(flowPath, extname(flowPath));
  if (!FLOW_NAME.test(flow))
    throw new Error(
      `flow name "${flow}" may hold only letters, digits, ".", "_" and "-"; pass --name`,
    );
  // A fresh URL per run, so a rewritten flow is re-imported rather than served from the module cache.
  const href = `${pathToFileURL(resolve(flowPath)).href}?run=${Date.now()}`;
  mkdirSync(evidence, { recursive: true });
  const facts = provenance(root);
  const files: CapturedFile[] = [];
  const { page, close } = await (box ? openInBox(box) : openHeadless(profile));
  const recorder = box ? boxRecorder(box, evidence, flow) : pageRecorder(page, evidence, flow);
  const shot = async (name: string) => {
    if (!SHOT_NAME.test(name))
      throw new Error(`shot name "${name}" may hold only letters, digits, "_" and "-"`);
    const file = shotFile(flow, name);
    await recorder.shot(file);
    if (!files.some((entry) => entry.file === file)) files.push({ file, kind: 'screenshot' });
  };
  let error: string | undefined;
  // Only a recording this run started is stopped: stopping another run's would cut its video.
  let recording = false;
  try {
    await recorder.start();
    recording = true;
    files.push({ file: recorder.video, kind: 'video' });
    const run = flowModuleSchema.parse(await import(href)).default;
    await withTimeout(run({ page, url, shot, exec: execIn(box) }), FLOW_TIMEOUT_MS);
    await shot('final');
  } catch (cause) {
    error = errorMessage(cause);
  } finally {
    if (recording && !(await recorder.stop()))
      error ??= 'the recording was lost, so nothing proves this run';
    await close();
  }
  const passed = error === undefined;
  // A run refused before it recorded anything leaves the flow's earlier capture alone.
  const entries = recording ? recordFlow(evidence, flow, files, { ...facts, passed }) : [];
  return { flow, passed, entries, error };
}
