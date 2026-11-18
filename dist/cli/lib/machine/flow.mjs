var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
/** `devkit machine run`: drive the slot's app with the agent's asserted flow while recording it. The
 * assertions are the proof; the video and screenshots are what a reviewer watches. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { z } from 'zod';
import { errorMessage } from '../ship/review/shared/common.mjs';
import { boxOutput, screenshot, startRecording, stopRecording } from './box.mjs';
import { provenance, recordFlow, shotFile, } from './manifest.mjs';
export const VIEWPORT = { width: 1280, height: 720 };
const FLOW_TIMEOUT_MS = 5 * 60_000;
const CAPTURE_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const STILL_DRAWN = 'the page stopped answering, so the captions and marks of this run may still be drawn over the app: reload or restart it';
/** Chromium refuses a capture until the page has drawn a frame, which a just-loaded page has not. */
const CAPTURE_REFUSED = /Unable to capture screenshot/;
const CAPTURE_TRIES = 10;
/** Pacing: a caption is read before its action, and each result is held long enough to be seen. */
const LEAD_IN_MS = 700;
const STEP_HOLD_MS = 1500;
const FINAL_HOLD_MS = 2000;
const ACTION_MS = 900;
const flowModuleSchema = z.object({
    default: z.custom((value) => value instanceof Function, 'a default-exported function'),
});
/** Installs the headless shell THIS devkit's pinned playwright-core drives, never npm's latest. */
export function browserRemedy() {
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
const NO_STEP = 'the flow called no step(): wrap each thing a reviewer must see in `await step("what happens", async () => { … })`';
/** A page in the slot's own headless Chromium profile. */
async function openHeadless(profile) {
    try {
        const options = { headless: true, viewport: VIEWPORT };
        const context = await chromium.launchPersistentContext(profile, options);
        return { page: context.pages()[0] ?? (await context.newPage()), close: () => context.close() };
    }
    catch (cause) {
        if (!errorMessage(cause).includes("Executable doesn't exist"))
            throw cause;
        throw new Error(`the headless browser is not installed; run: ${browserRemedy()}`);
    }
}
function withTimeout(work, ms, what = 'the flow') {
    let timer;
    const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000}s`)), ms);
    });
    return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
async function connect(devtools, remedy) {
    return chromium.connectOverCDP(devtools).catch((cause) => {
        throw new Error(`nothing answers DevTools at ${devtools} (${errorMessage(cause)}); ${remedy}`);
    });
}
/** The first page of whatever answers the box's DevTools port: its Chromium, or an app the agent
 * started with --remote-debugging-port=9222. Closing only disconnects. */
async function openInBox(box) {
    const remedy = 'start Chromium or your app in the box with --remote-debugging-port=9222';
    const browser = await connect(`http://127.0.0.1:${box.cdp}`, remedy);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    return { page: context.pages()[0] ?? (await context.newPage()), close: () => browser.close() };
}
/** DevTools answers before an app shows its first window, so an attach waits this long for one. */
const APP_PAGE_MS = 30_000;
const NOT_THE_APP = /^(devtools:|chrome-extension:|chrome-error:|about:blank$)/;
/** The app's own page among DevTools targets: no inspector, extension, blank or failed-load page. */
export const appPage = (pages) => pages.find((page) => !NOT_THE_APP.test(page.url()));
/** The window of the app serving DevTools on the slot's port. Closing only disconnects. */
async function openApp(devtools) {
    const remedy = 'start your app with --remote-debugging-port={port}, or drop "devtools" from the recipe';
    const browser = await connect(devtools, remedy);
    const pages = () => browser.contexts().flatMap((context) => context.pages());
    for (const deadline = Date.now() + APP_PAGE_MS; !appPage(pages()) && Date.now() < deadline;)
        await sleep(100);
    const page = appPage(pages());
    if (page)
        return { page, close: () => browser.close() };
    const seen = pages().map((other) => other.url());
    await browser.close();
    const waited = `the app at ${devtools} showed no window within ${APP_PAGE_MS / 1000}s`;
    throw new Error(`${waited} (${seen.length} other page(s): ${seen.join(', ')})`);
}
/** A window's own shape at the video width, so the picture is neither squashed nor padded; a
 * window with no layout yet has no shape to keep. */
export const videoSize = (width, height) => width > 0 && height > 0
    ? {
        width: VIEWPORT.width,
        height: Math.max(2, Math.round((VIEWPORT.width * height) / width / 2) * 2),
    }
    : VIEWPORT;
/** A still straight from DevTools: `page.screenshot` redraws the page at another scale for a frame,
 * which a recording shows as a flicker. */
async function capture(page, file) {
    const session = await page.context().newCDPSession(page);
    try {
        const png = await withTimeout(takePng(session), CAPTURE_TIMEOUT_MS, 'the screenshot');
        writeFileSync(file, Buffer.from(png, 'base64'));
    }
    finally {
        await session.detach().catch(() => undefined);
    }
}
/** One capture, asked again while Chromium refuses it; the caller bounds the whole of it. */
async function takePng(session) {
    for (let tries = 1;; tries++) {
        try {
            return (await session.send('Page.captureScreenshot', { format: 'png' })).data;
        }
        catch (cause) {
            if (tries === CAPTURE_TRIES || !CAPTURE_REFUSED.test(errorMessage(cause)))
                throw cause;
        }
        await sleep(200);
    }
}
/** The page's size in CSS pixels: the viewport devkit set, else the attached app's own window. A
 * page just opened is asked nothing, since a script can lose a race with its first navigation. */
const windowSize = async (page) => page.viewportSize() ??
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
function pageRecorder(page, evidence, flow, pace) {
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
const escapeHtml = (text) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
/** The caption bar's reach from its edge of the window, in CSS pixels. */
const CAPTION_ZONE = 90;
const captionHtml = (text, top) => `<div style="position:fixed;left:50%;${top ? 'top' : 'bottom'}:28px;transform:translateX(-50%);` +
    'max-width:80%;background:rgba(17,17,17,.9);color:#fff;font:600 18px/1.35 system-ui,sans-serif;' +
    `padding:10px 18px;border-radius:10px;pointer-events:none">${escapeHtml(text)}</div>`;
/** A run's caption and focus mark. They are drawn in the page, over the app and outside its own
 * DOM tree, so `clear` must run before an attached app is left, or they outlive the run. */
function narration(page) {
    const drawn = new Set();
    let caption;
    let cleared = false;
    // A flow that outlives its timeout keeps running: what it draws after `clear` comes straight down.
    const show = async (html) => {
        if (cleared)
            return undefined;
        const overlay = await page.screencast.showOverlay(html);
        drawn.add(overlay);
        if (cleared)
            await remove(overlay);
        return cleared ? undefined : overlay;
    };
    const remove = async (overlay) => {
        if (!overlay || !drawn.delete(overlay))
            return;
        await overlay.dispose().catch(() => undefined);
    };
    return {
        /** The next caption goes up before the last comes down, so no frame is left without one. */
        caption: async (text, top = false) => {
            const next = await show(captionHtml(text, top));
            // Read only now: captions started together then each take down the one before them.
            const previous = caption;
            caption = next;
            await remove(previous);
        },
        /** Marks `focus`: the mark to `remove`, and whether it reaches into the bottom caption's zone. */
        mark: async (focus, kind = 'outline') => {
            await focus.scrollIntoViewIfNeeded();
            const box = await focus.boundingBox();
            if (!box)
                return { overlay: undefined, low: false };
            const dim = kind === 'dim';
            const pad = dim ? 0 : 6;
            const radius = dim ? await focus.evaluate((el) => getComputedStyle(el).borderRadius) : '8px';
            const look = dim
                ? 'box-shadow:0 0 0 9999px rgba(15,15,20,.5)'
                : 'border:3px solid #ff3b6b;box-shadow:0 0 0 4px rgba(255,59,107,.25)';
            const place = `left:${box.x - pad}px;top:${box.y - pad}px;width:${box.width + 2 * pad}px;height:${box.height + 2 * pad}px`;
            const overlay = await show(`<div style="position:fixed;${place};box-sizing:border-box;border-radius:${radius};${look};pointer-events:none"></div>`);
            const { height } = await windowSize(page);
            return { overlay, low: box.y + box.height > height - CAPTION_ZONE };
        },
        remove,
        /** Takes down everything still drawn, whichever step drew it. */
        clear: async () => {
            cleared = true;
            await Promise.all([...drawn].map(remove));
        },
    };
}
const execIn = (box) => (argv) => {
    if (!box)
        throw new Error('exec needs full mode: `devkit machine up --full`');
    return boxOutput(box.name, argv);
};
function boxRecorder(box, evidence, flow) {
    const video = `${flow}.mp4`;
    return {
        video,
        start: () => startRecording(box.name, flow),
        shot: async (file) => screenshot(box.name, join(evidence, file)),
        stop: () => stopRecording(box.name, flow, join(evidence, video)),
    };
}
/** The page a run drives, and the address its flow is given. */
async function openPage({ box, devtools, url, profile }) {
    if (box)
        return { ...(await openInBox(box)), url };
    if (!devtools)
        return { ...(await openHeadless(profile)), url };
    const app = await openApp(url);
    // An attached flow's url is its app's own address, so `goto(url)` reloads the app.
    return { ...app, url: app.page.url() };
}
/** Record `flowPath` on the slot's page; a throw or a timeout fails it (passed:false, kept locally). */
export async function runFlow(input) {
    const { root, flowPath, evidence, box, pace = 1 } = input;
    const flow = input.name ?? basename(flowPath, extname(flowPath));
    if (!FLOW_NAME.test(flow))
        throw new Error(`flow name "${flow}" may hold only letters, digits, ".", "_" and "-"; pass --name`);
    // A fresh URL per run, so a rewritten flow is re-imported rather than served from the module cache.
    const href = `${pathToFileURL(resolve(flowPath)).href}?run=${Date.now()}`;
    mkdirSync(evidence, { recursive: true });
    const facts = provenance(root);
    const files = [];
    const { page, close, url } = await openPage(input);
    const recorder = box
        ? boxRecorder(box, evidence, flow)
        : pageRecorder(page, evidence, flow, pace);
    const still = async (name) => {
        const file = shotFile(flow, name);
        await recorder.shot(file);
        if (!files.some((entry) => entry.file === file))
            files.push({ file, kind: 'screenshot' });
    };
    const shot = async (name) => {
        if (!SHOT_NAME.test(name))
            throw new Error(`shot name "${name}" may hold only letters, digits, "_" and "-"`);
        if (STEP_SHOT.test(name))
            throw new Error(`shot name "${name}" is a step's own still; start it with another word`);
        await still(name);
    };
    const notes = narration(page);
    let steps = 0;
    const step = async (title, act, options) => {
        // Fixed here: steps a flow starts together must not share the counter's later value.
        const number = (steps += 1);
        const label = `${number} · ${title}`;
        await notes.caption(label);
        await sleep(LEAD_IN_MS * pace);
        await act();
        // A caption that would sit on the marked element moves to the top instead.
        const marked = options?.focus ? await notes.mark(options.focus, options.mark) : undefined;
        if (marked?.low)
            await notes.caption(label, true);
        await sleep(STEP_HOLD_MS * pace);
        await still(`step${number}-${title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .slice(0, 40)}`);
        await notes.remove(marked?.overlay);
    };
    const proof = async (run) => {
        await run({ page, url, shot, exec: execIn(box), step });
        if (steps === 0)
            throw new Error(NO_STEP);
        await notes.caption(`✓ ${steps} step${steps === 1 ? '' : 's'} · flow passed`);
        await sleep(FINAL_HOLD_MS * pace);
    };
    let error;
    let warning;
    // Only a recording this run started is stopped: stopping another run's would cut its video.
    let recording = false;
    try {
        await recorder.start();
        recording = true;
        files.push({ file: recorder.video, kind: 'video' });
        const run = flowModuleSchema.parse(await import(__rewriteRelativeImportExtension(href))).default;
        await withTimeout(proof(run), FLOW_TIMEOUT_MS);
    }
    catch (cause) {
        error = errorMessage(cause);
    }
    finally {
        // A page that stopped answering must not keep the recorder and the browser from being released.
        await withTimeout(notes.clear(), CLEANUP_TIMEOUT_MS, 'overlay cleanup').catch(() => {
            warning = STILL_DRAWN;
        });
        if (recording && !(await recorder.stop()))
            error ??= 'the recording was lost, so nothing proves this run';
        await close();
    }
    const passed = error === undefined;
    // A run refused before it recorded anything leaves the flow's earlier capture alone.
    const entries = recording ? recordFlow(evidence, flow, files, { ...facts, passed }) : [];
    return { flow, passed, entries, error, warning };
}
