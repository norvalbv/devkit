# Interpreting changed outcomes

These are selected source-grounded interpretations made after the candidate freeze. The candidate run was stopped following the user’s usage concern at 184 of 285 complete rows. These observations are partial and are not a completed full-corpus comparison. No observation below changed the candidate, reservation or labels. The final comparison retains every changed outcome, including findings whose factual status remains unresolved. This is not independent claim adjudication.

## Changes consistent with the intended procedure

The candidate accepts the conditional-update repair, updated-signature repair, targeted broadcast and archived-items query repair where the baseline introduced missing-module, external-caller, ownership-transfer or unregistered-procedure assumptions. It also accepts the invoice example where the baseline assumed an atomic multi-read snapshot, and the schema repair where acceptance of additional fields was treated as a promise to preserve them. These changes are consistent with the proposed contract and causality discipline. They do not establish general safety of the omitted counterpart implementations.

A concrete fixture-grounded gain is `corr-pr60-avoid-leaving-the-member-in-pair`: the baseline assumes `ctx.advance()` dispatches work and then rejects, but the supplied `getContext()` returns `advance: async () => {}`. That shown implementation neither dispatches nor rejects. The candidate accepts the rollback repair. This supports a specific reduction in an invented execution path, without estimating corpus-wide factual precision.

## Regressions and remaining uncertainty

| Cases | Observed change | Interpretation |
| --- | --- | --- |
| `corr-stale-failure-reasons` and `corr-decoy-reset-failure-reasons` | The candidate accepts the stale-issues bug and rejects the clearing repair. | The repair explicitly says a pass supersedes an earlier failure. Candidate findings instead require failures to remain sticky, matching the new instructions governing the reviewer's own checklist. This is evidence of the reviewer applying its own workflow policy to the program being reviewed, and contradicts the repair's stated behavior. |
| `corr-persist-unnormalized-signal` | Baseline flags the bug; candidate accepts it. | The candidate follows the auto-completion reader's raw-signal comment while failing to enforce the writer's explicit downgrade to reviewable `done`. The reader's comment describes its input; it does not establish that the writer should bypass its explicit normalization requirement. |
| `corr-broadcast-fanout-no-dedup` | Baseline flags the bug; candidate accepts it. | The fixture shows owner-targeted delivery becoming broadcast but omits the receiving effect. The candidate establishes no required once-only effect. This is a label-relative loss that also exposes the distinction between an intended label's source context and the evidence present in the fixture. |
| `corr-decoy-lock-finally` and `corr-decoy-worktree-finally` | Candidate accepts the lock cleanup but newly rejects the worktree cleanup. | Both findings concern a cleanup rejection replacing a primary rejection. JavaScript semantics support that possibility; the supplied fixtures do not establish the dependency failure and error-priority contracts. The opposite flips do not demonstrate a uniform improvement in this reasoning pattern. |

## A label gain need not identify the target bug

`corr-asymmetric-flip-classifier` changes from accepted to flagged, but the candidate's findings concern a newly added report command returning exit code zero when its nested report contains a regression. They do not identify the intended asymmetric `gained/lost` condition. The command is added by the fixture and the exit-code claim may be an adjacent contract concern; its required gating behavior was not independently established here. This row therefore improves label agreement without demonstrating that the candidate fixed the small-condition detection weakness diagnosed before activation.


## Newly added cases

`corr-command-block-argument-boundary` is a development bug-label loss. Its qualification controls reproduce a second or third command block being consumed as the first block's arguments. The baseline's recorded findings instead concern the command-name domain and an unescaped literal terminator; neither identifies that qualified multi-block target. The candidate accepts the row. This is a measured loss, with an additional limit on what the baseline's correct label establishes.

Both versions miss the reserved `corr-delete-reserved-prefix-recovery` bug. The fixture's comment distinguishes an existing user-node delete handler from namespace reservation for creation, but both accept applying the new prefix restriction to deletion. Qualification confirms that existing `calendar_custom` and `issues_old` leaves remain deletable in the base and repair. The full historical downstream remover is outside the fixture. This reserved outcome was inspected only after candidate freeze and did not change the instructions.

## Initial findings and final gate decisions

The baseline initially flags the qualified `corr-population-projection-token-prefix` bug in two lenses: an unbounded `-_id` replacement rewrites a requested field such as `foo-_id` to `foo`. Native charter post-processing drops both findings as `dropped_out_of_charter`, yielding a final PASS even with cascade off. This is why baseline initial detection is 102/105 while final blocking is 101/105. The reporting controls caught an incorrect assumption that those fields must agree; the public comparison now retains both stages. The frozen runner is unchanged, and no finding was discarded from the primary measurement to repair this discrepancy.

These observations retain the historical **13.9% label-noise reference**. Neither the clean-label improvements nor the bug-label losses are silently reclassified to improve the measured headline.
