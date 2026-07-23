---
name: decisions
description: Use when an architectural choice is being made, reversed, or revisited — recording the long-term *target* (an epic/PRD: product + eng + vision) behind a decision, noting an implementation step under an existing target, checking whether an axis was already ruled on, or when a commit gate flags an unrecorded or off-target change. The living why-store under docs/decisions/.
---

# Decision Log

Git shows *what* changed, never *why / the target*. The failure this prevents: architectural axes
flip-flop (e.g. a trigger-payload shape rewritten 8 times in 2 days) because each impl shift is
recorded as a fresh "ruling" written at **implementation altitude** ("X broke, so I changed Y").

**A decision is an EPIC, not a patch-note.** It states the long-term **target** — at **product +
business + eng** altitude, research-backed, aligned to Frink's vision (`frink-identity`). A broad
target ("any user-edited environment confirms on unsaved-leave, per UX research") is *durable*; a
local patch ("flow editor got a modal") *churns*. Write the durable thing.

- `docs/decisions/<slug>.md` — that axis's **append-only** file: a stack of `## Target ·` blocks
  (rare, the PRD) + cheap dated `- <date> — note`s (implementation convergence under the current
  Target). Frontmatter is two immutable fields `{slug, created}`.
- `docs/decisions/INDEX.md` — derived spine: current **Target** per axis. Shows the Target, never a
  note. Regenerable; holds no history.

CLI: `guard-decisions` (`add --target` · `add --note` · `amend --target` · `amend --note` · `query` · `list` · `show` · `check` · `reindex`).

## The bar — is this log-worthy, and at what altitude? (LAYERED)

**Whether to log at all** (the two-clause floor — unchanged): (1) a *road not taken* — ≥2 viable
approaches, the opposite still viable; AND (2) load-bearing — you'd want the *why* in 6 months.

**How to write it** (the altitude bar — the v2 addition): *would a product + eng team make this its
own epic / PRD?* If yes → a **Target** at product/business/eng altitude (broad, cross-cutting,
research-backed, vision-tied). If it's a local implementation choice under an existing target → a
**note**, not a target. If it's a bug fix / lint / behaviour-preserving refactor → don't log.

**Three worked examples:**

| Change | Verdict |
|---|---|
| "Flow editor's unsaved store moved localStorage→SQLite (localStorage can't do concurrent writes)." | **Don't log as a target** — local impl. If an axis governs it, it's an `add --note`; else nothing. |
| "All network retries use exponential backoff + jitter, capped 30s." | **Small-but-architectural → terse Target.** context (retry storms hammered the API under load) + ruling + consequences (stable under load) + tradeoff (up to 30s added latency) + vision-fit. |
| "Leaving ANY user-edited environment (flow, settings, …) confirms on unsaved changes." | **Epic → full Target.** context (users lost edits silently on close) + ruling + consequences (no lost work) + tradeoff (one extra confirm click) + researched (UX studies) + rejected (silent autosave) + vision-fit + scope. |

## The Target schema — the ADR spine (Context · Decision · Consequences)

frink **adopts the Nygard / MADR ADR spine** (don't reinvent — rule #6): **Context** (the forcing
problem) → **Decision / Ruling** (the mechanism) → **Consequences** (value protected + cost paid),
plus frink's own extensions (Vision-fit, Scope alignment-gate, Anchored-bet). The named failure this
prevents is *architectural knowledge vaporization* (Jansen & Bosch 2005) — the *why* left implicit
evaporates on the next refactor.

```
guard-decisions add <slug> --target \
  --context "<the forcing FAILURE: what the system did before, the symptom it caused, + severity/blast-radius>" \
  --ruling  "<the DECISION / mechanism chosen>" \
  --consequences "<the user/business VALUE this protects — the promise kept>" \
  --tradeoff     "<the COST knowingly paid — latency, complexity, a road not taken>" \
  --vision-fit "<which frink-identity North Star/USP it serves; or 'n/a — internal tooling'>" \
  --title   "<short scannable heading; optional — defaults to the ruling's first clause>" \
  --researched "<what was researched + sources: arxiv/shortcut/web/collab>" \
  --rejected   "<roads not taken + why-not, with sources>" \
  --anchored-bet "[BET]|[VALIDATED]"   --revisit-when "<condition that voids this ruling>" \
  --scope "src/area/**,src/other/**" \
  --source "<arxiv|shortcut|web|collab|brainstorm>"   --ref "<url / ticket id>"   --new
```
- **Required:** `--context`, `--ruling`, `--consequences`, `--tradeoff`, `--vision-fit`. The 10-year
  test keys on **Context** — a reader a decade out narrates *"the vision was X → a flow did Y →
  causing Z → so we chose W"*. The explicit **`--tradeoff` (Negative)** is load-bearing: it stops a
  future simplifier from silently re-introducing the original failure.
- **Context vs Ruling vs Vision-fit** (the rule that retires the old overloaded `Vision / target`):
  Context = the *problem* (WHY-now), Ruling = the *mechanism* (WHAT), Consequences/Tradeoff = the
  *value + cost* (SO-THAT). Vision-fit names ONLY the North Star — never restate the symptom (that's
  Context) or the value (that's Consequences).
- **`--scope`** = files/area this target governs (comma-separated globs) → arms the **alignment gate**
  (Capture C): a later code change in that scope that contradicts the target is blocked at commit.
- **`--anchored-bet`** = the `frink-identity` confidence the target rests on; `[BET]` = cheap to
  revisit. `[VALIDATED]` asserts the originating failure (Context) no longer occurs.
- **`--revisit-when`** = the 100-year test made mechanical: the concrete condition under which this
  ruling becomes INVALID / safe to reverse ("inference cost < $0.01/summary", "the provider ships a
  batch API"). A reader far in the future should not have to *infer* when the decision died — the
  record states its own expiry condition. Pairs with Anchored-bet: `[BET]` says how confident,
  Revisit-when says what would flip it.
- INDEX shows the ruling + a hook of the **Context**.

**Authoring discipline** (adopted from the multica ADR persona — `cloned-projects/multica/.../adr-writer.json`):
- **One decision per Target.** If you're writing "we also decided …", that's a second axis — split it.
- **Name 1–3 rejected alternatives.** A Target with an empty `--rejected` reads like there was no real choice.
- **No marketing language** ("best-in-class", "future-proof") or generic platitudes ("good for maintainability") — state the concrete value in Consequences.
- **No code samples in the Target.** The diff and the PR show the *what*; the Target carries the *why*.
- **Never bury the Negative.** An empty `--tradeoff` is how a future simplifier silently re-introduces the original failure.

**Writing with DEPTH — the rubric you are judged against.** A Target can fill every required field and
still be shallow (a non-empty field can still say nothing). A warn-only **depth judge** runs at commit
(Capture C) against this rubric — but write to it, don't wait to be warned. Self-interview *one
question at a time* (the adr-agent technique) until all of these hold:
1. **Context = the forcing COST, not a restatement.** What did the old state actually *cost* — the
   failure, the symptom, who it hurt — that made the status quo untenable? If your Context merely
   re-describes the prior ruling or the new mechanism, it is circular. For a *derived* decision,
   cross-link the parent and summarise its cost in Context — don't bury the why in Evidence-change.
2. **Each rejected road paired with the criterion it loses on.** Not "(b) cloud enrichment" but
   "(b) cloud enrichment — INFEASIBLE: the integration token is machine-sealed, undecryptable in the
   cloud." Name the alternative AND the specific thing that kills it.
3. **The Negative is concrete.** Not "some added complexity" but "+ up to one 2s watcher tick of
   advance latency; a hand-maintained auto-approved-plan carve-out."
4. **A Revisit-when, if present, is checkable.** Not "when circumstances change" but "inference cost
   < $0.01/summary, or ARPU crosses $15". Its *absence* is not judged by the LLM (an eval showed
   inference-based absence checks destabilise the judge) — the eval's `depth-audit` flags missing
   Revisit-when lines deterministically; add one so a future reader knows when the ruling dies.

Worked example — a shallow Context vs a deep one (real, from `frink-flows-skill-source-of-truth`):
- ✗ shallow: *"The prior ruling installed via symlinks. The canonical-home decision rejected symlinks
  repo-wide."* — restates the prior state; the why is missing/buried.
- ✓ deep: *"Symlinked skills DANGLE on uninstall and POLLUTE committed repos when a user checks one
  into their project — the support + hygiene cost the canonical-home epic ([[provider-config-canonical-home]])
  ruled against. Real copies projected per-tool remove both."*

## Re-targeting — only on an evidence-state change (never impl pain)

`add --target` on an axis that **already has a Target** requires `--evidence-change "<what
shifted>"`. A target moves only when the evidence/research/bet changed or a genuinely new
alternative opened — **never because the implementation hit a wall** (that's a `--note`).

This is an **honest speed-bump, not a verifier** — the CLI only checks the flag is present, so a
laundered "evidence change" can pass. The real deterrent is the **visible append-only A→B→A
history**: every re-target is permanently on the record for a human to read.

## Notes — cheap implementation convergence

```
guard-decisions add <slug> --note "flat→raw payload because the extractor was lossy"
```
A `- <date> — …` bullet under the current Target. Not a ruling, doesn't touch the INDEX. This is
where implementation churn lives — so it never masquerades as a target flip.

## Append-only — the core invariant (incl. migration)

**Never mutate or delete a written block.** A→B→A is preserved; the *why* of each survives. The
only edit allowed is an entry you're authoring in the *current uncommitted* workflow (typo fix).
Use `amend <slug> --target …` or `amend <slug> --note "…"` for that narrow case: only the newest
entry absent from `HEAD` can be replaced, and the CLI refuses if committed or earlier working-tree
history changed. While the decisions guard is selected, direct native agent edits are blocked only
under the configured decisions directory; shell commands and unsupported payloads remain outside
this enforcement and fail open.
To retire a mis-filed (non-epic) entry: **archive, don't delete** — move it under a
`## [archived — impl-note, not an epic]` heading in the same file (INDEX stops surfacing it; the
record stays intact). Deleting committed history would break the trust the whole log rests on.

## Capture A — at the fork (primary)

The **`brainstorming` skill is the trigger**. There, before the user picks:
1. `decisions query "<topic>"` → top-k candidate axes (catches the same axis under another name).
   If one fits, `show <slug>` and **surface its current Target inside the A/B you pose** — never let
   a silent reversal happen.
2. After the ruling settles, if it clears the bar → record the **Target** (`add --target …`) while
   the *why* is live. New axis → `--new`.

## Capture B — unrecorded-decision gate (`detect.mjs`)

`.husky/pre-commit` smells an architectural diff (dep change · cross-boundary · module replace ·
legacy deletion) with **no decision staged**; `claude -p` clears a routine change, else **blocks**
("record a Target, or `GUARD_NO_LOG=1` if minor"). A Stop hook also nudges at turn-end while the
*why* is live (snoozed once per session).

## Capture C — alignment gate (`check-alignment.mjs`) — the flip-flop guard

For every Target with a `--scope`, when a staged file matches that scope, an **agentic judge**
(`claude -p` with read-only tools: Read/Grep/Glob/`git diff --cached`) *investigates* the staged
changes itself — no stuffed/truncated diff — then rules **ALIGN / CONTRADICT / UNCLEAR** with a
rationale + final `VERDICT:` line (tool-equipped judges beat single-shot on code — Agent-as-a-Judge,
arXiv:2410.10934). **Cascade:** haiku judges every scoped commit; only its CONTRADICT escalates to
opus, which gets haiku's full transcript + the same tools and confirms or overturns. A **block
requires an opus-confirmed CONTRADICT** (realign, or re-target with `--evidence-change`). This
catches the real flip-flop — code silently deviating from an existing target — deterministically
(the scope glob is the match, the LLM only judges contradiction). Bounded block; fail-open at every
step if `claude` is absent/times out; `GUARD_NO_LOG=1` bypass.
Recording a Target **alongside its first implementation** in one commit is fine — a normal step toward
the target judges ALIGN; if a false CONTRADICT ever blocks that combined commit, `GUARD_NO_LOG=1`.

**The same gate also runs a WARN-ONLY depth pass.** For every staged `docs/decisions/*.md`, `claude -p`
judges the Target block against the depth rubric above (Context not circular · each rejected road
paired with its losing criterion · the Negative concrete) → **PASS / THIN**. A **THIN warns** and names
the weak spot so you deepen the still-uncommitted block — it does **not** block (the schema already
forces the *fields*; this audits whether they *say* anything). `GUARD_DEPTH_HARD=1` escalates a
confident THIN to a block. This is the soft-lint pattern from `adrs` + `adr-agent` — not more required
params, which provably do not help (a Target can satisfy all five required fields and still be shallow).

## Common mistakes

| Mistake | Fix |
|---|---|
| **Restating the Ruling (mechanism) in Context or Consequences** | The Ruling + the diff already show the mechanism (WHAT). **Context** = the failure that forced it (WHY-now); **Consequences** = the value protected + cost paid (SO-THAT). If Context reads like "we gate on the complete turn", it's the Ruling — rewrite it as the *symptom that forced* that ruling. |
| Omitting `--tradeoff` / leaving the Negative empty | Every decision has a cost (latency, complexity, a road not taken). The explicit Negative is the anti-flip-flop guard — without it a future simplifier silently re-introduces the original failure. |
| Writing the target at impl altitude ("X broke → did Y") | State the **cross-cutting principle** (product/eng), research, rejected roads. The diff shows what broke. |
| Recording an implementation step as a new `--target` | It's a `--note`. A target moves only on an evidence change (`--evidence-change`), not impl pain. |
| Deleting a non-epic entry | **Archive** it (`## [archived …]`). Never delete — it breaks append-only trust. |
| Logging a bug fix / pure refactor / one local choice | Below the bar — not an epic, no viable opposite. Don't log (or `--note` under an existing target). |
| Omitting `--scope` on a product-facing target | Then the alignment gate can't guard it. Set the glob so deviations get caught. |
| Inventing a new slug for an existing axis | `query` first; reuse the slug. |

**REQUIRED TRIGGER:** Use `brainstorming` — that is where Capture A fires. This skill is the mechanics.
