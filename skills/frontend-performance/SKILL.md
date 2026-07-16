---
name: Frontend Performance
description: Performance optimization for frontend/client-side code. Use when optimizing page load times, bundle sizes, images, fonts, or Core Web Vitals. Covers HTML/CSS/JS optimization, image handling, lazy loading, critical CSS, code splitting, rendering cost, and performance measurement.
---

# Frontend Performance

## Review Script

```bash
SCRIPT=".claude/skills/frontend-performance/scripts/checklist.mjs"

node $SCRIPT generate     # Enumerate review items from staged frontend files
node $SCRIPT status       # Show progress
node $SCRIPT check-item <name> --pass   # Mark item passed
node $SCRIPT check-item <name> --fail "reason"  # Mark item failed
node $SCRIPT finalize     # Verify every item was resolved; refuses if any are pending or failed
if [ "${DEVKIT_RUN_MODE:-}" != "review" ]; then node $SCRIPT cleanup; fi
```

The frontend roots the script scans come from `guard.config.json` `review.frontendRoots` — not
hardcoded. When that key is absent it scans all staged files; a present-but-invalid value warns
and falls back to scanning all. `devkit review` injects the gate's effective roots through
`DEVKIT_REVIEW_FRONTEND_ROOTS`; that validated JSON array takes precedence.

Each section below is one checklist item (or a small group). Rules name the evidence to grep for
and the condition that makes the item a FAIL — pass anything that doesn't meet a FAIL bar. Weigh
findings by where they run: a hot list row or scroll handler is held to a stricter bar than a
settings page.

## Images (`image-optimization`)

```html
<img src="photo.jpg" loading="lazy" width="800" height="600" alt="...">

<img srcset="small.jpg 300w, medium.jpg 600w, large.jpg 1200w"
     sizes="(max-width: 600px) 300px, 600px"
     src="medium.jpg" alt="...">
```

- FAIL new below-the-fold images without lazy loading.
- FAIL images without dimensions (width/height or CSS aspect-ratio) — undimensioned images shift
  layout as they load.
- FAIL obviously oversized or legacy-format assets added to the bundle (multi-hundred-KB PNG
  where WebP/AVIF or an SVG serves); FAIL base64-inlined images beyond icon size.

## CSS (`css-optimization`, `inline-styles`)

- `css-optimization`: FAIL render-blocking additions to the critical path (new synchronous
  stylesheet links for below-the-fold features); FAIL selector explosions (deeply nested or
  universal selectors on hot DOM).
- `inline-styles`: FAIL a new object literal passed to `style={}` on every render of a hot
  component — it defeats memoization and allocates per render. Hoist or memoize; static styles
  belong in classes.

## JavaScript Loading (`bundle-size`, `script-loading`, `code-splitting`, `dependency-size`)

- `bundle-size`: FAIL whole-library imports where a subpath import exists (`import _ from
  'lodash'` vs `lodash/pick`); FAIL importing a heavy module into a light entry.
- `script-loading`: FAIL new synchronous `<script>` tags in the document head without
  `async`/`defer` — they block first paint.
- `code-splitting`: FAIL a large, route-scoped, or rarely-used feature imported statically into
  a shared entry when the repo already lazy-loads siblings (`React.lazy`, `dynamic()`).
- `dependency-size`: FAIL a new dependency added for something the stdlib/platform or an
  existing dependency already does; weigh its size against its job.

## Rendering (`react-rendering`, `hooks-optimization`, `list-rendering`)

- `react-rendering`: FAIL new-per-render object/array/function props flowing into memoized or
  hot children (breaks reference equality); FAIL state lifted so high that keystrokes re-render
  whole trees.
- `hooks-optimization`: FAIL heavy computation (sorting/ranking/filtering a large list, text
  scoring, O(n·m) work) called bare in a render body. Every render re-runs it — including
  renders from unrelated state (a toggle elsewhere in the same component) — so "the inputs
  change anyway" is not a pass: wrap it in `useMemo` keyed on its actual inputs, and consider
  `useDeferredValue`/debounce when an input is keystroke-driven. Memoizing a cheap downstream
  value (a count label) while the expensive call above it stays bare is still a FAIL. Also FAIL
  effect dependency arrays that re-fire every render for stable work, and `useMemo`/`useCallback`
  spam on trivial values only when the diff adds many.
- `list-rendering`: FAIL `key={index}` on reorderable/mutable lists; FAIL rendering unbounded
  lists (hundreds+) with no virtualization when the repo has a virtual list primitive.

## Layout Thrash (`layout-thrash`)

- FAIL synchronous layout reads (`getBoundingClientRect`, `offsetWidth/Height`,
  `getComputedStyle`, `scrollWidth`, …) interleaved with DOM writes, in loops, or inside
  scroll/resize/animation-frame handlers without batching — each read after a write forces a
  full reflow.
- PASS one-off measurements in event handlers or effects that run once per interaction; the FAIL
  bar is repeated forced reflow on a hot path (per frame, per list item, per keystroke).

## Animation (`animation-performance`)

- FAIL animating layout-affecting properties (`top`, `left`, `width`, `height`, `margin`) on
  elements that animate frequently or during interaction — every frame relayouts. Use
  `transform`/`opacity`, which composite off the main thread.
- PASS one-shot transitions on small, isolated elements where a layout animation is the honest
  simplest tool; the bar is hot/continuous animation.

## Data Fetching (`data-fetching`)

- FAIL fetch calls issued during render (component body) instead of effects/loaders/query hooks.
- FAIL new fetch paths with no caching/dedup when the repo already has a query layer
  (React Query, SWR, tRPC) the diff bypasses.
- FAIL request waterfalls (await A then B when independent) on route-critical data.

## Service Worker (`service-worker`)

- FAIL cache-first strategies applied to API/auth responses (stale-auth bugs); FAIL unbounded
  runtime caches with no version/cleanup — old entries live forever.

## Cookies (`cookie-optimization`)

- FAIL large payloads written into cookies (they ride every request); state that only the client
  needs belongs in storage APIs, not cookies.

## Resource Hints (`resource-hints`)

- FAIL `preload` of resources the page doesn't use promptly (wasted bandwidth, warning noise).
- Cross-origin font/API hosts used at startup should carry `preconnect`; flag only when the diff
  adds such a host without one.

## Fonts (`font-optimization`)

```html
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
```

- FAIL new font faces without `font-display` (invisible-text risk) or in legacy-only formats
  (WOFF2 is the baseline); flag font additions that plainly duplicate an existing family.

## iframes (`iframe-usage`)

- FAIL new iframes without `loading="lazy"` where offscreen; each iframe is a document-weight
  dependency — challenge additions that a component could serve.

## Provenance

Rule text above is written for this repo. Topic coverage was diffed against:

- **roadmap.sh Frontend Performance best practices** (coverage checklist only; content license
  is personal-use): High/Medium/Low priority sections → items `image-optimization`,
  `css-optimization`, `inline-styles`, `bundle-size`, `script-loading`, `iframe-usage`,
  `service-worker`, `cookie-optimization`, `resource-hints`, `font-optimization`,
  `dependency-size`, `code-splitting`.
- Own additions for runtime rendering cost, which the load-time-focused source list predates
  (no external source text): `react-rendering`, `hooks-optimization`, `list-rendering`,
  `data-fetching`, `layout-thrash`, `animation-performance`.

Rejected topics (build/infra outputs, not judgeable from a staged source diff): minification,
HTML minification, gzip/brotli config, page-weight/TTFB/load-time budgets, CDN setup, HTTP cache
headers, same-protocol serving, 404-avoidance, CSS concatenation, unused-CSS removal audits.
