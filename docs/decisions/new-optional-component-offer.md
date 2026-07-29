---
slug: new-optional-component-offer
created: 2026-07-29
---

# new-optional-component-offer

## Target · 2026-07-29 — A single registry, OPTIONAL_COMPONENTS in components.mts, drives a generic upgrade step (3c) that of

**Context:** devkit ships opt-in components after most consumer repos are already initialised. Before this, only GUARDS had a reconcile path (newBundledGates, upgrade step 3) and the one optional component that needed offering — the line-growth block — got a bespoke hardcoded step (3b). A third optional component would have meant a third copy of that block, and a repo whose config predates a component had no way to learn it exists short of re-running init.
**Ruling:** A single registry, OPTIONAL_COMPONENTS in components.mts, drives a generic upgrade step (3c) that offers every optional component a repo has never been asked about. 'Never asked' is detected by the ABSENCE of the recorded key, not a falsy value: applyInit writes every component key on every run, so a repo that answered — yes OR no — carries the key and is never asked again, while a repo predating the component has no key at all. No per-repo 'offers made' state. Nothing is ever auto-added: non-TTY REPORTS only, matching the step-3 gates policy, because an opt-in component arriving because someone ran upgrade in CI is a defect. Correspondingly, a run where nobody was actually asked (non-TTY, or a cancelled prompt) passes those ids to applyInit as InitPlan.undecided, which keeps their keys absent — otherwise step 4's broad refresh would record the normalized 'false' as a decision nobody made and suppress the offer permanently.
**Consequences:**
- Positive: A new optional component needs one table row to get its upgrade offer, wizard-independent. Declines are durable and cancels are not (a cancel means 'ask me later'). The line-growth step 3b is left as-is: it is a guard.config.json knob rather than a Selection boolean, so it does not fit the table — it stays the one bespoke offer.
- Negative: Overlaps slightly with newBundledGates rather than unifying gates and components into one offer mechanism. Accepted: gates carry a recommended/opt-in split and heal differently, and forcing both through one abstraction would obscure that the recorded guard selection is authoritative for a different reason.
**Vision-fit:** The recorded selection is the consumer's answer, and devkit never edits it on their behalf. This extends that rule to components while making sure a repo still hears about what it is missing.
**Source:** manual
