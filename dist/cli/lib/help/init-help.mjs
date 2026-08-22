export const INIT_HELP = `devkit init — wire this repo onto @norvalbv/devkit (interactive on a TTY, idempotent).

Usage:
  devkit init [options]

  --stack <x>            electron | react-app | next | node-service | generic
                         (default: auto-detect; structure preset ships for electron + react-app).
  --yes                  Non-interactive: install all recommended defaults (no prompts).
  --dry-run              Print every file action; write nothing.
  --force                Overwrite existing devkit-managed files, AND adopt/overwrite a consumer's
                         own same-named skill/agent/hook collisions (default: preserve them).
  --no-<component>       Skip a component: --no-biome --no-tsconfig --no-skills --no-husky
                         --no-structure --no-guards --no-fallow --no-adhd --no-oxc --no-anti-slop.
  --no-<guard>           Turn off one guard without restating the full guard list; for example
                         --no-comments. Use --no-review-gate for the review guard.
  --guards <a,b,…>       Only these guards (subset of size,fanout,dup,clone,comments,decisions,
                         qavis-advisory,review,sentry,coverage; review/sentry/coverage are opt-in).
  --review               Enable \`devkit review\` with an explicit local gate profile.
  --no-review            Disable \`devkit review\` for this installation.
  --review-guards <a,b>  With --review: guard allowlist (default: installed guard selection).
  --review-decisions-dir <path>  With --review: local decision store (default: docs/decisions).
  --no-claude/--no-cursor  Sync skills/agents/hooks to ONE agent surface only (default both).
  --baselines-only       Re-derive ONLY the structure + import-wall baselines (rare; after a
                         structure-RULE change). Package-mode structure stacks only.
  --fallow               Also install the optional fallow code-health layer (off by default).
  --oxc                  Activate Devkit's pinned Oxlint/Oxfmt runtime and repository configs
                         (off by default; package/standalone only). Use \`devkit oxc lint|fmt\`.
  --anti-slop            Install 15 vendored anti-slop rules and its explicit shrink-only baseline
                         workflow (implies --oxc; package/standalone only; baseline creation is manual).
  --search-code          Opt this repo in to the semantic search index (off by default).
  --adhd                 Sync the i-have-adhd SKILL — an ADHD-friendly output style — and
                         keep it ALWAYS ON via a SessionStart hook (off by default;
                         needs --skills). Turn it off for this session by saying "stop
                         adhd mode", durably with .devkit/adhd-off, or drop it with
                         --no-adhd (which also removes it on a re-run).
  --prior-art-gate       Install the deny-once step-0 ordering HOOK: the first ExitPlanMode
                         or feature-critique dispatch in a session with no prior-art run is
                         denied once with the skip predicate; a call whose plan/prompt carries
                         a \`Prior-art:\` line passes untaxed, and retries pass (off by default).
                         Drop it with --no-prior-art-gate (also removes it on a re-run).
  --standalone           NO-PACKAGE mode: vendor configs + a fail-open hook calling GLOBAL guard-*
                         bins; add nothing to package.json. Requires \`bun add -g\` devkit.
  --overlay              LOCAL-ONLY mode for a repo you can't modify: git-ignored, chains to the
                         repo's own hook, configs EXTEND the repo's. Requires global devkit.
  --scan-root <a,b,…>    Override guard.config.json scanRoots up front (set BEFORE the freezes).
  --remove-deselected    With --yes: remove an installed-but-now-deselected component (opt-in).

See docs/glossary.md for package/standalone/overlay, gates, ratchets, baselines, scanRoot.`;
