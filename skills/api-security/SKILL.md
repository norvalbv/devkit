---
name: API Security
description: Security best practices for APIs and backend endpoints. Use when creating API routes, implementing authentication/authorization, handling JWT tokens, validating input, configuring OAuth, or securing API responses. Covers authentication, JWT, access control, input validation, output security, and monitoring.
---

# API Security

## Review Script

```bash
SCRIPT=".claude/skills/api-security/scripts/checklist.mjs"

node $SCRIPT generate     # Create checklist from staged backend files
node $SCRIPT status       # Show progress
node $SCRIPT check-item <name> --pass   # Mark item passed
node $SCRIPT check-item <name> --fail "reason"  # Mark item failed
node $SCRIPT finalize     # Verify & approve
node $SCRIPT cleanup      # Remove checklist
```

The backend roots the script scans come from `guard.config.json` `review.backendRoots`
(default `["src"]`) — they are not hardcoded.

## Authentication

- Avoid 'Basic Authentication', use standard (e.g. JWT, OAuth 2.0)
- Do not reinvent the wheel in authentication mechanisms
- Use 'Max Retry' and jail features in login
- Use encryption on all sensitive data

```typescript
// Rate limit login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts'
})
```

## JWT Best Practices

```typescript
// Token configuration
const token = jwt.sign(payload, process.env.JWT_SECRET, {
  expiresIn: '15m',  // Short TTL
  algorithm: 'HS256' // Don't extract from header
})

// Validation
const decoded = jwt.verify(token, process.env.JWT_SECRET, {
  algorithms: ['HS256'] // Explicit algorithm
})
```

**Rules:**
- Use good JWT Secret to make brute-force attacks difficult
- Do not extract the algorithm from the header, use backend
- Make token expiration (TTL, RTTL) as short as possible
- Avoid storing sensitive data in JWT payload
- Keep the payload small to reduce the size of the JWT

## Access Control

- Limit requests (throttling) to avoid DDoS/brute force
- Use HTTPS on server side and secure ciphers
- Use HSTS header with SSL to avoid SSL strip attacks
- Turn off directory listings
- Private APIs should only be accessible from safe-listed IPs

```typescript
// Authorization check
export async function handler(req: Request) {
  const user = await getUser(req)

  if (!user || user.role !== 'admin') {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }
  // Proceed...
}
```

## OAuth

- Always validate `redirect_uri` on server-side
- Avoid `response_type=token` and try to exchange for code
- Use state parameter to prevent CSRF attacks
- Have default scope, and validate scope for each application

## Input Validation

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

**Rules:**
- Validate all input with schemas
- Use parameterized queries (never concatenate SQL)
- Disable entity parsing if parsing XML to avoid XXE attacks
- Disable entity expansion if using XML, YAML, or similar
- Use UUIDs over auto-increment IDs in URLs

## Output Security

**Required headers:**

```typescript
const headers = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'",
  'Cache-Control': 'no-store'
}
```

**Rules:**
- Send X-Content-Type-Options: nosniff header
- Send X-Frame-Options: deny header
- Send Content-Security-Policy: default-src 'none' header
- Remove fingerprinting headers (e.g. x-powered-by)
- Force content-type for your response
- Avoid returning sensitive data (credentials, tokens, etc)
- Return proper response codes as per the operation

## Processing

- Check if all endpoints are protected behind authentication
- Avoid user's personal ID in resource URLs (e.g., users/242/orders)
- Prefer using UUID over auto-increment IDs
- Disable entity parsing if parsing XML to avoid XXE attacks
- Disable entity expansion if using XML, YAML, or similar
- Use a CDN for file uploads
- Avoid HTTP blocking when handling large amounts of data
- Make sure debug mode is off in production
- Use non-executable stacks when available

## Monitoring

- Use centralized logins for all services and components
- Use agents to monitor all requests, responses, and errors
- Use alerts for SMS, Slack, Email, Kibana, CloudWatch, etc
- Ensure you aren't logging any sensitive data
- Use an IDS and/or IPS system to monitor everything

## CI/CD Security

- Audit your design and implementation with unit/integration tests
- Use a code review process and disregard self-approval
- Continuously run security analysis on your code
- Check your dependencies for known vulnerabilities
- Design a rollback solution for deployments
