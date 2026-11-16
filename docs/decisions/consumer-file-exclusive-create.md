---
slug: consumer-file-exclusive-create
created: 2026-10-08
---

# consumer-file-exclusive-create

## Target · 2026-10-08 — devkit creates a consumer file exclusively and never replaces one wholesale unattended

**Context:** init, upgrade, overlay and standalone write whole files into a repository devkit does not own (guard.config.json, tsconfig.json, biome and eslint overlays, search-code.config.json). The shared writeIfAbsent checked existsSync and then wrote, so a file the consumer or another tool created inside that window was overwritten. With no written rule, agents changing these writers rediscovered exclusive create through repeated reviewer race findings: one eslint-overlay change took 6 extra ship attempts and three intermediate designs.
**Ruling:** A missing consumer file is created exclusively through writeIfAbsent (cli/lib/fs-helpers.mts), which writes with flag 'wx' and reports EEXIST as 'exists'; a writer never pairs existsSync with writeFileSync to create. An existing consumer file is never replaced wholesale unattended: it is left alone, a stale devkit-written one is reported with a remedy (delete it and re-run), and only --force replaces it. A live leaf symlink counts as existing; only a dangling one is replaced. Managed line or key merges into a shared file (.gitignore lines, guard.config.json patches) are outside this ruling.
**Consequences:**
- Positive: A consumer's own file, or one written concurrently by an editor or another tool, survives every devkit install and upgrade, and the next agent changing a consumer-file writer reaches for the existing primitive instead of re-deriving it under review.
- Negative: A stale devkit-written file is not refreshed automatically; the consumer must delete it or pass --force, so some upgrades print a remedy instead of fixing things silently. --force still truncates in place rather than writing a temp file and renaming.
**Vision-fit:** n/a — internal tooling
**Researched:** open(2) O_CREAT|O_EXCL semantics (fails EEXIST on any existing path, symlinks not followed); Node fs file system flags ('wx'); npm write-file-atomic README
**Rejected:** existsSync pre-check then write: leaves the race window. write-file-atomic: renames over the target, so it offers no exclusive create. An unattended refresh of a stale overlay: clobbers the consumer's edits.
**Revisit-when:** devkit takes ownership of a consumer file it must keep current on every upgrade, or Node exposes a compare-and-swap file primitive.
**Scope:** cli/lib/fs-helpers.mts,cli/lib/install/**,cli/lib/overlay*.mts,cli/lib/standalone.mts,cli/commands/init.mts,cli/commands/sync/**
**Source:** shortcut · sc-4372
