Critique this pre-implementation plan.

PROBLEM: Settings → Skills shows a long, noisy list — the same skill appears multiple times, once per tool dir (~/.claude/skills, ~/.cursor/skills, ~/.frink/skills). Users complain about duplicates.

PROPOSED SOLUTION: In the Settings aggregation (`aggregatedScan`), exclude copies that carry Frink's `.frink-projected` mirror marker, and dedup by name in the renderer so each skill shows once. Add a "Synced across tools" badge to the one surviving row.

RECORDED TARGET (docs/decisions/provider-config-canonical-home, Target #2): "Frink owns canonical config in `~/.frink`; the per-tool dirs (`.claude`/`.cursor`/`.agents`) are DERIVED projections of the canonical asset — ONE source of truth per asset, projected/translated to each tool, kept in sync." 

CURRENT REALITY the plan does not mention: user skills have NO enforced canonical home. A skill authored independently in `~/.claude/skills/foo` AND `~/.cursor/skills/foo` stays as two unmarked peers that NEVER converge — the projection clobber-guard refuses to overwrite either (to protect edits). So the "duplicates" are genuinely-unsynced independent copies, not Frink's own mirrors. Editing one does not update the other.
