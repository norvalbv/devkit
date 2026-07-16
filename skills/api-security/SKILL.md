---
name: API Security
description: Security best practices for APIs and backend endpoints. Use when creating API routes, implementing authentication/authorization, handling JWT tokens, validating input, configuring OAuth, or securing API responses. Covers authentication, JWT, access control, object-level authorization, injection (SQL, command, path, SSRF), output security, and monitoring.
---

# API Security

## Review Script

```bash
SCRIPT=".claude/skills/api-security/scripts/checklist.mjs"

node $SCRIPT generate     # Enumerate review items from staged backend files
node $SCRIPT status       # Show progress
node $SCRIPT check-item <name> --pass   # Mark item passed
node $SCRIPT check-item <name> --fail "reason"  # Mark item failed
node $SCRIPT finalize     # Verify every item was resolved; refuses if any are pending or failed
if [ "${DEVKIT_RUN_MODE:-}" != "review" ]; then node $SCRIPT cleanup; fi
```

The backend roots the script scans come from `guard.config.json` `review.backendRoots` — not
hardcoded. When that key is absent it scans all staged files; a present-but-invalid value warns
and falls back to scanning all. `devkit review` injects the gate's effective roots through
`DEVKIT_REVIEW_BACKEND_ROOTS`; that validated JSON array takes precedence.

Each section below is one checklist item (or a small group). Every rule names the evidence to
grep for and the condition that makes the item a FAIL — pass anything that doesn't meet a FAIL
bar.

## Authentication (`auth-mechanism`)

- FAIL if credentials are compared or stored in plaintext — look for `password ===`, password
  columns written without a `bcrypt`/`argon2`/`scrypt` hash.
- FAIL if a login path has no attempt limiter at all (no rate limit, lockout, or backoff on the
  auth route or its router).
- FAIL if a hand-rolled session/credential scheme replaces an established one where one is
  already in use elsewhere in the codebase.

```typescript
// Rate limit login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts'
})
```

## JWT (`jwt-security`)

```typescript
const token = jwt.sign(payload, process.env.JWT_SECRET, {
  expiresIn: '15m',
  algorithm: 'HS256'
})

const decoded = jwt.verify(token, process.env.JWT_SECRET, {
  algorithms: ['HS256'] // pinned server-side, never read from the token header
})
```

- FAIL if the signing secret is a string literal in code instead of configuration.
- FAIL if `verify` accepts the algorithm from the incoming token (missing an explicit
  `algorithms` allowlist) or accepts `none`.
- FAIL if tokens are minted with no expiry.
- FAIL if the payload carries secrets or sensitive PII — the payload is readable by anyone who
  holds the token.

## OAuth (`oauth-security`)

- FAIL if `redirect_uri` is used without a server-side exact-match check against registered URIs.
- FAIL if the implicit flow (`response_type=token`) is introduced where the code-exchange flow is
  available.
- FAIL if an authorization request/callback pair carries no `state` (or PKCE) value.
- FAIL if requested scopes are passed through unvalidated.

## Object-Level Authorization (`object-level-authz`)

The most common real-world API vulnerability: an endpoint that fetches, updates, or deletes a
record by a client-supplied ID without proving the caller may touch *that* record.

```typescript
// FAIL: any authenticated user can read any invoice
const invoice = await db.invoice.findUnique({ where: { id: req.params.id } })

// PASS: lookup scoped to the caller
const invoice = await db.invoice.findFirst({
  where: { id: req.params.id, ownerId: session.user.id },
})
```

- Trace every lookup/update/delete keyed by `req.params`/`req.query` IDs: FAIL unless the query
  is scoped to the authenticated principal (a `WHERE owner/tenant` clause) or an explicit
  ownership/role check runs before the operation.
- Authentication on the route is NOT sufficient — this item is about which rows, not who's
  logged in.

## Endpoint Auth & Rate Limiting (`endpoint-auth`, `rate-limiting`)

- FAIL a new route handler that skips the auth middleware its sibling routes carry, unless it is
  explicitly public by design (health checks, login itself, webhooks with their own verification).
- FAIL state-changing or expensive endpoints added with no throttling anywhere in their chain
  when the repo already has a rate-limiting layer they bypass.

## Input Validation (`input-validation`)

```typescript
import { z } from 'zod'

const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100).trim(),
})

export async function POST(req: Request) {
  const body = await req.json()
  const result = CreateUserSchema.safeParse(body)
  if (!result.success) {
    return Response.json({ error: result.error }, { status: 400 })
  }
  // Use result.data...
}
```

- FAIL if request bodies/params/query reach business logic without shape validation (schema
  parse, explicit field checks) on a new or changed endpoint.
- FAIL if numeric/ID params are used unparsed where type confusion changes behavior.
- Client-side checks don't count; only what the server enforces.

## Mass Assignment (`mass-assignment`)

- FAIL when a request-shaped object is spread or `Object.assign`ed into a create/update call or
  model constructor without an allowlist: `db.user.update({ data: { ...req.body } })` lets a
  caller set `role`, `isAdmin`, `ownerId`, or any other column the schema exposes.
- PASS when the write picks named fields (`{ name: input.name, email: input.email }`) or the
  spread source is a schema-parse result that strips unknown keys (`.strict()` / `pick`).

## SQL Injection (`sql-injection`)

- FAIL if query text is built by concatenation/interpolation of request data — `` `WHERE id =
  ${id}` ``, `"... '" + name + "'"` — including in `raw`/`execute` escape hatches.
- PASS parameterized/bound queries (`$1`, `?`, named binds) and tagged `sql``` templates whose
  library binds interpolations as parameters.

## Command Injection (`command-injection`)

- FAIL if `exec`/`execSync` (or `spawn` with `shell: true`) receives a string containing any
  request-derived value — shell metacharacters in that value execute.
- PASS `execFile`/`spawn` with a fixed binary and an argv array, even when arguments are dynamic.
- Also FAIL a fixed-string `exec` that embeds an unvalidated env/config value a request can
  influence.

## Path Traversal (`path-traversal`)

- FAIL when a request-derived segment reaches a filesystem call (`sendFile`, `readFile`,
  `createReadStream`, `unlink`, …) without containment: resolve the joined path and verify it is
  still under the intended base directory.
- `path.join(base, req.params.name)` alone is NOT containment — `..` segments walk out of base.
  The check must be on the *resolved* path (`resolved.startsWith(baseDir + sep)`) or an
  allowlist of names.

## SSRF (`ssrf-prevention`)

- FAIL when an outbound request URL (`fetch`, `axios`, `got`) is built from request data with no
  validation — the server can be steered at internal services or cloud metadata endpoints.
- PASS when the host is pinned (only path/query vary), or the URL is checked against a
  scheme+host allowlist before the call.
- Redirect-following on a user-supplied URL needs the same scrutiny as the URL itself.

## XXE (`xxe-prevention`)

- FAIL if an XML/YAML parser is configured (or defaults) to resolve external entities or expand
  entity definitions on user-supplied documents. Look for parser options enabling entities;
  require them disabled.

## Output Security (`output-security`, `security-headers`, `open-redirect`)

```typescript
const headers = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'",
  'Cache-Control': 'no-store'
}
```

- FAIL responses that include credentials, tokens, internal keys, or whole DB rows where a
  field-set was intended.
- FAIL removed or weakened security headers; FAIL new fingerprinting headers (`X-Powered-By`).
- FAIL wrong status semantics that mask auth failures (200 with an error body where 401/403
  drive client behavior).
- `open-redirect`: FAIL a `redirect()` whose target comes from request data without an exact
  allowlist or relative-path-only constraint — `res.redirect(req.query.next)` is a phishing
  primitive.

## Error Handling (`error-handling`)

- FAIL stack traces, driver error strings, or internal paths serialized into responses. Map
  internal errors to generic client messages; keep detail in server logs.

## Processing (`processing-security`)

- FAIL debug flags or verbose-diagnostics switches enabled on production paths.
- FAIL upload handlers with no size/type constraint.
- FAIL sequential personal identifiers exposed in new resource URLs where the repo elsewhere
  uses opaque IDs.

## Monitoring (`logging-security`)

- FAIL log statements that write credentials, tokens, session IDs, or raw request bodies that
  can contain them.
- Security-relevant events (auth failure, permission denial) on changed paths should still be
  logged after the change — FAIL if the change silently drops them.

## Provenance

Rule text above is written for this repo. Topic coverage was diffed against these sources —
topics only, no source text is reproduced:

- **roadmap.sh API Security best practices** (coverage checklist only; content license is
  personal-use): sections Authentication, JWT, OAuth, Access Control, Input, Processing, Output,
  Monitoring → items `auth-mechanism`, `jwt-security`, `oauth-security`, `endpoint-auth`,
  `rate-limiting`, `input-validation`, `sql-injection`, `xxe-prevention`, `output-security`,
  `security-headers`, `error-handling`, `processing-security`, `logging-security`.
- **OWASP ASVS v5.0** (CC-BY-SA) chapters V1 Encoding/Sanitization, V2 Validation, V4 API,
  V8 Authorization → items `mass-assignment`, `command-injection`, `path-traversal`,
  `ssrf-prevention`, `object-level-authz`, `open-redirect`.

Rejected topics (not judgeable from a staged diff by a read-only reviewer): IP-allowlisting of
private APIs, API gateways, CDN-for-uploads, non-executable stacks, IDS/IPS, CI/CD process
items (SAST, dependency audits, rollback drills), centralized logging infrastructure.
