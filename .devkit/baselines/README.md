# Devkit baselines

This directory contains generated, shrink-only debt owned by Devkit. It lets a gate be adopted
without repairing an existing repository in one change while still rejecting new violations.

- `fanout.json`, `size.json`, and `size-lines.json` are engine-neutral ratchet ceilings.
- `imports.mjs` contains generated import-wall debt.
- `structure/<tree>.mjs` contains generated placement debt for each configured structure tree.

Do not add entries by hand. Repair the violation and let the relevant gate or an explicit audited
baseline regeneration remove it. Permanent architectural exceptions are policy rather than debt and
belong in `.devkit/structure/exempt.mjs`, with a reason for each entry.

Baselines are cut when Devkit first adopts a repository. Upgrade does not resnapshot them. The clean
end state is absence: when the final violation heals, the generated file is removed and the gate
continues enforcing directly from `guard.config.json`.
