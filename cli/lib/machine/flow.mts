/** `devkit machine run`: drive the slot's app with the agent's asserted flow while recording it. The
 * assertions are the proof; the video and screenshots are what a reviewer watches. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { chromium, type Locator, type Page } from 'playwright-core';
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
const CAPTURE_TIMEOUT_MS = 30_000;
/** Chromium refuses a capture until the page has drawn a frame, which a just-loaded page has not. */
const CAPTURE_REFUSED = /Unable to capture screenshot/;
const CAPTURE_TRIES = 10;
/** Pacing: a caption is read before its action, and each result is held long enough to be seen. */
const LEAD_IN_MS = 700;
const STEP_HOLD_MS = 1500;
const FINAL_HOLD_MS = 2000;
const ACTION_MS = 900;

export interface StepOptions {
  /** The element this step proves: scrolled into view and marked in the video and the still. */
  focus?: Locator;
  /** `outline` (the default) boxes `focus`; `dim` darkens the rest and leaves it untouched, for a
   * step whose subject is the element's own border, ring or shadow. */
  mark?: 'outline' | 'dim';
}

/** What a flow module's default export is called with. `exec` runs a command in the full mode's
 * box and returns its stdout (xdotool input, reading app state); a failing command fails the flow. */
export interface FlowContext {
  page: Page;
  url: string;
  shot: (name: string) => Promise<void>;
  exec: (argv: string[]) => string;
  /** One beat of the proof: its caption, the action, a hold on the result, and a still of it. */
  step: (title: string, act: () => Promise<void>, options?: StepOptions) => Promise<void>;
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
/** A step's own still is named `stepN-…`, so a flow's shot may not take such a name. */
const STEP_SHOT = /^step\d+-/;
const NO_STEP =
  'the flow called no step(): wrap each thing a reviewer must see in `await step("what happens", async () => { … })`';

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

function withTimeout<T>(work: Promise<T>, ms: number, what = 'the flow'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000}s`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

async function connect(devtools: string, remedy: string) {
  return chromium.connectOverCDP(devtools).catch((cause) => {
    throw new Error(`nothing answers DevTools at ${devtools} (${errorMessage(cause)}); ${remedy}`);
  });
}

/** The first page of whatever answers the box's DevTools port: its Chromium, or an app the agent
 * started with --remote-debugging-port=9222. Closing only disconnects. */
async function openInBox(box: Box): Promise<Opened> {
  const remedy = 'start Chromium or your app in the box with --remote-debugging-port=9222';
  const browser = await connect(`http://127.0.0.1:${box.cdp}`, remedy);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  return { page: context.pages()[0] ?? (await context.newPage()), close: () => browser.close() };
}

/** DevTools answers before an app shows its first window, so an attach waits this long for one. */
const APP_PAGE_MS = 30_000;
const NOT_THE_APP = /^(devtools:|chrome-extension:|chrome-error:|about:blank$)/;

/** The app's own page among DevTools targets: no inspector, extension, blank or failed-load page. */
export const appPage = <P extends { url: () => string }>(pages: P[]): P | undefined =>
  pages.find((page) => !NOT_THE_APP.test(page.url()));

/** The window of the app serving DevTools on the slot's port. Closing only disconnects. */
async function openApp(devtools: string): Promise<Opened> {
  const remedy =
    'start your app with --remote-debugging-port={port}, or drop "devtools" from the recipe';
  const browser = await connect(devtools, remedy);
  const pages = () => browser.contexts().flatMap((context) => context.pages());
  for (const deadline = Date.now() + APP_PAGE_MS; !appPage(pages()) && Date.now() < deadline;)
    await sleep(100);
  const page = appPage(pages());
  if (page) return { page, close: () => browser.close() };
  const seen = pages().map((other) => other.url());
  await browser.close();
  const waited = `the app at ${devtools} showed no window within ${APP_PAGE_MS / 1000}s`;
  throw new Error(`${waited} (${seen.length} other page(s): ${seen.join(', ')})`);
}

/** How a run films itself: the page's own screencast on this Mac, the whole screen in a box. */
interface Recorder {
  video: string;
  start: () => Promise<void>;
  shot: (file: string) => Promise<void>;
  /** False when the recording was lost. */
  stop: () => Promise<boolean>;
}

/** A window's own shape at the video width, so the picture is neither squashed nor padded; a
 * window with no layout yet has no shape to keep. */
export const videoSize = (width: number, height: number): typeof VIEWPORT =>
  width > 0 && height > 0
    ? {
        width: VIEWPORT.width,
        height: Math.max(2, Math.round((VIEWPORT.width * height) / width / 2) * 2),
      }
    : VIEWPORT;

/** A still straight from DevTools: `page.screenshot` redraws the page at another scale for a frame,
 * which a recording shows as a flicker. */
async function capture(page: Page, file: string): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    for (let tries = 1; ; tries++) {
      const shot = session.send('Page.captureScreenshot', { format: 'png' });
      const taken = await withTimeout(shot, CAPTURE_TIMEOUT_MS, 'the screenshot').catch(
        (cause: unknown) => {
          if (tries === CAPTURE_TRIES || !CAPTURE_REFUSED.test(errorMessage(cause))) throw cause;
        },
      );
      if (taken) return writeFileSync(file, Buffer.from(taken.data, 'base64'));
      await sleep(200);
    }
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** The page's size in CSS pixels: the viewport devkit set, else the attached app's own window. A
 * page just opened is asked nothing, since a script can lose a race with its first navigation. */
const windowSize = async (page: Page): Promise<typeof VIEWPORT> =>
  page.viewportSize() ??
  page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

function pageRecorder(page: Page, evidence: string, flow: string, pace: number): Recorder {
  const video = `${flow}.webm`;
  return {
    video,
    start: async () => {
      const { width, height } = await windowSize(page);
      await page.screencast.start({ path: join(evidence, video), size: videoSize(width, height) });
      // The action overlay is cosmetic: failing it must not leave the screencast running.
      await page.screencast.showActions({ duration: ACTION_MS * pace }).catch(() => undefined);
    },
    shot: (file) => capture(page, join(evidence, file)),
    stop: async () => {
      await page.screencast.stop().catch(() => undefined);
      return existsSync(join(evidence, video));
    },
  };
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

/** The caption bar's reach from its edge of the window, in CSS pixels. */
const CAPTION_ZONE = 90;
const captionHtml = (text: string, top: boolean): string =>
  `<div style="position:fixed;left:50%;${top ? 'top' : 'bottom'}:28px;transform:translateX(-50%);` +
  'max-width:80%;background:rgba(17,17,17,.9);color:#fff;font:600 18px/1.35 system-ui,sans-serif;' +
  `padding:10px 18px;border-radius:10px;pointer-events:none">${escapeHtml(text)}</div>`;

type Overlay = Awaited<ReturnType<Page['screencast']['showOverlay']>>;

/** A run's caption and focus mark. They are drawn in the page, over the app and outside its own
 * DOM tree, so `clear` must run before an attached app is left, or they outlive the run. */
function narration(page: Page) {
  let caption: Overlay | undefined;
  let mark: Overlay | undefined;
  let cleared = false;
  // A flow that outlives its timeout keeps running: what it draws after `clear` comes straight down.
  const show = async (html: string): Promise<Overlay | undefined> => {
    if (cleared) return undefined;
    const overlay = await page.screencast.showOverlay(html);
    if (!cleared) return overlay;
    await overlay.dispose().catch(() => undefined);
    return undefined;
  };
  const unmark = async () => {
    await mark?.dispose().catch(() => undefined);
    mark = undefined;
  };
  return {
    /** The next caption goes up before the last comes down, so no frame is left without one. */
    caption: async (text: string, top = false) => {
      const previous = caption;
      caption = await show(captionHtml(text, top));
      await previous?.dispose();
    },
    /** Marks `focus`; true when it reaches into the bottom caption's zone. */
    mark: async (focus: Locator, kind: StepOptions['mark'] = 'outline'): Promise<boolean> => {
      await focus.scrollIntoViewIfNeeded();
      const box = await focus.boundingBox();
      if (!box) return false;
      const dim = kind === 'dim';
      const pad = dim ? 0 : 6;
      const radius = dim ? await focus.evaluate((el) => getComputedStyle(el).borderRadius) : '8px';
      const look = dim
        ? 'box-shadow:0 0 0 9999px rgba(15,15,20,.5)'
        : 'border:3px solid #ff3b6b;box-shadow:0 0 0 4px rgba(255,59,107,.25)';
      const place = `left:${box.x - pad}px;top:${box.y - pad}px;width:${box.width + 2 * pad}px;height:${box.height + 2 * pad}px`;
      mark = await show(
        `<div style="position:fixed;${place};box-sizing:border-box;border-radius:${radius};${look};pointer-events:none"></div>`,
      );
      const { height } = await windowSize(page);
      return box.y + box.height > height - CAPTION_ZONE;
    },
    unmark,
    clear: async () => {
      cleared = true;
      await unmark();
      await caption?.dispose().catch(() => undefined);
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
  /** The recipe's `devtools`: `url` is the app's DevTools endpoint, and the page is the app's own. */
  devtools?: boolean;
  /** Scales every hold of the run's pacing; tests shorten them. */
  pace?: number;
}

/** The page a run drives, and the address its flow is given. */
async function openPage({ box, devtools, url, profile }: RunInput) {
  if (box) return { ...(await openInBox(box)), url };
  if (!devtools) return { ...(await openHeadless(profile)), url };
  const app = await openApp(url);
  // An attached flow's url is its app's own address, so `goto(url)` reloads the app.
  return { ...app, url: app.page.url() };
}

export interface RunResult {
  flow: string;
  passed: boolean;
  entries: EvidenceEntry[];
  error?: string;
}

/** Record `flowPath` on the slot's page; a throw or a timeout fails it (passed:false, kept locally). */
export async function runFlow(input: RunInput): Promise<RunResult> {
  const { root, flowPath, evidence, box, pace = 1 } = input;
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
  const { page, close, url } = await openPage(input);
  const recorder = box
    ? boxRecorder(box, evidence, flow)
    : pageRecorder(page, evidence, flow, pace);
  const still = async (name: string) => {
    const file = shotFile(flow, name);
    await recorder.shot(file);
    if (!files.some((entry) => entry.file === file)) files.push({ file, kind: 'screenshot' });
  };
  const shot = async (name: string) => {
    if (!SHOT_NAME.test(name))
      throw new Error(`shot name "${name}" may hold only letters, digits, "_" and "-"`);
    if (STEP_SHOT.test(name))
      throw new Error(`shot name "${name}" is a step's own still; start it with another word`);
    await still(name);
  };
  const notes = narration(page);
  let steps = 0;
  const step: FlowContext['step'] = async (title, act, options) => {
    // Fixed here: steps a flow starts together must not share the counter's later value.
    const number = (steps += 1);
    const label = `${number} · ${title}`;
    await notes.caption(label);
    await sleep(LEAD_IN_MS * pace);
    await act();
    // A caption that would sit on the marked element moves to the top instead.
    if (options?.focus && (await notes.mark(options.focus, options.mark)))
      await notes.caption(label, true);
    await sleep(STEP_HOLD_MS * pace);
    await still(
      `step${number}-${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 40)}`,
    );
    await notes.unmark();
  };
  const proof = async (run: Flow) => {
    await run({ page, url, shot, exec: execIn(box), step });
    if (steps === 0) throw new Error(NO_STEP);
    await notes.caption(`✓ ${steps} step${steps === 1 ? '' : 's'} · flow passed`);
    await sleep(FINAL_HOLD_MS * pace);
  };
  let error: string | undefined;
  // Only a recording this run started is stopped: stopping another run's would cut its video.
  let recording = false;
  try {
    await recorder.start();
    recording = true;
    files.push({ file: recorder.video, kind: 'video' });
    const run = flowModuleSchema.parse(await import(href)).default;
    await withTimeout(proof(run), FLOW_TIMEOUT_MS);
  } catch (cause) {
    error = errorMessage(cause);
  } finally {
    await notes.clear();
    if (recording && !(await recorder.stop()))
      error ??= 'the recording was lost, so nothing proves this run';
    await close();
  }
  const passed = error === undefined;
  // A run refused before it recorded anything leaves the flow's earlier capture alone.
  const entries = recording ? recordFlow(evidence, flow, files, { ...facts, passed }) : [];
  return { flow, passed, entries, error };
}
