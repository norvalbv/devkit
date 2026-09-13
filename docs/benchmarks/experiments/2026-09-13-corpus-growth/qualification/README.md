# Qualification evidence for the 139 additions

[The row index](index.json) maps every new corpus row to its replay, receipt and evidence limits. The corpus hash is frozen in [the protocol](../freeze/protocol.json). Labels were fixed before the expanded reviewer run; no model verdict was used as a qualification test. Source and adapted code were inspected by agents, so these are source-exposed, agent-qualified cases rather than independent human ground truth.

| Evidence group | Admitted rows | Executed replay observations |
| --- | ---: | ---: |
| Vue async recovery | 2 | 12 adaptation observations; separate upstream execution |
| Sanitized telemetry pairs | 18 | 237 adaptation observations |
| Public source pairs and standalone repairs | 15 | 2,722 source/adaptation observations |
| ESLint standalone corrective controls | 49 | 8,812 published-test observations |
| Mongoose, Hexo, Redis and Karma runtime cases | 50 | 1,720 prepared + 772 independent observations |
| Four ESLint regression families | 5 | 240 target + 546 independent observations |

Observations include original buggy outcomes and matching adapted outcomes. They are not extra corpus cases or independent labels. Target-only later repairs rejected from the corpus remain visible in the ESLint regression evidence. Shared source contexts are grouped into families, including cases that are not repair pairs.

## Reproduce

Use Node **v24.19.0**, npm, Python 3 and Git. The scripts make no model calls. Use disposable work directories outside the repository. Historical dependencies install from the committed package locks with lifecycle scripts disabled; registry access or a populated package cache is required. Clone the public [BugsJS repositories](https://github.com/BugsJS) named below, retaining the pinned commits and tags.

From the repository root:

```sh
node docs/benchmarks/experiments/2026-09-13-source-qualification/controls.mjs
node docs/benchmarks/experiments/2026-09-13-corpus-growth/qualification/telemetry-controls.mjs
python3 docs/benchmarks/experiments/2026-09-13-corpus-growth/qualification/replay-eslint.py \
  --source /path/to/bugsjs-eslint --work /path/to/disposable-eslint
python3 docs/benchmarks/experiments/2026-09-13-corpus-growth/qualification/replay-runtime.py \
  --sources /path/to/bugsjs-clones --work /path/to/disposable-runtime
```

The runtime source directory contains clones named `bugsjs-mongoose`, `bugsjs-hexo`, `bugsjs-node_redis` and `bugsjs-karma`. Additional replay instructions are in [source pairs](source-pairs/README.md) and [ESLint regressions](regressions/README.md). Both read the exact canonical admitted fixtures. The nine population rows described in the regression bundle are already included in the 50 runtime rows and their observations; do not count them twice.

The existing [Vue qualification report](../../2026-09-13-source-qualification/README.md) records the earlier qualification-stage state before admission. The current experiment admitted those two exact proposals. Its published commands also describe how to reproduce the upstream source runs.

## Fidelity and limits

The manifests pin complete original source files, adapted fixture bytes, source revisions and historical runtime locks. Some fixtures preserve complete module bodies behind explicit CommonJS loader ports; others extract an operation while executing it on the original callers and dependencies. The manifest and row notes identify which mode applies. Comments or formatting can differ where executable AST equality was checked. A source/adaptation comparison means the two versions produced matching observed behavior; it does not establish complete application coverage.

The reviewer sees only the files declared in each corpus fixture. Native materialization creates those original files and stages the declared changes; it does not install or copy the complete upstream host used by the qualification replay. Loader-port fixtures can therefore omit unchanged dependencies and callers that the real-runtime controls exercised. The replay establishes the declared behavior of the adaptation, while reviewer evidence availability remains a separate limitation. A missing counterpart must not be treated as proof of either a new defect or a safe contract.

ESLint controls load the actual historical core, parser and fixer. The 49 standalone controls use the published rule tests. Four separately qualified regression families additionally use independent boundary cases; only one later repair survived the clean-case checks. The three rejected later repairs are explicitly outside clean and paired metrics.

Mongoose uses historical schema, document, query and model implementations with controlled collection callbacks, without a MongoDB server. Limit and projection controls establish the outgoing query contract, not server-side selection or sorting. Redis uses a controlled transport. Hexo and Karma controls exercise their declared dependency closures rather than a running blog or browser fleet. Source-pair evidence records Express loopback HTTP, the real Hessian decoder and Shields' actual LRU plus declared external ports. Shields' admitted clean repair includes an agent-derived null-prototype extension; the upstream-only repair remains an unclean comparison endpoint.

Three original-version Karma 20 notification assertions vary with filesystem/timer scheduling. Every original result is retained, but only those three base assertions are excluded from deterministic published-test parity. All other published outcomes remain checked, repaired tests must pass, and immediate/burst/reentrant controls require raw source/adaptation equality. The [runtime receipt](runtime-replay-results.json) preserves the actual timing outcomes and disclosure. Other historical limits include an old TLS key rejected by current OpenSSL in both corresponding source/adapted controls, pending tests, and date-only clock control where old assertions depend on their original year. No failing quality outcome was silently retried until it passed.

For several legacy controls the replay compares assertion names, pass/fail and exception class rather than random-ID diagnostic text. Independent edge controls compare raw behavior before normalizing machine-dependent paths for expected-record comparison. No semantic behavior is removed by that path normalization. See [runtime manifest](runtime-manifest.json) and [qualification reviews](reviews/) for exact scopes.

The telemetry script replays the sanitized adaptations and preserves source-derived behavior, but it cannot reconstruct private original repositories. Original source qualification and captures remain private. This is a deliberately narrower public reproducibility claim than the public-source bundles. The Vue pair likewise has separate upstream and adaptation procedures.

## Attribution and integrity

Source license notices are retained in `licenses/`, `source-pairs/licenses/`, `regressions/licenses/` and the earlier Vue directory. Some historical Mongoose and Redis notices were embedded in README files; the manifest records those source revisions. Frozen npm archives retain dependency licenses. Public receipts contain no raw reviewer output, credentials or private repository paths.

These controls assess code behavior. Reviewer label agreement, factual claim adjudication and production precision are separate measurements. The historical **13.9% label-noise reference** and unresolved repaired-row disputes remain applicable limitations in the final comparison.
