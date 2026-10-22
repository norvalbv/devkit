---
slug: move-treats-nested-repositories-as-opaque
created: 2026-10-19
---

# move-treats-nested-repositories-as-opaque

## Target · 2026-10-19 — devkit move never edits a nested repository and refuses to leave one dangling

**Context:** devkit move skipped every file under a nested Git repository (a directory holding a .git dir or file: a submodule or vendored clone) so it would never write through another repository's ownership boundary. Those files still sat in the outer tsconfig program, so a nested file importing a moved outer path kept the old specifier, got no post-move resolution check, and move printed success with exit 0 over a tree outer tsc rejects. Severity medium: rare layouts, but a silent false success from the command that exists to make moves safe.
**Ruling:** Nested repositories stay opaque: devkit move never writes a file under one. Before anything moves (dry run included), every outer-tsconfig file under a nested repository is resolved with the outer project's own compiler options against the pre-move tree; each specifier that reaches a target now and will not reach it after the move is listed with the nested repository and the spelling it needs, and move exits 1. --allow-nested-dangling moves anyway, printing the same list as a warning and leaving the nested files byte-identical. A move whose source or destination sits inside a nested repository is refused (moving the nested repository's root as a whole stays allowed). Nested files outside the outer tsconfig include are not scanned, like any file outer tsc never type-checks. The nested repository's own tsconfig is never read.
**Consequences:**
- Positive: A move never reports success over imports it knowingly broke, and never creates edits the outer commit cannot own; the caller learns the exact files and replacement spellings before any mutation.
- Negative: A legitimate move whose only casualties are nested-repository imports now needs an explicit flag, and the caller still fixes those imports by hand in the nested repository. Resolution with the outer options can disagree with how the nested repository resolves itself.
**Vision-fit:** n/a — internal tooling
**Researched:** TypeScript getEditsForFileRename, VS Code update-imports-on-move, Nx move generator, ts-morph: none detect or refuse cross-repository edits; they only see files in their open project set (microsoft/TypeScript#25867).
**Rejected:** Rewriting nested files in place: the outer commit cannot own a submodule's content and no tool offers precedent. Moving first and reporting dangles afterwards (the post-move check's shape): a nested repository cannot be fixed before the move, so the caller needs the list before mutation to decide. Filtering to references whose target is in another repository: a nested file importing its own sibling through the outer alias also breaks when the nested repository moves.
**Anchored-bet:** [BET]
**Revisit-when:** A consumer needs devkit move to coordinate edits across a submodule boundary.
**Scope:** cli/commands/move.mts,cli/lib/move/**
**Source:** shortcut · sc-2440
