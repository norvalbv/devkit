#!/usr/bin/env node

/**
 * Frontend Accessibility Review Checklist (WCAG AA)
 *
 * Checks frontend code against WCAG AA accessibility best practices.
 * Only runs on frontend files (src/renderer/, src/preload/).
 *
 * Commands:
 *   generate                    Create checklist from staged frontend files
 *   status                      Show progress
 *   check-item <name> --pass    Mark item passed
 *   check-item <name> --fail    Mark item failed
 *   finalize                    Verify every item was resolved; refuses if any are pending or failed
 *   cleanup                     Remove checklist
 *   contrast <fg> <bg>          Check WCAG color contrast ratio
 */

import { execFileSync } from 'node:child_process';
import { createChecklistStore } from '../../_devkit/checklist-store.mjs';
import {
  assertStagedSetSane,
  resolveReviewRoots,
  toGitPathspecs,
} from '../../_devkit/review-roots.mjs';

const CHECKLIST_PATH = '.claude/.frontend-accessibility-review.json';

// ============ ACCESSIBILITY REGEX PATTERNS ============

// Images & alt text
const RE_IMG = /<img\b|<Image\b/i;

// Headings
const RE_HEADING = /<h[1-6]\b|<Heading\b/i;

// Buttons & click handlers
const RE_BUTTON = /<button\b|<Button\b|\bonClick\b/i;

// Links
const RE_LINK = /<a\s|<Link\b|\bhref\b/i;

// Form inputs
const RE_INPUT = /<input\b|<select\b|<textarea\b|<Input\b|<Select\b|<Textarea\b/i;

// ARIA attributes
const RE_ARIA = /\baria-|\brole\s*=/i;

// Tab index
const RE_TABINDEX = /\btabIndex\b|\btabindex\b/i;

// Focus handling
const RE_FOCUS = /\bonFocus\b|\bonBlur\b|:focus|focus-visible|focus:ring|\.focus\(\)/i;

// Color & styling (potential contrast issues)
const RE_COLOR = /\bcolor\s*:|bg-|text-(?!xs|sm|base|lg|xl|2xl|3xl)|fill\s*=|stroke\s*=/i;

// Motion & animation
const RE_MOTION = /\banimation\b|\btransition\b|@keyframes|\bmotion\b|prefers-reduced-motion/i;

// Media elements
const RE_MEDIA = /<video\b|<audio\b|<iframe\b|<Video\b|<Audio\b/i;

// Autofocus
const RE_AUTOFOCUS = /\bautoFocus\b|\bautofocus\b/i;

// Language attribute
const RE_LANG = /\blang\s*=|\bhrefLang\b/i;

// Lists
const RE_LIST = /<ul\b|<ol\b|<dl\b|<li\b/i;

// Tables
const RE_TABLE = /<table\b|<Table\b|<th\b|<td\b|<caption\b/i;

// Dialogs & modals
const RE_DIALOG = /<dialog\b|<Dialog\b|\bModal\b|\bmodal\b/i;

// Tooltips & title attributes
const RE_TOOLTIP = /\btitle\s*=|\bTooltip\b|\btooltip\b/i;

// Keyboard event handlers
const RE_KEYBOARD = /\bonKeyDown\b|\bonKeyUp\b|\bonKeyPress\b/i;

// Scrolling & overflow
const RE_SCROLL = /\boverflow\b|scroll(?!bar)/i;

// Dynamic content (state changes, live updates)
const RE_DYNAMIC = /\buseState\b|\buseEffect\b|\binnerHTML\b|\baria-live\b|\brole\s*=\s*["']alert/i;

// Viewport meta
const RE_VIEWPORT = /\bviewport\b|\buser-scalable\b/i;

// External links
const RE_BLANK = /target\s*=\s*["']_blank/i;

// Outline removal (anti-pattern)
const RE_OUTLINE_NONE = /outline-none|outline:\s*none|outline:\s*0\b/i;

// Div/span as interactive element (anti-pattern — should use native button/input/a)
const RE_DIV_INTERACTIVE =
  /<(?:div|span)\b[^>]*\b(?:onClick|onChange|onInput|onSubmit|onKeyDown|onKeyUp|onKeyPress|contentEditable|tabIndex|role\s*=\s*["'](?:button|textbox|checkbox|radio|switch|slider|combobox|listbox|option|tab|menuitem|link))\b/i;

// Hex color prefix strip
const RE_HEX_PREFIX = /^#/;

// Landmark elements (main, nav, header, footer, aside)
const RE_LANDMARK =
  /<main\b|<nav\b|<header\b|<footer\b|<aside\b|role\s*=\s*["'](?:main|navigation|banner|contentinfo|complementary|region)/i;

// Page/view title
const RE_PAGE_TITLE = /<title\b|document\.title|\buseTitle\b|<Helmet\b/i;

// Skip link patterns
const RE_SKIP_LINK = /skip.*link|skip.*nav|#main-content|#content|SkipLink/i;

// Hidden but potentially focusable elements
const RE_HIDDEN_INTERACTIVE =
  /hidden\b.*(?:tabIndex|href|button)|(?:display\s*:\s*none|visibility\s*:\s*hidden).*(?:tabIndex|href|button)/i;

// Form error handling
const RE_FORM_ERROR =
  /aria-describedby|aria-errormessage|aria-invalid|FormError|FieldError|error.*message/i;

// Error/warning/success status patterns
const RE_STATUS_STATE = /\berror\b|\bwarning\b|\bsuccess\b|\binvalid\b|\balert\b/i;

// Custom ::selection styles
const RE_SELECTION = /::selection/i;

// Orientation CSS
const RE_ORIENTATION = /orientation\s*:/i;

// SVG / icon elements
const RE_ICON = /<svg\b|<Icon\b|Icon\s*\/>/i;

// Link text-decoration removal (anti-pattern without alternative indicator)
const RE_LINK_NO_UNDERLINE = /no-underline|text-decoration\s*:\s*none/i;

const log = console.log;

const store = createChecklistStore({
  path: CHECKLIST_PATH,
  label: 'Frontend Accessibility',
  log,
});
const { save: saveChecklist, status, checkItem, finalize, cleanup } = store;

// ============ COLOR CONTRAST UTILITY ============

/**
 * Parse a hex color string to RGB values.
 * Supports #RGB, #RRGGBB, #RRGGBBAA formats.
 */
function hexToRgb(hex) {
  const clean = hex.replace(RE_HEX_PREFIX, '');
  let r, g, b;
  if (clean.length === 3) {
    r = parseInt(clean[0] + clean[0], 16);
    g = parseInt(clean[1] + clean[1], 16);
    b = parseInt(clean[2] + clean[2], 16);
  } else {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  }
  return { r, g, b };
}

/**
 * Calculate relative luminance per WCAG 2.1 definition.
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
function relativeLuminance({ r, g, b }) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Calculate WCAG contrast ratio between two colors.
 * Returns object with ratio and pass/fail for AA thresholds.
 */
function checkContrastRatio(hex1, hex2) {
  const l1 = relativeLuminance(hexToRgb(hex1));
  const l2 = relativeLuminance(hexToRgb(hex2));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  const ratio = (lighter + 0.05) / (darker + 0.05);
  return {
    ratio: Math.round(ratio * 100) / 100,
    passAANormal: ratio >= 4.5,
    passAALarge: ratio >= 3,
    passAANonText: ratio >= 3,
  };
}

// ============ GIT HELPERS ============

// Frontend roots to review — from guard.config.json `review.frontendRoots` (NOT hardcoded), so the
// checklist scopes to ANY repo's layout. No/unreadable config, a non-object config, or an absent
// review.frontendRoots → all staged files (the gate never silently no-ops). A PRESENT but invalid
// value (not an array of non-empty strings) warns loudly and falls back to scan-all, rather than
// letting a bad entry crash the git call into an empty result that would wave the commit through.
function frontendRoots() {
  return resolveReviewRoots({
    envName: 'DEVKIT_REVIEW_FRONTEND_ROOTS',
    configKey: 'frontendRoots',
    reviewerName: 'frontend-accessibility',
  });
}

function getStagedFiles() {
  const pathspecs = toGitPathspecs(frontendRoots());
  try {
    const output = execFileSync(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACM', '--', ...pathspecs],
      { encoding: 'utf-8' },
    );
    // ACM hides deletions, so an all-deletions index reads as "nothing staged" here. Never report
    // that as zero items — a reviewer that examined nothing must not read as a pass.
    if (!output.trim()) assertStagedSetSane(pathspecs, 'frontend-accessibility');
    return output
      .trim()
      .split('\n')
      .filter((f) => f.length > 0 && !f.endsWith('.pen'));
  } catch {
    return [];
  }
}

function getFileDiff(file) {
  try {
    return execFileSync('git', ['diff', '--cached', '--', file], { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

// ============ PATTERN DETECTION ============

function detectAccessibilityPatterns(_files, diffs) {
  const items = [];
  const fullDiff = diffs.join('\n');

  // Images — check alt text
  if (RE_IMG.test(fullDiff)) {
    items.push({
      name: 'alt-text',
      category: 'Images',
      description: 'All images have appropriate alt text; decorative images use alt=""',
      status: 'pending',
      issues: [],
    });
  }

  // Headings — check hierarchy
  if (RE_HEADING.test(fullDiff)) {
    items.push({
      name: 'heading-hierarchy',
      category: 'Structure & Semantics',
      description: 'Headings used in logical order, no skipped levels, one h1 per page',
      status: 'pending',
      issues: [],
    });
  }

  // Buttons — check semantic usage
  if (RE_BUTTON.test(fullDiff)) {
    items.push({
      name: 'button-semantics',
      category: 'Interactive Controls',
      description: 'Actions use <button> element, not div/span with onClick',
      status: 'pending',
      issues: [],
    });
  }

  // Div/span as interactive element — anti-pattern detection
  if (RE_DIV_INTERACTIVE.test(fullDiff)) {
    items.push({
      name: 'non-semantic-interactive',
      category: 'Interactive Controls',
      description:
        'No div/span used as buttons, inputs, or links — use native <button>, <input>, <select>, <a> instead of ARIA role overrides on generic elements',
      status: 'pending',
      issues: [],
    });
  }

  // Links — check semantics and external link handling
  if (RE_LINK.test(fullDiff)) {
    items.push({
      name: 'link-semantics',
      category: 'Interactive Controls',
      description: 'Links use <a> with href; external links have rel="noopener noreferrer"',
      status: 'pending',
      issues: [],
    });
  }

  // External links — target="_blank" handling
  if (RE_BLANK.test(fullDiff)) {
    items.push({
      name: 'external-links',
      category: 'Interactive Controls',
      description: 'External links indicate new tab and use rel="noopener noreferrer"',
      status: 'pending',
      issues: [],
    });
  }

  // Form inputs — check labels
  if (RE_INPUT.test(fullDiff)) {
    items.push({
      name: 'form-labels',
      category: 'Forms',
      description:
        'All inputs have associated labels; fieldset/legend for groups; autocomplete on common fields',
      status: 'pending',
      issues: [],
    });
  }

  // ARIA — check correct usage
  if (RE_ARIA.test(fullDiff)) {
    items.push({
      name: 'aria-usage',
      category: 'ARIA & Custom Widgets',
      description: 'ARIA used correctly — no redundant roles, valid attributes, proper labeling',
      status: 'pending',
      issues: [],
    });
  }

  // Tab index — check for values > 0
  if (RE_TABINDEX.test(fullDiff)) {
    items.push({
      name: 'focus-management',
      category: 'Keyboard & Navigation',
      description: 'No tabIndex > 0; focus order matches visual layout',
      status: 'pending',
      issues: [],
    });
  }

  // Focus styles — check visibility
  if (RE_FOCUS.test(fullDiff)) {
    items.push({
      name: 'focus-styles',
      category: 'Keyboard & Navigation',
      description: 'Visible focus styles on all interactive elements',
      status: 'pending',
      issues: [],
    });
  }

  // Outline removal — anti-pattern
  if (RE_OUTLINE_NONE.test(fullDiff)) {
    items.push({
      name: 'outline-removal',
      category: 'Keyboard & Navigation',
      description: 'No outline:none without replacement focus style (focus-visible preferred)',
      status: 'pending',
      issues: [],
    });
  }

  // Color — contrast check
  if (RE_COLOR.test(fullDiff)) {
    items.push({
      name: 'color-contrast',
      category: 'Color & Contrast',
      description: 'Text contrast >= 4.5:1 (normal) / 3:1 (large); color not sole indicator',
      status: 'pending',
      issues: [],
    });
  }

  // Motion & animation
  if (RE_MOTION.test(fullDiff)) {
    items.push({
      name: 'motion-safety',
      category: 'Motion & Animation',
      description: 'Animations respect prefers-reduced-motion; no 3+ flashes/sec',
      status: 'pending',
      issues: [],
    });
  }

  // Media elements
  if (RE_MEDIA.test(fullDiff)) {
    items.push({
      name: 'media-accessibility',
      category: 'Media',
      description:
        'Media does not autoplay; all media can be paused; controls use appropriate markup; video has captions; audio has transcripts; iframes have title',
      status: 'pending',
      issues: [],
    });
  }

  // Autofocus — anti-pattern
  if (RE_AUTOFOCUS.test(fullDiff)) {
    items.push({
      name: 'no-autofocus',
      category: 'Keyboard & Navigation',
      description: 'Avoid autofocus — disorients screen reader and motor-impaired users',
      status: 'pending',
      issues: [],
    });
  }

  // Language attribute
  if (RE_LANG.test(fullDiff)) {
    items.push({
      name: 'language',
      category: 'Structure & Semantics',
      description: 'lang attribute present on html element for correct pronunciation',
      status: 'pending',
      issues: [],
    });
  }

  // Lists
  if (RE_LIST.test(fullDiff)) {
    items.push({
      name: 'list-semantics',
      category: 'Structure & Semantics',
      description: 'List content uses proper ul/ol/dl elements',
      status: 'pending',
      issues: [],
    });
  }

  // Tables
  if (RE_TABLE.test(fullDiff)) {
    items.push({
      name: 'table-semantics',
      category: 'Structure & Semantics',
      description: 'Tables use th with scope, caption for title',
      status: 'pending',
      issues: [],
    });
  }

  // Dialogs & modals
  if (RE_DIALOG.test(fullDiff)) {
    items.push({
      name: 'dialog-accessibility',
      category: 'ARIA & Custom Widgets',
      description: 'Dialogs trap focus correctly, have aria-label, return focus on close',
      status: 'pending',
      issues: [],
    });
  }

  // Tooltips & title attributes
  if (RE_TOOLTIP.test(fullDiff)) {
    items.push({
      name: 'tooltip-accessibility',
      category: 'ARIA & Custom Widgets',
      description: 'Avoid title attribute tooltips; use accessible alternatives',
      status: 'pending',
      issues: [],
    });
  }

  // Keyboard interactions
  if (RE_KEYBOARD.test(fullDiff)) {
    items.push({
      name: 'keyboard-interaction',
      category: 'Keyboard & Navigation',
      description: 'Keyboard handlers include appropriate key bindings; no keyboard traps',
      status: 'pending',
      issues: [],
    });
  }

  // Scrolling areas
  if (RE_SCROLL.test(fullDiff)) {
    items.push({
      name: 'scroll-accessibility',
      category: 'Responsive & Touch',
      description: 'Scrollable areas are keyboard accessible; no horizontal scroll at 320px',
      status: 'pending',
      issues: [],
    });
  }

  // Dynamic content
  if (RE_DYNAMIC.test(fullDiff)) {
    items.push({
      name: 'dynamic-content',
      category: 'ARIA & Custom Widgets',
      description: 'Dynamic content updates announced via aria-live or role="alert"',
      status: 'pending',
      issues: [],
    });
  }

  // Viewport meta
  if (RE_VIEWPORT.test(fullDiff)) {
    items.push({
      name: 'viewport-zoom',
      category: 'Responsive & Touch',
      description: 'Viewport does not disable zoom (no user-scalable=no)',
      status: 'pending',
      issues: [],
    });
  }

  // Landmark elements — check semantic regions
  if (RE_LANDMARK.test(fullDiff)) {
    items.push({
      name: 'landmark-elements',
      category: 'Structure & Semantics',
      description: 'Landmark elements (main, nav, header, footer, aside) used for content regions',
      status: 'pending',
      issues: [],
    });
  }

  // Page/view title
  if (RE_PAGE_TITLE.test(fullDiff)) {
    items.push({
      name: 'page-title',
      category: 'Structure & Semantics',
      description: 'Each page/view has a unique, descriptive <title>',
      status: 'pending',
      issues: [],
    });
  }

  // Skip link
  if (RE_SKIP_LINK.test(fullDiff)) {
    items.push({
      name: 'skip-link',
      category: 'Keyboard & Navigation',
      description: 'Skip link present and visible when focused, targets main content',
      status: 'pending',
      issues: [],
    });
  }

  // Hidden but focusable elements — anti-pattern
  if (RE_HIDDEN_INTERACTIVE.test(fullDiff)) {
    items.push({
      name: 'hidden-focusable',
      category: 'Keyboard & Navigation',
      description:
        'No invisible elements (display:none, visibility:hidden, hidden attr) remain in tab order',
      status: 'pending',
      issues: [],
    });
  }

  // Form error handling
  if (RE_FORM_ERROR.test(fullDiff) || RE_INPUT.test(fullDiff)) {
    items.push({
      name: 'form-error-handling',
      category: 'Forms',
      description:
        'Form errors associated with inputs via aria-describedby/aria-errormessage; errors not communicated by color alone',
      status: 'pending',
      issues: [],
    });
  }

  // Error/warning/success states — not color-only
  if (RE_STATUS_STATE.test(fullDiff)) {
    items.push({
      name: 'status-not-color-only',
      category: 'Color & Contrast',
      description: 'Error, warning, and success states use icons/text in addition to color',
      status: 'pending',
      issues: [],
    });
  }

  // Custom ::selection contrast
  if (RE_SELECTION.test(fullDiff)) {
    items.push({
      name: 'selection-contrast',
      category: 'Color & Contrast',
      description: 'Custom ::selection colors maintain sufficient contrast',
      status: 'pending',
      issues: [],
    });
  }

  // Orientation — no lock
  if (RE_ORIENTATION.test(fullDiff)) {
    items.push({
      name: 'orientation-support',
      category: 'Responsive & Touch',
      description: 'No CSS orientation lock — site can rotate to any orientation',
      status: 'pending',
      issues: [],
    });
  }

  // Icon contrast
  if (RE_ICON.test(fullDiff)) {
    items.push({
      name: 'icon-contrast',
      category: 'Color & Contrast',
      description: 'Icons have >= 3:1 contrast ratio against background',
      status: 'pending',
      issues: [],
    });
  }

  // Link distinguishability — anti-pattern
  if (RE_LINK_NO_UNDERLINE.test(fullDiff) && RE_LINK.test(fullDiff)) {
    items.push({
      name: 'link-distinguishable',
      category: 'Interactive Controls',
      description:
        'Links are visually recognizable — if underline removed, another non-color indicator exists',
      status: 'pending',
      issues: [],
    });
  }

  // Input border contrast (when inputs + color changes present)
  if (RE_INPUT.test(fullDiff) && RE_COLOR.test(fullDiff)) {
    items.push({
      name: 'input-border-contrast',
      category: 'Color & Contrast',
      description: 'Input borders have >= 3:1 contrast ratio against adjacent colors',
      status: 'pending',
      issues: [],
    });
  }

  // Fallback: always check general accessibility
  if (items.length === 0) {
    items.push({
      name: 'general-accessibility',
      category: 'General',
      description: 'General WCAG AA compliance review',
      status: 'pending',
      issues: [],
    });
  }

  return items;
}

// ============ CHECKLIST STATE ============

// ============ COMMANDS ============

function generate() {
  const stagedFiles = getStagedFiles();
  if (stagedFiles.length === 0) {
    log(
      '⏭️  No staged frontend files under review.frontendRoots (guard.config.json). Skipping accessibility review.',
    );
    process.exit(0);
  }
  const diffs = stagedFiles.map((f) => getFileDiff(f));
  const items = detectAccessibilityPatterns(stagedFiles, diffs);
  const data = { generated: new Date().toISOString(), files: stagedFiles, items };
  saveChecklist(data);
  log(`✅ Frontend Accessibility: ${stagedFiles.length} files, ${items.length} checks`);
  log('');
  log('Items to review:');
  for (const item of items) log(`  - [${item.category}] ${item.name}: ${item.description}`);
}

function contrast(fg, bg) {
  if (!fg || !bg) {
    log('Usage: contrast <foreground-hex> <background-hex>');
    log('Example: contrast "#333333" "#ffffff"');
    process.exit(1);
  }
  const fgClean = fg.replace(/['"]/g, '');
  const bgClean = bg.replace(/['"]/g, '');

  try {
    const result = checkContrastRatio(fgClean, bgClean);
    log(`Foreground: ${fgClean} | Background: ${bgClean}`);
    log(`Contrast ratio: ${result.ratio}:1`);
    log(`AA normal text (>= 4.5:1): ${result.passAANormal ? 'PASS' : 'FAIL'}`);
    log(`AA large text  (>= 3:1):   ${result.passAALarge ? 'PASS' : 'FAIL'}`);
    log(`AA non-text    (>= 3:1):   ${result.passAANonText ? 'PASS' : 'FAIL'}`);
    if (!result.passAANormal) {
      process.exit(1);
    }
  } catch (e) {
    log(`❌ Invalid color format: ${e.message}`);
    log('Use hex format: #RGB, #RRGGBB');
    process.exit(1);
  }
}

// ============ MAIN ============

const args = process.argv.slice(2);
const cmd = args[0];
switch (cmd) {
  case 'generate':
    generate();
    break;
  case 'status':
    status();
    break;
  case 'check-item': {
    const name = args[1];
    const pass = args.includes('--pass');
    const failIdx = args.indexOf('--fail');
    const failReason = failIdx !== -1 ? args[failIdx + 1] : null;
    if (!name || (!pass && failIdx === -1)) {
      log('Usage: check-item <name> --pass OR --fail "reason"');
      process.exit(1);
    }
    checkItem(name, pass, failReason);
    break;
  }
  case 'finalize':
    finalize();
    break;
  case 'cleanup':
    cleanup();
    break;
  case 'contrast': {
    const fg = args[1];
    const bg = args[2];
    contrast(fg, bg);
    break;
  }
  default:
    log('Frontend Accessibility Review Commands:');
    log('  generate                    Create checklist from staged files');
    log('  status                      Show progress');
    log('  check-item <name> --pass    Mark item passed');
    log('  check-item <name> --fail    Mark item failed');
    log('  finalize                    Verify every item was resolved');
    log('  cleanup                     Remove checklist');
    log('  contrast <fg> <bg>          Check WCAG color contrast ratio');
    process.exit(1);
}
