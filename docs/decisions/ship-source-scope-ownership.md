---
slug: ship-source-scope-ownership
created: 2026-08-31
---

# ship-source-scope-ownership

## Target · 2026-08-31 — Ship source-scope ownership

**Context:** Explicit paths protect a shared dirty checkout, but a committed multi-commit branch forced operators to independently guess a remote base and paste every changed path. Story #2352 captured an omitted path on resume and a wrong-base expansion from 17 paths to roughly 1,512.
**Ruling:** Explicit paths remain the default for dirty-tree shipping. The opt-in --from-branch mode requires an explicit remote base, pins the base and current HEAD commits, proves ancestry, derives root-literal committed path membership, refuses in-scope overlays and unsupported path representations, and records branch source mode plus frozen membership for resume.
**Consequences:**
- Positive: Committed branch work can be shipped completely without manual path-list transcription while unrelated shared-checkout dirt remains untouched and ordinary dirty-file ownership is never guessed.
- Negative: The source branch must be committed and based on the current remote target; gitlinks and non-UTF-8 pathnames are refused, resume state is versioned, and the extra provenance checks add preflight work.
**Vision-fit:** n/a — internal tooling reliability
**Rejected:** (a) Empty paths auto-detect dirty files — rejected because ownership is unknowable in a shared checkout. (b) Keep requiring external git diff path lists — rejected because base drift and transcription omissions recreate the incident. (c) Re-expand all paths on resume — rejected because changing membership prevents convergence and can absorb unrelated later commits.
**Scope:** cli/commands/ship.mts,cli/lib/ship/ship-branch.sh,cli/lib/ship/ship-intent.mts,cli/lib/ship/ship-intent-event.mts,cli/lib/ship/reship.sh,skills/using-devkit/SKILL.md
**Source:** manual
- 2026-08-31 — **Scope:** cli/commands/ship.mts,cli/lib/ship/ship-branch.sh,cli/lib/ship/ship-intent.mts,cli/lib/ship/ship-intent-event.mts,cli/lib/ship/reship.sh,cli/lib/ship/reconcile-manifest-write.mts,cli/lib/ship/assert-staged-set.sh,skills/using-devkit/SKILL.md,skills/commit-gates/SKILL.md — Implementation review moved concrete literal-path classification into the reconcile writer and made the frozen branch-resume contract explicit in both operator skills.
- 2026-08-31 — **Scope:** cli/commands/ship.mts,cli/lib/ship/ship-branch.sh,cli/lib/ship/ship-intent.mts,cli/lib/ship/ship-intent-codec.mts,cli/lib/ship/ship-intent-event.mts,cli/lib/ship/reship.sh,cli/lib/ship/reconcile-manifest-write.mts,cli/lib/ship/assert-staged-set.sh,skills/using-devkit/SKILL.md,skills/commit-gates/SKILL.md — Ship size ceilings moved the binary-safe branch path codec into its own adjacent module without changing the source-ownership ruling.
- 2026-09-01 — Branch-source membership binds via an update-ref --stdin 'create' transaction instead of a hard-coded 40-zero old OID (sc-2475): the zero literal was the SHA-1 null OID and git validates it against the repository's own hash width, so every branch-source bind failed outright under --object-format=sha256. 'create' is the object-format-agnostic spelling of the same create-only guard, so frozen membership keeps its 'a second bind is refused' property with no width to derive; it must never be relaxed to 'update'. Converges with the hash-width invariant devkit already maintains at cli/lib/husky/pre-push-validation.sh (is_zero_oid, 40 vs 64), gate-engine/deterministic/run.mts (dual-width oid regex) and the sha1/sha256 arms in cli/__tests__/reship.test.mts. Scope of the claim: devkit's ship-intent path no longer encodes a repository hash width — NOT end-to-end SHA-256 ship support, since --from-branch still needs a remote base and a gh PR and GitHub does not host SHA-256 repositories.
