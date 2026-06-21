# Structure-Governance: How Frink Does It, Why Devkit's Generalization Breaks, and What the Science Says About Auto-Deriving Directory Structure

> Research report commissioned for the structure-engine generalization (Piece 2). Captured verbatim
> as the durable rationale behind the `structure` config schema, the generic walker, and the DEFERRED
> advisory suggester (`05-suggester-DEFERRED.md`). Source file paths in Part 5 are frink-relative and
> reflect the repo state at research time.

## Part 1 — How structure-governance ACTUALLY works in frink

Frink's structure governance is a **closed-world path/folder validator** built on `eslint-plugin-project-structure`, where **lint is the law and the skill/docs are only the write-time guide** (`.claude/skills/structure-governance/SKILL.md`). Biome owns code/style lint; the plugin owns *placement*. There are three coupled mechanisms — **walls**, **domains**, and the **baseline ratchet** — wired in `eslint.config.mjs`, `eslint/domains.mjs`, and `eslint/baselines/*`.

### 1.1 The two rule families (the "walls")

**(A) `folder-structure` — six per-tree instances.** Each source tree gets its own `createFolderStructure(...)` call, scoped by a flat-config `files` glob and a `structureRoot`. Patterns are matched **relative to `structureRoot`** (e.g. `components/X.tsx`, not `src/renderer/components/X.tsx`). The six trees and roots (`eslint.config.mjs`):

| instance | structureRoot | files glob |
|---|---|---|
| `folderStructure` | `src/renderer` | `src/renderer/**/*.{ts,tsx,css}` |
| `mainStructure` | `src/main` | `src/main/**/*.ts` |
| `sharedStructure` | `src/shared` | `src/shared/**/*.ts` |
| `preloadStructure` | `src/preload` | `src/preload/**/*.ts` |
| `socketStructure` | `socket-server/src` | `socket-server/src/**/*.ts` |
| `vercelStructure` | `vercel-serverless` | `vercel-serverless/{api,lib}/**/*.ts` |

Re-implementable mechanics:
- **Named tokens.** A shared `regex` object defines tokens (`PascalCase: '^[A-Z][a-zA-Z0-9]*$'`, `kebab_ts: '^[a-z][a-z0-9-]*\.ts$'`, …) passed per-instance as `regexParameters` and referenced in rules via `{token}` syntax (`{ name: '{PascalCase}' }`).
- **Named recursive rules.** Reusable rules live in a `rules:` map and are referenced by `{ ruleId: '<name>' }`. **Recursion** = a rule's `children` ending in a self-reference (`{ ruleId: 'componentFolder' }`), so nested PascalCase folders auto-conform.
- **Required barrels.** `enforceExistence: 'index.tsx'` mandates an entry file (renderer components; main domain folders use `enforceExistence: 'index.ts'`).

**(B) `independent-modules` — one import-wall instance.** A single `createIndependentModules(...)` builds `importWalls`, applied to `src/renderer/**` + `src/shared/**` (tests are wall-free). Key design (`eslint.config.mjs`):
- **Explicit `pathAliases`** (`{ baseUrl: '.', paths: { '@/*': ['src/renderer/*'] } }`) — given literally, *not* via `tsconfigPath`, so imports are path-resolved to root-relative paths before matching (a renderer-local folder named `main` can't false-positive).
- **`reusableImportPatterns.renderer_base`** defines the legal import surface of any renderer file. OR-semantics across entries; a `string[]` entry is AND'd via micromatch (this is how the `!`-negations seal frozen dirs and feature internals).
- **`modules`** is the wall list, **first-match-wins**, ordered `[...importWallExempt, ...rendererImportWallBaseline, <walls>]`. A wall = `{ name, pattern, allowImportsFrom, errorMessage }`. The renderer wall bans `src/main` (even `import type`), deep cross-feature paths, and frozen dirs; `shared` may import only `src/shared/**`.
- **Scan mode.** `IMPORT_WALL_SCAN = process.env.FRINK_IMPORTS_BASELINE_SCAN === '1'` drops grandfather entries and flips `debugMode` so error text carries the import path, used by the baseline generator.

The skill enumerates these as **six walls** (`SKILL.md`, `references/walls.md`): (1) placement, (2) domain vocabulary, (3) file size, (4) folder fan-out, (5) frozen legacy dirs, (6) import walls. Crucially, the walls split across **two enforcement mechanisms**: eslint (placement, imports, the size *cap*) and **husky-only ratchets** (the size-disable *count gate* and the fan-out *count gate*) that fire in `.husky/pre-commit` and are NOT in `bun run lint`.

### 1.2 Domains — the closed vocabulary

`eslint/domains.mjs` exports plain string arrays — the **closed domain vocabulary**: `RENDERER_LIB_DOMAINS`, `MAIN_LIB_DOMAINS`, `SOCKET_LIB_DOMAINS`, `VERCEL_LIB_DOMAINS`, plus `MAIN_ROOT_FOLDERS`. `eslint.config.mjs` compiles each into one anchored alternation param — `lib_domain: \`^(${RENDERER_LIB_DOMAINS.join('|')})$\`` — and gates the **first-level child of `lib/`**: `lib/` allows only `index.ts` + a folder matching `{lib_domain}`. Therefore: a loose file at `lib/` root errors (folder-only), and any unregistered first-level `lib/` folder errors. This is what stops agents inventing `lib/misc/`, `lib/helpers/`. Adding a domain = **one kebab-case append** named for the concern it owns.

**Frozen legacy dirs** use a match-nothing param: `frozen_dir_migrate_to_lib: '^$'` as the only child of `contexts/constants/types/utils`, so every file in them errors (grandfathered via baseline) — a one-way door forcing migration into `lib/<domain>`.

**No-drift guarantee:** both `eslint.config.mjs` and `scripts/generate-eslint-baseline.mjs` import the *same* `domains.mjs`, so rule and generator can never disagree (enforced by `generate-eslint-baseline.test.mjs`).

### 1.3 The baseline ratchet (grandfather-and-shrink)

This is what makes the gate adoptable in a brownfield repo: ship at `error`, freeze current violators into a generated baseline consumed as the rule's ignore-set, block only NEW violations, and shrink the baseline as files are fixed (`eslint/baselines/README.md`, `docs/developer-docs/structure-governance.md` §1).

**Two baseline kinds:**
- **DEBT (generated, never hand-edit):** `renderer.mjs`/`main.mjs`/`shared.mjs`/`preload.mjs`/`socket.mjs`/`vercel.mjs` (folder-structure), `imports.mjs` (import walls), `size.json`, `fanout.json`. Target: shrink to `[]`/0.
- **EXEMPT (`exempt.mjs`, the only hand-edited file):** permanent architectural exceptions, one reason per entry, **never shrinks** (its one real entry: `lib/trpc.ts` importing `AppRouter` — tRPC inference can't move to `src/shared`).

**Two on-disk formats:**
- **Folder-structure baselines** = a flat array of **tree-relative path strings** (`export const socketStructureBaseline = ["auth.ts", "lib/credential-crypto.ts", …]`).
- **Import-wall baseline** (`imports.mjs`) = an array of **per-file objects** that widen *only* that file's allowed imports with the **minimal** extra allowances it already uses (`{ name, pattern, allowImportsFrom: ['{renderer_base}', 'src/renderer/features/agents/**', …] }`). NOT a blanket exemption — any *new* forbidden import still fails.

**Generation / regeneration:**
```
bun lint:structure:baseline            # 6 structure baselines + imports.mjs
node scripts/size-disable-ratchet.mjs   freeze   # size.json
node scripts/folder-fanout-ratchet.mjs  freeze   # fanout.json
```
`generate-eslint-baseline.mjs` walks each tree (it reproduces each tree's rule by hand because the folder-structure rule dedups by errorMessage, so a manual walker is needed to capture *every* violator); `generate-import-wall-baseline.mjs` runs eslint in scan mode. **Counts are never hard-coded** — they come from the generator at freeze time (`directory-structure.md` §5, §9).

**Why you can't game it:**
1. **Self-healing / shrink-only:** regen re-walks and re-emits, so hand-deleting a debt entry does nothing — it returns if the file still violates. The only honest removal is to *fix the file* ("a to-do list that empties itself").
2. **Monotonic count gate:** `size.json`/`fanout.json` have a `gate` subcommand (pre-commit) that exits 1 if the count **grew** (split, don't disable), reminds to re-freeze if it **shrank**, and **fails open (exit 2)** if the baseline is missing so a fresh checkout never wedges.

The size wall additionally has a **shrink-on-touch** rule: a staged file in `size.json` that's touched and still over cap fails — turning "self-heal on touch" from convention into enforcement (`directory-structure.md` §5).

**The one rule that protects everything: "Regenerate ≠ silence."** Regen only after a deliberate audit (a domain rename, a real migration) — never to make a new violation disappear.

---

## Part 2 — Why devkit's generalization is broken

Devkit copied frink's generators and presets, but the abstraction is incomplete: **the generator IS frink's tree shapes transcribed into code**, so it only serves frink-shaped repos.

**What is frink-hardcoded (cannot serve an arbitrary repo):**

1. **The six trees are baked in three coupled places that must agree** (`cli/lib/generate/generate-structure-baseline.mjs`): `DEFAULT_ROOTS` (renderer/main/shared/preload/socket/vercel) and `TREES`, both `Object.freeze`d; the electron `eslint.config.mjs`; and the 5-export `domains.mjs` shape that `loadDomains()` reads by exact name. These are Electron-process + frink-backend names, not a generic concept.

2. **Per-tree walkers are hand-written code, not data.** `makeRendererWalker`/`makeMainWalker`/… each reproduce one tree's folder-structure rule by hand. Adding a 7th tree (or governing devkit's own `cli/gate-engine`) requires *writing a new walker* — you cannot describe a new topology in config.

3. **Hardcoded frink taxonomy:** `ALLOWED_TOP` (`App.tsx`/`main.tsx`/`wdyr.ts`/`login.html`), `FROZEN_DIRS` (`contexts/constants/types/utils`), `IGNORED_DIRS` (`assets/public/styles/icons`), the `components`/`features`/`hooks`/`lib` dispatch, the `components/ui` shadcn exception, `use-x` hook regexes, Vercel `[param].ts` route filenames. None is config-driven.

4. **Extension assumption:** every file regex ends in `\.tsx?$` / `KEBAB_TS = '^[a-z][a-z0-9-]*\.ts$'`. A `.mjs`/`.js` repo matches **no** allow regex.

5. **Import-wall classes are renderer/main/preload/feature-only:** `classifyWidening()` **throws** ("fits no known wall class") for any import that isn't one of frink's four classes — a generic repo's import graph cannot be baselined at all.

**The dogfooding failure (proof the generalization is broken):** `detectStack()` keys off `package.json` deps; devkit's own repo has no electron/next/react, so it returns `node-service`/`generic`. `STRUCTURE_STACKS = new Set(['electron','react-app'])` is the *only* set that gets an `eslint.config.mjs`. The `generic` template ships **no** `eslint.config.mjs` and **no** `domains.mjs` — only `biome.jsonc`/`guard.config.json`/`tsconfig.json`. Devkit's actual layout is `cli/` + `gate-engine/`, all `.mjs`, `scanRoots ['cli','gate-engine']`, `sourceExtensions ['mjs','js']`. The frink walkers match no `.mjs` file and dispatch on folder names that don't exist there, so every tree baseline returns `[]` (existsSync guard). **Devkit cannot govern its own headline feature.** The `react-app` preset that does ship is a hand-written permissive subset (components/pages PascalCase, empty domains, no import wall) — a one-off, not derivable.

**What a generic repo needs (currently missing):**
- **(A) A data-driven topology spec** — declare trees as `{ name, root, structureRule, libDomains }` in `guard.config.json` (or a structure manifest), and replace the six hand-written walkers with **one generic walker parameterized by the declared folder grammar** (the `createFolderStructure` rule the user already wrote drives the grandfather walk).
- **(B) Configurable extensions** — read `sourceExtensions` from `guard.config` (devkit already stores `['mjs','js']`; the generators ignore it).
- **(C) Configurable entry-file allowlist / frozen-dir list / ignored-dir list / domain keys** (not the frink-fixed names).
- **(D) A config-driven import-wall classifier OR a graceful "no walls" mode** that doesn't throw on unknown classes.
- **(E) A `generic`/`node-service` structure preset** — or better, make the preset a *function of* `scanRoots` + a declared grammar instead of a per-stack hardcoded file.

**What to keep verbatim (the ~90%-generalizable engine):** the shrink-only / self-healing / monotonic-gate semantics; the debt-vs-exempt split; "regen re-adds violators so you can't hand-delete"; fail-open-on-missing-baseline; the closed-registry no-drift idiom; the `'^$'` frozen-dir one-way door; the runbook-keyed-by-error-text and "regenerate ≠ silence" guardrails. (One generic gap to close: `directory-structure.md` §9 warns **pre-commit is bypassable** via `--no-verify`; devkit should mirror the ratchet gates in CI, not only husky.)

---

## Part 3 — The research: is there a universal science for auto-deriving directory structure?

Short answer: **yes for flat module clustering (a mature, ~30-year field), but only partially for the actual devkit task** (a *named, hierarchical* tree), and the field's own strongest results are cautionary.

### 3.1 Classic dependency-graph clustering (ESTABLISHED)

The seminal line casts structure recovery as **graph partitioning over a Module Dependency Graph (MDG=(M,R))** with an explicit objective, solved by local search — **no labels or target cluster count needed**.

- **Mancoridis et al., "Using Automatic Clustering to Produce High-Level System Organizations of Source Code" (IWPC '98)** — founds the field. Objective = **Modularization Quality (MQ)** = average intra-connectivity minus average inter-connectivity, bounded in [−1,1]. Normalizes cohesion by the number of *possible* internal edges (`A_i = μ_i/N_i²`) so the objective doesn't trivially merge everything. Solved by hill-climbing (single-module-move neighborhood) + GA; exhaustive search is tractable only to ~15 modules.
- **Mitchell & Mancoridis, "On the evaluation of the Bunch algorithm" (Soft Computing 2008)** — the **TurboMQ** form: `MQ = Σ CF_i`, `CF_i = μ_i/(μ_i + ½·Σ external)`, giving **O(1) incremental MQ** per single-module move (the scalability lever). **Critical negative result:** Bunch's search landscape on *real* systems looked statistically similar to *random graphs* of comparable size/density — a null-model warning that "structure" may be an artifact of the objective.
- **Praditwong, Harman & Yao, "Software Module Clustering as a Multi-Objective Search Problem" (IEEE TSE 2011)** — reframes as Pareto multi-objective (MCA/ECA); for *weighted* graphs the multi-objective approach **beat** single-objective hill-climbing in 7/10 (a surprise). Edge weights carry real signal; ignoring them (weight=1) is the most-cited limitation.
- **Schwanke, "An Intelligent Tool for Re-engineering Software Modularity" (ICSE 1991)** — the *true progenitor* (ARCH, coupling-cohesion clustering + "maverick analysis"), predating Bunch. **Müller et al. (1993, Rigi)** introduced **omnipresent-module detection** and interconnection-strength clustering — the origin of the "suppress god/utility nodes" idea later re-derived by SArF and CoGCN.

### 3.2 Architecture recovery + how it's evaluated (ESTABLISHED)

- **Garcia et al., "A Comparative Analysis of Software Architecture Recovery Techniques" (ASE '13)** — over 8 systems with ground truth, **ARC (concern/text+IR) and ACDC (subgraph patterns) routinely outperform** the others — but absolute MoJoFM commonly falls **below 50%**: automated recovery only *approximates* authoritative decompositions.
- **Lutellier et al., "Comparing SAR Techniques Using Accurate Dependencies" (ICSE '15)** — **input-feature quality dominates algorithm choice**: accurate, **direct symbol-level** dependencies beat include/transitive ones (~6% MoJoFM swing), and the *best technique flips when the input changes*. **ACDC is the most scalable** (Chromium 9.7 MSLOC in minutes; Bunch-SAHC/LIMBO timed out at 24h).
- **Tzerpos & Holt, "ACDC" (WCRE '00)** — pattern-driven (subgraph-dominator, source-file, body-header, support-library) with bounded cluster size + meaningful names — why ACDC is fast and consistently top-2.
- **Garcia et al., "ARC" (ASE '11)** — concern modeling via LDA over identifiers/comments, fused with structural deps; introduced **a2a** to fix MoJoFM's gameability.
- **Andritsos & Tzerpos, "Information-Theoretic Software Clustering" (IEEE TSE 2005, LIMBO)** — canonical fusion of *structural and lexical* features via information loss — direct support for "deps + names."
- **Lindig & Snelting, "Assessing Modular Structure of Legacy Code Based on Concept Analysis" (ICSE 1997)** — **Formal Concept Analysis**, an entirely distinct non-clustering paradigm deriving structure from feature-usage lattices.
- **Evaluation caution:** MoJoFM is **gameable** (a single huge cluster or all-singletons can score ~100%) and assumes identical element sets — always pair with **a2a** and **cluster-coverage (c2c)**.

### 3.3 Lexical / naming signal — does the "file names" hypothesis hold? (ESTABLISHED, qualified)

The user's "names carry signal" intuition is **empirically supported**:
- **Anquetil & Lethbridge, "Recovering Software Architecture from the Names of Source Files" (1999)** — clustering using **ONLY file names** (no body, no deps) "**best matches the way the software engineers view the system**," explicitly *against* the assumption that the source body is the sole reliable basis. Their companion **"Experiments with Clustering as a Software Remodularization Method" (WCRE '99)** shows naming/directory cues often *disagree* with dependency clusters — a direct threat to using existing folders as ground truth.
- **Ajienka & Capiluppi, "Semantic Coupling Between Classes: Corpora or Identifiers?" (ESEM 2016)** — **identifiers alone reproduce essentially the same conceptual-coupling signal as the full corpus** — naming-only clustering is cheap and viable.
- **Poshyvanyk & Marcus, "The Conceptual Coupling Metrics" (ICSM 2006)** — lexical coupling is **orthogonal** to structural coupling (loads on a separate principal component) — names capture a *domain/intent* dimension import graphs miss, so the two are **complementary, best fused**.
- **Kuhn et al., "Semantic Clustering" (IST 2007)** — LSI over identifier+comment vocabulary, language-independent, granularity-free; preprocessing (camelCase split, stemming, tf-idf, k≈20–50 SVD) dominates quality.

### 3.4 Graph community detection + ML/GNN/embeddings (MIXED; classic methods win on reliability)

- **Weerasinghe et al., "From Monolith to Microservices: A Comparative Evaluation" (arXiv:2601.23141, 2026)** — the **decisive independent head-to-head**: classic hierarchical density clustering (**HDBScan**) is most consistently strong (1st on 3/4 benchmarks); **GNN (CoGCN, CHGNN) and LLM-embedding (MonoEmbed) gave mixed/mostly negative scores** and "higher sensitivity to dataset characteristics and configuration." **GNNs do not reliably beat classic clustering** on structure recovery.
- **Kobayashi et al., "SArF" (ICSM '12 / arXiv:1306.2096)** — modularity maximization on a weighted directed graph with a **Dedication score** that auto-demotes omnipresent modules — a hard-to-beat classic baseline approaching a measurable "authoritativeness limit."
- **Ziabakhsh et al., "Mo2oM" (arXiv:2508.07486, 2025)** — the strongest pro-ML data point: **NOCD GNN soft (overlapping) clustering fusing UniXcoder semantic embeddings with the call graph** beats 8 baselines (+40% SM). But it wins on the same SM/ICP metrics it optimizes, and only when overlap *and* semantic fusion are both enabled.
- **Move-method recommenders — Kurbatova et al. "PathMove" (arXiv:2002.06392, 2020); Cui et al. "RMove" (arXiv:2212.12195, 2022)** — learned classifiers that *score candidate destinations for one unit* beat heuristic tools (JDeodorant, JMove); the winning feature set is **structural + semantic encoded separately then fused**.
- **Mkaouer et al., "Many-Objective Remodularization using NSGA-III" (arXiv:2005.06510, 2020)** — explicit objectives including **minimize number of changes** and **consistency with co-change history** — the practicality levers a cluster-from-scratch tool lacks.

### 3.5 The cautionary / under-covered findings (the "why it's hard" core)

- **Stability (Wu, Hassan & Holt, "Comparison of Clustering Algorithms in the Context of Software Evolution," ICSM 2005)** — the central counter-argument: Bunch/hierarchical/ACDC decompositions are **unstable under small code changes** (Bunch scored *worst* on stability) and several produce "black-hole" giant clusters. Bunch did best on *non-extremity* and *authoritativeness* — so quality and stability are **distinct, conflicting goals**.
- **Evolutionary coupling (Gall et al., ICSM 1998; Beyer & Noack, 2005)** — files that change together belong together; co-change frequently **contradicts** static-dependency clusters — a genuinely different signal.
- **No objective ground truth.** Directory structure ≠ correct module structure (developers folder by convenience). Most real repos have *no* ground truth, so evaluation defaults to MQ/SM proxies — which Wu/Hassan showed are gameable and Mitchell/Mancoridis showed can match random graphs.
- **The task is a TREE, but every method optimizes a FLAT partition.** Hierarchical-cut depth and **automatic naming** for directory names are barely addressed in this literature — a real gap for a foldering tool.
- **LLM-native direct tree proposal** (an LLM reading the repo and proposing a named tree, sidestepping MDG construction) is the **most current and least-validated** angle — promising for *naming* but unproven for *placement*, and not independently benchmarked.

---

## Part 4 — Direct answer to the user's hypothesis

**"Can we parse the file tree + names and use clustering / a neural net to estimate the best directory structure?"** Yes, the idea is viable and well-trodden — but the **defensible, evidence-based product is a "suggest a few well-justified moves + flag low-cohesion folders" recommender, NOT a from-scratch neural tree generator.**

**Feature set: deps AND names (fused), plus co-change if cheap.**
- Dependencies give the "what calls what" skeleton; **use direct symbol-level import edges, not transitive** — the single biggest accuracy *and* scalability lever (Lutellier ICSE '15). Fallow already exposes this (`trace_dependency`/`trace_file`/`get_blast_radius`) — that IS the MDG.
- Names are a **genuinely independent, often-sufficient** signal (Anquetil & Lethbridge; Ajienka; Poshyvanyk & Marcus) and supply the **human-readable folder names** clustering can't. A naming-only first pass is a legitimate low-cost MVP; dep-fusion is the accuracy upgrade.
- Co-change from git is a high-value third channel (NSGA-III) that captures coupling static deps miss.

**Algorithm: classic, deterministic, seeded.**
- Default to **modularity/MQ maximization via hill-climbing with O(1) TurboMQ updates** *or* **HDBScan-style hierarchical density clustering** — the 2026 independent eval (arXiv:2601.23141) finds these **beat GNN/embedding methods on reliability with no training**, ideal for a deterministic CLI. **A GNN is not justified for v1** (config-sensitive, hard to ship/verify, no reliable win on this task).
- **Down-weight omnipresent hubs** (SArF Dedication / CoGCN dilution) before clustering — use fallow's `get_importance`/`get_hot_paths` to identify utility nodes, or they smear every cluster.
- **Seed the search from the existing folder structure** (`list_boundaries`) so output is a *minimal-move* delta, and **report MQ/SM delta** as the "how much better" signal.

**Human in the loop:**
- Frame as **rank/recommend moves, reflexion-style** (recover → overlay on existing tree → surface divergences) — *never* assert one true tree.
- **Minimize churn explicitly** (NSGA-III's key lever); surface only high-confidence single-file moves with the **dependency evidence** that justifies each.
- Allow **overlap/multi-home** for cross-cutting files (or a dedicated `shared/` bucket) — hard 1-file-1-folder is a poor model of reality.

**Known failure modes (cite and guard against each):**
1. **Instability** (Wu/Hassan/Holt) — small edits flip clusters → anchor on existing structure, propose deltas, don't re-derive globally.
2. **Null-model artifact** (Mitchell/Mancoridis) — run a **degree-preserving-shuffle null check**; if real-repo MQ isn't clearly above the shuffle, *suppress* the suggestion.
3. **Gameable metrics** (Garcia a2a) — never optimize MQ/MoJoFM alone; pair with a2a + cluster-coverage so you don't reward one-giant-cluster or all-singletons.
4. **Omnipresent-node smear** — must down-weight hubs.
5. **Ground-truth mismatch** — existing folders aren't authoritative; present suggestions, don't grade against folders as truth.
6. **Modest absolute accuracy** (<50% MoJoFM for full recovery) — position as *scaffolding for human refinement*, not authoritative restructuring.

---

## Part 5 — Recommendation for devkit Phase 3

### 5.1 Fix domains/baselines FIRST (generalized, not frink-hardcoded) — this is the real Phase-3 win

The baseline/ratchet engine is devkit's genuine, ~90%-generalizable asset; the auto-structurer is research-grade. **Ship the generalization before any suggester.**

**Concrete steps:**
1. **Externalize the topology to data.** Add a `structure` block to `guard.config.json`: a list of trees `{ name, root, sourceExtensions, structureRule, libDomains, frozenDirs, ignoredDirs, entryAllowlist }`. The user authors *one* `createFolderStructure` grammar per tree; **that grammar drives both the lint rule and one generic grandfather walker** — deleting the six hand-written walkers in `generate-structure-baseline.mjs`.
2. **Read `sourceExtensions` from config** everywhere the generators hardcode `\.tsx?$` (so devkit's own `.mjs` repo, and any repo, is governable).
3. **Keep the closed-registry no-drift idiom** but make the export *shape* config-driven (a `domains` map keyed by tree name), not the fixed 5 frink names; both the rule and generator import it.
4. **Make the import wall config-driven or skippable.** Replace `classifyWidening()`'s throw with config-declared wall classes plus a graceful **"no walls" mode** (the `react-app` choice should be derivable, not a one-off).
5. **Keep verbatim:** debt-vs-exempt split, shrink-only/self-healing, monotonic fail-open gate, "regenerate ≠ silence," the `'^$'` frozen-dir door, single hand-edited `exempt`. **Add a CI mirror** of the ratchet gates (husky `--no-verify` is bypassable).
6. **Dogfood:** with config-driven topology, devkit governs its own `cli`/`gate-engine` `.mjs` layout — the missing proof.

### 5.2 Should devkit ship a "suggest-structure" tool? — Yes, but scoped and v2

Ship it as **an advisory recommender, not an enforcer**, clearly separated from the (deterministic, load-bearing) gate.

**The algorithm I'd pick and why:**
- **Modularity/TurboMQ hill-climbing seeded from the current boundaries**, with **direct-import edges** (fallow), **Dedication-style hub down-weighting** (fallow importance), and a **lexical/name-cosine channel fused as a tie-breaker + the source of folder names**. Chosen because the strongest independent evidence (arXiv:2601.23141, 2026) shows **classic clustering beats GNN/embeddings on reliability with zero training** — the right fit for a deterministic CLI devkit can verify.
- **Two outputs only, both low-churn and reviewable:** (a) **misplaced-file detection** (Move-Class style: a file whose dependency mass + name similarity points to a different directory → single high-confidence move with evidence); (b) a **per-directory cohesion score** to flag "god folders" / incoherent packages as a gate *signal* (mirrors fallow's health checks).
- **Mandatory guards:** the **null-model shuffle check** before surfacing anything; multi-metric scoring (a2a + coverage, not MQ alone); explicit **churn cap**; overlap allowed for cross-cutting files.

**Explicitly avoid:** a black-box NN that emits a whole new tree — the dominant failure mode in the literature (high churn, low trust, unstable, hard to verify). **LLM-native naming** is a reasonable *labeling* layer on top of the deterministic clustering, but not the placement engine, and not until the clustering core is validated against devkit's own repos.

**Net:** Phase 3 should **generalize the baseline engine (high-confidence, high-value, mostly mechanical)** and ship the **suggester as a separate, advisory, classic-clustering tool with hard churn/null-model guards** — never as a gate, never as a from-scratch neural tree.
