---
name: Frontend Security
description: Security best practices for frontend/client-side code. Use when implementing user-facing features, handling user input in the browser, rendering user-generated content, storing tokens/sessions, or configuring security headers. Covers XSS prevention, CSRF protection, secure token storage, Content Security Policy, and input sanitization.
---

# Frontend Security

## Review Script

```bash
SCRIPT=".claude/skills/frontend-security/scripts/checklist.mjs"

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

## XSS Prevention

**Sanitize user-provided HTML:**

```typescript
import DOMPurify from 'isomorphic-dompurify'

function renderUserContent(html: string) {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'p'],
    ALLOWED_ATTR: []
  })
  return <div dangerouslySetInnerHTML={{ __html: clean }} />
}
```

**Rules:**
- Never use `dangerouslySetInnerHTML` without sanitization
- Use React's built-in escaping for text content
- Validate URLs before using in `href` or `src`

## CSRF Protection

**Include CSRF tokens on state-changing requests:**

```typescript
const response = await fetch('/api/action', {
  method: 'POST',
  headers: {
    'X-CSRF-Token': csrfToken,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(data)
})
```

## Secure Token Storage

```typescript
// BAD: localStorage (vulnerable to XSS)
localStorage.setItem('token', token)

// GOOD: httpOnly cookies (set by server)
// Token automatically sent with requests, inaccessible to JS
```

**Rules:**
- Never store sensitive tokens in localStorage or sessionStorage
- Use httpOnly, Secure, SameSite=Strict cookies
- Clear tokens on logout

## Content Security Policy

```javascript
// next.config.js or server headers
const cspHeader = `
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  font-src 'self';
  connect-src 'self' https://api.example.com;
  frame-ancestors 'none';
`.replace(/\s{2,}/g, ' ').trim()
```

## Input Validation (Client-Side)

```typescript
import { z } from 'zod'

const FormSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
})

// Validate before submission
const result = FormSchema.safeParse(formData)
if (!result.success) {
  // Show validation errors
}
```

**Note:** Client-side validation is for UX only. Always validate on server.

## Cross-Origin Messaging (`postmessage-origin`)

```typescript
// FAIL: any window can send this handler instructions
window.addEventListener('message', (e) => applySettings(e.data))

// PASS: exact origin check + explicit target origin
window.addEventListener('message', (e) => {
  if (e.origin !== 'https://trusted.example.com') return
  applySettings(e.data)
})
frame.contentWindow.postMessage(payload, 'https://trusted.example.com')
```

- FAIL a `message` handler that reads `event.data` without an exact `event.origin` check —
  wildcard-substring checks (`origin.includes('example.com')`) also FAIL (subdomain/lookalike
  bypass).
- FAIL `postMessage(data, '*')` when the payload carries anything sensitive.
- Treat `event.data` as untrusted input: FAIL if it flows into `innerHTML`, `eval`, or state
  that gates privileged behavior without validation.

## Security Headers

Essential headers to configure:

| Header | Value | Purpose |
|--------|-------|---------|
| X-Content-Type-Options | nosniff | Prevent MIME sniffing |
| X-Frame-Options | DENY | Prevent clickjacking |
| Referrer-Policy | strict-origin-when-cross-origin | Control referrer info |
| Permissions-Policy | camera=(), microphone=() | Disable unused APIs |

## Checklist

- User-provided HTML sanitized with DOMPurify
- CSRF tokens on all state-changing requests
- Tokens in httpOnly cookies, not localStorage
- CSP headers configured
- No sensitive data in URL parameters
- External links use `rel="noopener noreferrer"`
- `message` handlers verify `event.origin` exactly; `postMessage` names its target origin
- Form inputs validated client-side (with server validation)

## Provenance

Rule text is written for this repo (OWASP-derived guidance; no roadmap.sh frontend-security
list exists). `postmessage-origin` was added from the OWASP ASVS v5.0 (CC-BY-SA) chapter V3 Web
Frontend Security coverage diff. Rejected V3 topics: browser-feature policy headers and cookie
attributes are covered by existing items (`cookie-security`, security-header guidance);
WebRTC (V17) is out of scope for this catalog.
