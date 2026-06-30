---
slug: non-devkit-asset-collision-preserve
created: 2026-06-30
---

# non-devkit-asset-collision-preserve

## Target · 2026-06-30 — A consumer's own same-named skill/agent/hook is PRESERVED on sync, never silently clobbered

**Context:** the sync step (syncSkills/syncAgents/syncHookScripts) hardcoded `writeIfAbsent(dest, content, { force: true })` on the premise "devkit-owns these, always overwrite so a tag bump propagates." That premise is false for a file devkit never installed: a consumer who authored their OWN skill/agent/hook under a name devkit also bundles (e.g. their own `brainstorming` skill) had it silently overwritten on `devkit init` / `sync-skills` / `sync-agents`. The only guard was overlay's `skipTracked` (git-tracked only, overlay-only) — package/standalone mode and untracked user assets were unprotected. Silent data loss of user-authored content.
**Ruling:** a sync treats a name as the CONSUMER's (preserve, never clobber) iff it (1) exists under a target surface, (2) is NOT recorded in devkit's prior manifest, AND (3) its on-disk bytes DIVERGE from the bundle. Default everywhere is PRESERVE. `devkit init` interactive offers a per-asset `multiselect` (keyed `${kind}:${name}`) to adopt specific collisions; `--force` (package/standalone/overlay) and the standalone `sync-skills`/`sync-agents --force` adopt all. A preserved name is left off the manifest (devkit never claims a file it didn't write). devkit's OWN copies — manifest-owned, or unmanifested-but-byte-identical to the bundle — keep overwriting, so version-bump propagation and self-dogfood are intact. `clean`'s no-manifest fallback gains the same content/tracked guard so it never deletes a preserved untracked user asset.
**Consequences:**
- Positive: an install can no longer destroy a consumer's same-named asset; the picker/`--force` give explicit, per-asset control; manifest stays an honest record of devkit-written files only.
- Negative: a genuinely-stale unmanifested devkit copy (pre-manifest / `npx skills add` install whose bytes differ from the current bundle) is preserved-not-updated until `--force` — surfaced loudly (a non-interactive log lists them + the `--force` hint), not silently frozen. Ownership inference now lives at two sites (sync's `findConflicts` and clean's fallback guard) rather than one.
**Vision-fit:** n/a — internal tooling; "ship the generator, never the data" extended from settings.json merges to the synced asset files themselves.
**Researched:** feature-critique pass (caught the clean-fallback data-loss interaction + the pre-manifest false-positive); feature-completeness-reviewer (overlay `--force` threading, hook-collision coverage). Provenance signal reuses the existing per-file sha manifests.
**Rejected:** (a) keep `force: true` always — the bug; (b) manifest-absence alone as the user-vs-devkit signal — REJECTED: misclassifies pre-manifest devkit copies as user files and freezes them; added the byte-match-against-bundle condition so identical copies adopt cleanly; (c) a single bare-`name` override key — REJECTED for `${kind}:${name}` so a skill dir and an agent file can never alias; (d) consolidating the two inference sites via clean-time manifest backfill — DEFERRED: a larger refactor beyond this fix's scope, current two-site logic is correct.
**Anchored-bet:** [TODO]
**Scope:** cli/commands/sync-skills.mjs,cli/commands/sync-agents.mjs,cli/lib/install/install-hooks.mjs,cli/lib/sync-manifest.mjs,cli/commands/init.mjs,cli/lib/overlay.mjs
**Source:** collab · fix/preserve-non-devkit-assets
