# Every changed row

Gain/loss means agreement with the frozen label. Initial verdicts and final gate statuses are separate. No row is excluded or relabeled.

| Row | Label | Partition | Initial baseline → candidate | Final baseline → candidate | Initial change | Final change |
| --- | --- | --- | --- | --- | --- | --- |
| `corr-asymmetric-flip-classifier` | FAIL | development | PASS → FAIL | pass → fail | gain | gain |
| `corr-decoy-conditional-update` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-xdomain-nplusone` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-xdomain-render` | PASS | development | PASS → FAIL | pass → fail | loss | loss |
| `corr-decoy-lock-finally` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-decoy-signature-callsite-updated` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-broadcast-fanout-no-dedup` | FAIL | development | FAIL → PASS | fail → pass | loss | loss |
| `corr-decoy-broadcast-targeted` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-pr200-important-pair` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-pr26-keep-the-mcp-inputschema-in-pair` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-pr38-check-the-full-r2-credential-pair` | PASS | development | FAIL → FAIL | fail → pass | unchanged | gain |
| `corr-pr26-block-parked-answer-sends-when-pair` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-pr52-don-t-down-rank-recorded-pair` | PASS | development | PASS → FAIL | pass → fail | loss | loss |
| `corr-pr52-use-frink-no-log-in-pair` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-pr59-expand-knip-config-detection-pair` | PASS | development | PASS → FAIL | pass → fail | loss | loss |
| `corr-pr59-expand-knip-config-detection` | FAIL | development | FAIL → PASS | fail → pass | loss | loss |
| `corr-empty-home-override` | FAIL | reserved | FAIL → PASS | fail → pass | loss | loss |
| `corr-ip-address-subdomains-clean` | PASS | development | PASS → FAIL | pass → fail | loss | loss |
| `corr-null-map-key-clean` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-eslint-arrow-parens-clean` | PASS | development | PASS → FAIL | pass → fail | loss | loss |
| `corr-nested-default-projection-clean` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-eslint-consistent-this-clean` | PASS | development | PASS → FAIL | pass → fail | loss | loss |
| `corr-eslint-no-empty-clean` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-empty-taxonomy-values-clean` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-heading-text-projection-clean` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-pagination-page-context-clean` | PASS | reserved | FAIL → PASS | fail → pass | gain | gain |
| `corr-eslint-func-names-clean` | PASS | development | PASS → FAIL | pass → fail | loss | loss |
| `corr-eslint-no-fallthrough-clean` | PASS | development | PASS → FAIL | pass → fail | loss | loss |
| `corr-live-client-configuration-clean` | PASS | reserved | FAIL → PASS | fail → pass | gain | gain |
| `corr-nested-array-dirty-collapse-clean` | PASS | development | FAIL → PASS | fail → pass | gain | gain |
| `corr-pending-file-list-serving-clean` | PASS | reserved | FAIL → PASS | fail → pass | gain | gain |
| `corr-pipeline-buffer-preservation-clean` | PASS | reserved | PASS → FAIL | pass → fail | loss | loss |
| `corr-runner-exit-trailer-clean` | PASS | development | PASS → FAIL | pass → fail | loss | loss |
| `corr-server-load-error-exit-clean` | PASS | development | PASS → FAIL | pass → fail | loss | loss |
| `corr-population-projection-token-prefix` | FAIL | development | FAIL → FAIL | pass → fail | unchanged | gain |
| `corr-unregistered-population-model-clean` | PASS | development | PASS → FAIL | pass → fail | loss | loss |
