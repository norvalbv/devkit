/** `devkit machine run`: drive the slot's app with the agent's asserted flow while recording it. The
 * assertions are the proof; the video and screenshots are what a reviewer watches. */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { z } from 'zod';
import { errorMessage } from '../ship/review/shared/common.mts';
import {
  type CapturedFile,
  type EvidenceEntry,
  provenance,
  recordFlow,
  shotFile,
} from './manifest.mts';

export const VIEWPORT = { width: 1280, height: 720 };
const FLOW_TIMEOUT_MS = 5 * 60_000;

/** What a flow module's default export is called with. */
export interface FlowContext {
  page: Page;
  url: string;
  shot: (name: string) => Promise<void>;
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
async function openPage(profile: string): Promise<Opened> {
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

export interface RunInput {
  root: string;
  flowPath: string;
  name?: string;
  url: string;
  profile: string;
  evidence: string;
}

export interface RunResult {
  flow: string;
  passed: boolean;
  entries: EvidenceEntry[];
  error?: string;
}

/** Record `flowPath` on the slot's page; a throw or a timeout fails it (passed:false, kept locally). */
export async function runFlow(input: RunInput): Promise<RunResult> {
  const { root, flowPath, url, profile, evidence } = input;
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
  const { page, close } = await openPage(profile);
  const shot = async (name: string) => {
    if (!SHOT_NAME.test(name))
      throw new Error(`shot name "${name}" may hold only letters, digits, "_" and "-"`);
    const file = shotFile(flow, name);
    await page.screenshot({ path: join(evidence, file) });
    if (!files.some((entry) => entry.file === file)) files.push({ file, kind: 'screenshot' });
  };
  let error: string | undefined;
  try {
    await page.screencast.start({ path: join(evidence, `${flow}.webm`), size: VIEWPORT });
    files.push({ file: `${flow}.webm`, kind: 'video' });
    await page.screencast.showActions();
    const run = flowModuleSchema.parse(await import(href)).default;
    await withTimeout(run({ page, url, shot }), FLOW_TIMEOUT_MS);
    await shot('final');
  } catch (cause) {
    error = errorMessage(cause);
  } finally {
    await page.screencast.stop().catch(() => undefined);
    await close();
  }
  const passed = error === undefined;
  const entries = recordFlow(evidence, flow, files, { ...facts, passed });
  return { flow, passed, entries, error };
}
