---
slug: reship-rewrite-lease-head-only
created: 2026-09-28
---

# reship-rewrite-lease-head-only

## Target · 2026-09-28 — ship --pr --base leases the PR head and base NAME, never GitHub's base OID

**Context:** devkit ship --pr --base (rewrite mode, #518) exists to publish a caller-resolved conflict for a PR whose base moved, yet its preflight required GitHub's PR baseRefOid to equal the freshly fetched origin/<base> tip. GitHub snapshots baseRefOid at PR creation or the last head push and never advances it as the base moves, so once main moved the lease was unsatisfiable in exactly the case the mode was built for. gh pr update-branch fails on conflicts, and the only other way to advance the snapshot is an ungated raw push. An autonomous report (sc-2739) lost PR #584 this way and re-shipped as #587 at the cost of a full cold reviewer chain. The pre-push re-check and --resume recovery had the same shape: a base that advanced during gates or after publication stranded a gated replacement. The test fixture hid all of it by stubbing baseRefOid as the live tip.
**Ruling:** The rewrite lease is the exact PR head OID (force-with-lease), the PR head repo, and the base ref NAME. baseRefOid is not requested and never compared, including in the pre-push and recovery identity re-reads. Base freshness is proven locally: origin/<base> must be an ancestor of the caller checkout. At push time a base that moved FORWARD during gates is accepted (the PR shows behind, as if the push landed a moment earlier); a deleted, rewound or unverifiable base is refused. A --resume whose gated receipt is proven and whose published replacement sits on an older tip of the same base re-anchors to that parent, so recovery and the reconcile scope never depend on where the base went after publication.
**Consequences:**
- Positive: A conflicted PR whose base moved is repaired with one local rebase/merge and one ship command: no raw push outside the gates, no abandoned PR, no second cold reviewer chain. Busy bases no longer loop a rewrite through gate-then-refuse.
- Negative: The rewrite no longer proves GitHub agrees on the base tip; it trusts the local containment check plus the head lease. A replacement can publish already behind a base that advanced mid-gates, so CI or branch protection may ask for another update. One extra fetch runs when the base moved during gates.
**Vision-fit:** n/a — internal devkit tooling (ship pipeline correctness); stays inside devkit-gates-repo-not-harness.
**Researched:** GitHub community discussion #59677 and actions/runner#1689: base.sha is fixed at PR creation or the last head push. Live devkit PRs #647/#639/#612/#93 carried a baseRefOid older than main. git-town force-pushes under a head-only --force-with-lease. A prior-art pass returned DISSOLVE_FRAME; a feature-critique pass returned PROCEED_WITH_CHANGES and added the pre-push and recovery sites.
**Rejected:** (a) Keep baseRefOid but relax it to --is-ancestor of the pinned base: adds nothing beyond the containment check and exits 128 on an object a shallow or partial clone never fetched, a false refusal. (b) A separate devkit ship --sync-base / reconcile command that pushes the merge first: redundant once the lease is correct, and a second publication path to gate. (c) Keep the pre-push base equality: on a busy base every rewrite loops gate, refuse, rebase, gate.
**Revisit-when:** GitHub exposes a live base tip on the PR object, OR a rewrite that published behind a moved base is shown to have merged content the gates never judged.
**Scope:** cli/lib/ship/reship.sh
**Source:** shortcut · sc-2739
