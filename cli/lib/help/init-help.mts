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
                         --no-structure --no-guards --no-fallow.
  --guards <a,b,…>       Only these guards (subset of size,fanout,dup,clone,decisions,
                         qavis-advisory,review,sentry; review + sentry are opt-in, off by default).
  --review               Enable \`devkit review\` with an explicit local gate profile.
  --no-review            Disable \`devkit review\` for this installation.
  --review-guards <a,b>  Review-mode guard allowlist (defaults to the installed guard selection).
  --review-decisions-dir <path>  Local decision store (default: docs/decisions).
  --no-claude/--no-cursor  Sync skills/agents/hooks to ONE agent surface only (default both).
  --baselines-only       Re-derive ONLY the structure + import-wall baselines (rare; after a
                         structure-RULE change). Package-mode structure stacks only.
  --fallow               Also install the optional fallow code-health layer (off by default).
  --search-code          Opt this repo in to the semantic search index (off by default).
  --standalone           NO-PACKAGE mode: vendor configs + a fail-open hook calling GLOBAL guard-*
                         bins; add nothing to package.json. Requires \`bun add -g\` devkit.
  --overlay              LOCAL-ONLY mode for a repo you can't modify: git-ignored, chains to the
                         repo's own hook, configs EXTEND the repo's. Requires global devkit.
  --scan-root <a,b,…>    Override guard.config.json scanRoots up front (set BEFORE the freezes).
  --remove-deselected    With --yes: remove an installed-but-now-deselected component (opt-in).

See docs/glossary.md for package/standalone/overlay, gates, ratchets, baselines, scanRoot.`;
