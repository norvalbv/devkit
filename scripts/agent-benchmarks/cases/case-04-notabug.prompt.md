Critique this pre-implementation plan.

PROBLEM: When I switch a project from a Claude account to a Cursor account, my custom agent's exact tool restriction (`tools: Read, Grep`) stops being enforced — it just becomes coarse "read-only". This is a bug; the agent should keep its precise allowlist on Cursor.

PROPOSED SOLUTION: Make Cursor enforce the exact per-tool allowlist (deny anything not in `tools`) the same way Claude's gate does, so restrictions are identical across tools.

RECORDED TARGET (provider-config-canonical-home, ENFORCE-rules axis): "Enforce sub-agent tool-allowlists at each tool's permission gate. claude-code = `enforce` (a hard veto at the gate). cursor = `advisory` — Cursor exposes NO per-tool host veto, only a coarse `readonly` switch, so a fine-grained allowlist DEGRADES to the closest thing Cursor can enforce (read-only). This relaxation is the deliberate, documented behaviour ('limits apply in full where enforceable, relax to the closest equivalent elsewhere'), not a defect."
