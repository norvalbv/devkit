## 2026-04-10 — A password change revokes every existing session immediately

**Ruling:** Changing an account's password, or triggering an explicit "sign out everywhere" action, immediately revokes every outstanding session token for that account server-side. Sessions are checked against a revocation list on every request rather than being decoded and trusted on their own; a token that passes signature validation but appears on the revocation list is rejected.
**Why / target:** During an account takeover, the victim changed their password as the first remediation step, but the attacker's existing session kept working for another six hours until it happened to expire naturally, during which the attacker kept modifying data. The password change gave a false sense that access had been cut off. The target is that remediation actions take effect immediately, not on whatever schedule the token would have expired anyway.
**Source:** seed

- 2026-04-27 — The revocation-list lookup added a small but measurable latency cost to every authenticated request, which is the price knowingly being paid for the guarantee above; it has not been rolled back or scoped down.
