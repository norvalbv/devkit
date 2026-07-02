---
name: Frontend Security
description: Security best practices for frontend/client-side code. Use when implementing user-facing features, handling user input in the browser, rendering user-generated content, storing tokens/sessions, or configuring security headers. Covers XSS prevention, CSRF protection, secure token storage, Content Security Policy, and input sanitization.
---

# Frontend Security

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
- Form inputs validated client-side (with server validation)
