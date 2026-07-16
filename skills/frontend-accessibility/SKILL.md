---
name: Frontend Accessibility
description: WCAG AA accessibility best practices for frontend code. Use when implementing UI components, handling user interaction, rendering dynamic content, creating forms, or adding images/media. Covers semantic HTML, keyboard navigation, ARIA, color contrast, focus management, forms, images, motion safety, and responsive design.
---

# Frontend Accessibility (WCAG AA)

## Consumer toggles

This skill is parameterized by `guard.config.json` `review.accessibility`:
- `skipTouchTargets` (default `false`) — when `true`, the 44×44px touch/tap target rules
  (WCAG 2.5.5/2.5.8) are NOT enforced. Set this for desktop-class apps where controls are
  legitimately smaller. When `false`/unset, enforce target sizes normally.

If a Memory MCP (`search_nodes`) is available, search it before flagging something that could be
a deliberate project decision (color choices, component patterns); respect a matching decision.

## Review Script

```bash
SCRIPT=".claude/skills/frontend-accessibility/scripts/checklist.mjs"

node $SCRIPT generate     # Enumerate review items from staged frontend files
node $SCRIPT status       # Show progress
node $SCRIPT check-item <name> --pass   # Mark item passed
node $SCRIPT check-item <name> --fail "reason"  # Mark item failed
node $SCRIPT finalize     # Verify every item was resolved; refuses if any are pending or failed
if [ "${DEVKIT_RUN_MODE:-}" != "review" ]; then node $SCRIPT cleanup; fi
node $SCRIPT contrast "#foreground" "#background"  # Check color contrast ratio
```

The frontend roots the script scans come from `guard.config.json` `review.frontendRoots` — not
hardcoded. When that key is absent it scans all staged files; a present-but-invalid value warns
and falls back to scanning all. `devkit review` orchestration may inject effective roots through
`DEVKIT_REVIEW_FRONTEND_ROOTS`; that validated JSON array takes precedence.

## Structure & Semantics

**Use semantic HTML elements:**

```tsx
// BAD: generic divs for everything
<div className="header">
  <div className="nav">...</div>
</div>
<div className="content">...</div>

// GOOD: semantic landmarks
<header>
  <nav aria-label="Main navigation">...</nav>
</header>
<main>...</main>
<footer>...</footer>
```

**Headings in logical order:**

```tsx
// BAD: skipped heading levels
<h1>Page Title</h1>
<h3>Subsection</h3>  // skipped h2

// GOOD: sequential heading levels
<h1>Page Title</h1>
<h2>Section</h2>
<h3>Subsection</h3>
```

**Rules:**
- Use `lang` attribute on the root `<html>` element (WCAG 3.1.1)
- One `<h1>` per page/view, headings descend sequentially (WCAG 2.4.6)
- Use landmark elements: `<main>`, `<nav>`, `<header>`, `<footer>`, `<aside>` (WCAG 4.1.2)
- Use `<ul>`/`<ol>` for lists, `<dl>` for key-value pairs (WCAG 1.3.1)
- Tables use `<th>` with `scope`, and `<caption>` for title (WCAG 1.3.1)
- Iframes must have a descriptive `title` attribute (WCAG 4.1.2)
- Validate HTML — invalid markup breaks assistive tech (WCAG 4.1.1)

## Keyboard & Navigation

**Visible focus styles:**

```tsx
// BAD: removing focus outline
<button className="outline-none">Click me</button>

// GOOD: visible focus ring
<button className="focus:ring-2 focus:ring-blue-500 focus-visible:ring-2">
  Click me
</button>
```

**Tab order:**

```tsx
// BAD: positive tabindex disrupts natural order
<div tabIndex={5}>First</div>
<div tabIndex={1}>Second</div>

// GOOD: use tabIndex={0} to add to flow, tabIndex={-1} for programmatic focus
<div tabIndex={0}>Focusable in order</div>
<div tabIndex={-1} ref={ref}>Programmatic focus only</div>
```

**Rules:**
- All interactive elements must have visible focus styles (WCAG 2.4.7)
- Tab order must match visual layout (WCAG 1.3.2)
- Never use `tabIndex` > 0 (WCAG 2.4.3)
- Remove focus from invisible/offscreen elements (WCAG 2.4.3)
- Avoid `autofocus` — disorients screen reader users (WCAG 2.4.3)
- Provide a skip link to bypass repeated navigation (WCAG 2.4.1)
- No keyboard traps — users must be able to leave any component (WCAG 2.1.2)
- Ensure linear content flow — no unexpected focus jumps (WCAG 2.4.3)

## Images

**Alt text rules:**

```tsx
// BAD: missing alt
<img src="photo.jpg" />

// GOOD: descriptive alt
<img src="team-photo.jpg" alt="Engineering team at the 2025 retreat" />

// GOOD: decorative image with empty alt
<img src="divider.svg" alt="" />

// GOOD: complex image with extended description
<img src="chart.png" alt="Q3 revenue chart" aria-describedby="chart-desc" />
<p id="chart-desc">Revenue grew 15% from $2M to $2.3M across Q3...</p>
```

**Rules:**
- Every `<img>` must have an `alt` attribute (WCAG 1.1.1)
- Decorative images use `alt=""` (empty, not missing) (WCAG 1.1.1)
- Complex images (charts, graphs, maps) need text alternative (WCAG 1.1.1)
- Images containing text must include that text in `alt` (WCAG 1.1.1)
- Icon-only buttons need `aria-label` (WCAG 1.1.1)

## Forms

**Associated labels:**

```tsx
// BAD: no label association
<input type="email" placeholder="Email" />

// GOOD: explicit label with for/id
<label htmlFor="email">Email address</label>
<input id="email" type="email" autoComplete="email" />

// GOOD: wrapping label
<label>
  Email address
  <input type="email" autoComplete="email" />
</label>
```

**Error handling:**

```tsx
// BAD: color-only error indication
<input style={{ borderColor: 'red' }} />

// GOOD: error with text, icon, and aria association
<label htmlFor="email">Email address</label>
<input
  id="email"
  type="email"
  aria-invalid={!!error}
  aria-describedby={error ? 'email-error' : undefined}
/>
{error && (
  <p id="email-error" role="alert">
    <WarningIcon aria-hidden="true" /> {error}
  </p>
)}
```

**Rules:**
- Every input associated with `<label>` via `for`/`id` or wrapping (WCAG 3.2.2)
- Use `<fieldset>` and `<legend>` for related input groups (WCAG 1.3.1)
- Use `autocomplete` on common fields: name, email, phone, address (WCAG 1.3.5)
- Error messages associated via `aria-describedby` (WCAG 3.3.1)
- Errors displayed as list above form after submission (WCAG 3.3.1)
- Error states not communicated by color alone — use text/icons too (WCAG 1.4.1)

## Interactive Controls

**Semantic buttons and links:**

```tsx
// BAD: div as button
<div onClick={handleClick} className="btn">Save</div>

// GOOD: native button
<button type="button" onClick={handleClick}>Save</button>

// BAD: button as link
<button onClick={() => navigate('/about')}>About</button>

// GOOD: anchor for navigation
<a href="/about">About</a>

// GOOD: external link with warning
<a href="https://example.com" target="_blank" rel="noopener noreferrer">
  Example <span className="sr-only">(opens in new tab)</span>
</a>
```

**Rules:**
- Use `<button>` for actions, `<a>` for navigation (WCAG 1.3.1)
- Links must always have `href` attribute (WCAG 1.3.1)
- Links must be visually distinguishable (not just by color) (WCAG 1.4.1)
- External links use `rel="noopener noreferrer"` (WCAG G201)
- External links should indicate they open in a new tab (WCAG G201)
- All controls must have `:focus` states (WCAG 2.4.7)

## ARIA & Custom Widgets

**Correct ARIA usage:**

```tsx
// BAD: redundant role on native element
<button role="button">Click me</button>
<nav role="navigation">...</nav>

// GOOD: ARIA only where native semantics are insufficient
<div role="tablist" aria-label="Settings tabs">
  <button role="tab" aria-selected={active === 0} aria-controls="panel-0">
    General
  </button>
</div>
<div role="tabpanel" id="panel-0" aria-labelledby="tab-0">
  ...
</div>
```

**Live regions for dynamic content:**

```tsx
// GOOD: announce dynamic updates to screen readers
<div aria-live="polite" aria-atomic="true">
  {statusMessage}
</div>

// GOOD: assertive for errors
<div role="alert">
  {errorMessage}
</div>
```

**Rules:**
- Don't add ARIA roles that duplicate native element semantics (WCAG 4.1.2)
- Custom widgets must have `aria-label` or `aria-labelledby` (WCAG 4.1.2)
- Dynamic content updates use `aria-live` or `role="alert"` (WCAG 4.1.3)
- Use valid ARIA attributes — no misspelled or incorrect values
- Prefer native HTML semantics over ARIA when possible
- `aria-hidden="true"` on decorative icons within labeled controls

## Color & Contrast

**Contrast ratios (WCAG AA):**

| Element | Minimum Ratio | WCAG |
|---------|--------------|------|
| Normal text (< 18px / < 14px bold) | 4.5:1 | 1.4.3 |
| Large text (>= 18px / >= 14px bold) | 3:1 | 1.4.3 |
| UI components & icons | 3:1 | 1.4.11 |
| Input borders | 3:1 | 1.4.11 |
| Focus indicators | 3:1 | 1.4.11 |

**Verify contrast with the script:**

```bash
node .claude/skills/frontend-accessibility/scripts/checklist.mjs contrast "#6b7280" "#ffffff"
# Output: Contrast ratio: 4.59:1 | AA normal: PASS | AA large: PASS
```

**Rules:**
- Normal text contrast >= 4.5:1 against background (WCAG 1.4.3)
- Large text contrast >= 3:1 against background (WCAG 1.4.3)
- UI component boundaries (icons, borders, inputs) contrast >= 3:1 (WCAG 1.4.11)
- Color must not be the only way to convey information (WCAG 1.4.1)
- Check `::selection` custom colors for contrast (WCAG 1.4.3)
- Check text overlapping images/video for legibility (WCAG 1.4.3)
- Test in high-contrast modes and inverted colors (WCAG 1.4.1)

## Motion & Animation

**Respect motion preferences:**

```tsx
// GOOD: CSS respects prefers-reduced-motion
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

// GOOD: React hook for motion
const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
```

**Rules:**
- All animations must obey `prefers-reduced-motion` (WCAG 2.3.3)
- No content flashes more than 3 times per second (WCAG 2.3.1)
- Media must not autoplay (WCAG 1.4.2)
- All media must be pausable (WCAG 2.1.1)
- Video must have captions (WCAG 1.2.2)
- Audio must have transcripts (WCAG 1.1.1)
- Background video must have a pause mechanism (WCAG 2.2.2)
- Provide mechanism to pause moving/scrolling content (WCAG 2.2.2)

## Responsive & Touch

**Viewport configuration:**

```html
<!-- BAD: disables zoom -->
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">

<!-- GOOD: allows zoom -->
<meta name="viewport" content="width=device-width, initial-scale=1">
```

**Rules:**
- Viewport zoom must not be disabled — no `user-scalable=no` (WCAG 1.4.4)
- Content must reflow without horizontal scroll at 320px width (WCAG 1.4.10)
- Text resizable to 200% without loss of content/function (WCAG 1.4.4)
- Sufficient space between interactive items for scrolling (WCAG 2.4.1)
- Site works in any orientation — don't lock to portrait (WCAG 1.3.4)
- Touch/tap targets >= 44×44px (WCAG 2.5.5/2.5.8) — **unless** `review.accessibility.skipTouchTargets` is `true`, in which case do not check or flag target size.

## Checklist

**Structure & Semantics:**
- `lang` attribute on root HTML element
- One `h1` per page, headings in logical sequence
- Landmark elements for major page areas
- Semantic HTML over generic divs
- Lists use proper list elements
- Tables use `th`, `scope`, `caption`
- Iframes have `title` attribute

**Keyboard & Navigation:**
- Visible focus styles on all interactive elements
- Tab order matches visual layout
- No `tabIndex` > 0
- Skip link present
- No `autofocus` attribute
- No keyboard traps

**Images:**
- All `img` have `alt` attribute
- Decorative images use `alt=""`
- Complex images have text alternatives
- Images with text include text in `alt`

**Forms:**
- All inputs have associated labels
- Related inputs grouped with `fieldset`/`legend`
- `autocomplete` on common fields
- Errors associated with inputs via `aria-describedby`
- Error states use text/icons, not color alone

**Interactive Controls:**
- Buttons use `<button>`, links use `<a href>`
- External links have `rel="noopener noreferrer"`
- All controls have `:focus` state

**ARIA & Custom Widgets:**
- No redundant ARIA roles on native elements
- Custom widgets labeled with `aria-label`/`aria-labelledby`
- Dynamic content uses `aria-live` regions

**Color & Contrast:**
- Normal text contrast >= 4.5:1
- Large text contrast >= 3:1
- Non-text contrast >= 3:1
- Color not sole information indicator

**Motion & Media:**
- Animations respect `prefers-reduced-motion`
- No 3+ flashes per second
- Media does not autoplay
- Video has captions

**Responsive & Touch:**
- Viewport zoom not disabled
- Content reflows at 320px width
- Works in any orientation
- Touch targets >= 44×44px (unless `review.accessibility.skipTouchTargets` is true)
