---
name: Frontend Performance
description: Performance optimization for frontend/client-side code. Use when optimizing page load times, bundle sizes, images, fonts, or Core Web Vitals. Covers HTML/CSS/JS optimization, image handling, lazy loading, critical CSS, code splitting, and performance measurement.
---

# Frontend Performance

## Review Script

```bash
SCRIPT=".claude/skills/frontend-performance/scripts/checklist.mjs"

node $SCRIPT generate     # Create checklist from staged frontend files
node $SCRIPT status       # Show progress
node $SCRIPT check-item <name> --pass   # Mark item passed
node $SCRIPT check-item <name> --fail "reason"  # Mark item failed
node $SCRIPT finalize     # Verify & approve
node $SCRIPT cleanup      # Remove checklist
```

The frontend roots the script scans come from `guard.config.json` `review.frontendRoots` —
they are not hardcoded. When unset/empty there is nothing to review.

## High Priority

- Keep your page weight < 1500 KB (ideally < 500 kb)
- Keep your page load time < 3 seconds
- GZIP / Brotli compression is enabled
- Minimize HTTP Requests
- Compress your images / keep the image count low
- Set HTTP cache headers properly
- Keep the Time To First Byte < 1.3 seconds
- Non Blocking JavaScript: Use async / defer
- Minify your JavaScript
- Minified CSS - Remove comments, whitespaces etc
- Inline the Critical CSS (above the fold CSS)
- CSS files are non-blocking
- Use HTTPs on your website
- Choose your image format appropriately
- Avoid requesting unreachable files (404)
- Serve files from the same protocol
- Minimize number of iframes
- Avoid the embedded / inline CSS
- Analyse stylesheets complexity

```html
<!-- Non-blocking CSS -->
<link rel="preload" href="styles.css" as="style" onload="this.rel='stylesheet'">

<!-- Async/defer scripts -->
<script src="analytics.js" async></script>
<script src="app.js" defer></script>
```

## Medium Priority

- Minified HTML - Remove comments and whitespaces
- Use Content Delivery Network
- Prefer using vector image rather than bitmap images
- Set width and height attributes on images (aspect ratio)
- Avoid using Base64 images
- Offscreen images are loaded lazily
- Ensure to serve images that are close to your display size
- Avoid multiple inline JavaScript snippets `<script>`
- Keep your dependencies up to date
- Check for performance problems in your JavaScript files
- Service Workers for caching / performing heavy tasks
- Cookie size should be less than 4096 bytes
- Keep the cookie count less than 20

```html
<!-- Lazy loading images -->
<img src="photo.jpg" loading="lazy" width="800" height="600" alt="...">

<!-- Responsive images -->
<img srcset="small.jpg 300w, medium.jpg 600w, large.jpg 1200w"
     sizes="(max-width: 600px) 300px, 600px"
     src="medium.jpg" alt="...">
```

## Low Priority

- Pre-load URLs where possible
- Concatenate CSS into a single file
- Remove unused CSS
- Use WOFF2 font format
- Use preconnect to load your fonts faster
- Keep the web font size under 300kb
- Prevent Flash or Invisible Text
- Keep an eye on the size of dependencies

```html
<!-- Resource hints -->
<link rel="preconnect" href="https://api.example.com">
<link rel="dns-prefetch" href="https://cdn.example.com">
<link rel="preload" href="/critical.css" as="style">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
```

## Performance Tools

| Tool | Use Case |
|------|----------|
| Page Speed Insights | Field + lab data |
| Lighthouse | Overall audit |
| WebPageTest | Detailed waterfall |
| Chrome DevTools | Runtime profiling |

## Checklist

**High priority:**
- [ ] Page weight < 1500KB (ideally < 500KB)
- [ ] Load time < 3 seconds
- [ ] TTFB < 1.3 seconds
- [ ] GZIP/Brotli enabled
- [ ] Images optimized
- [ ] JS/CSS minified
- [ ] Critical CSS inlined
- [ ] Non-blocking CSS/JS
- [ ] HTTPS enabled
- [ ] No 404s
- [ ] HTTP cache headers set

**Medium priority:**
- [ ] HTML minified
- [ ] CDN for assets
- [ ] Lazy loading images
- [ ] Responsive images
- [ ] Dependencies up to date
- [ ] Service Worker caching
- [ ] Cookie size < 4096 bytes
- [ ] Cookie count < 20

**Low priority:**
- [ ] Remove unused CSS
- [ ] WOFF2 fonts
- [ ] Preconnect hints
- [ ] CSS concatenation
- [ ] Font size < 300KB
