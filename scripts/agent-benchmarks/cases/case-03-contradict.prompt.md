Critique this pre-implementation plan.

PROBLEM: Agents sometimes need to read `.env` files for project context, but the permission system always blocks them. Users find this annoying.

PROPOSED SOLUTION: Remove `.env` and `.env.*` from the permission system's system deny list (`src/main/lib/permissions/.../system-denied-paths`) so an agent can read them whenever the user has granted a broad Read rule.

RECORDED TARGET (docs/decisions, permissions): "The system deny list — `.env`, `.env.*`, `.ssh/`, `.aws/`, `*.pem`, `*.key`, credentials.json — is NON-NEGOTIABLE and runs LAST, blocking these paths regardless of any user allow rule. It is the final guarantee against credential exfiltration by a compromised or over-granted agent."
