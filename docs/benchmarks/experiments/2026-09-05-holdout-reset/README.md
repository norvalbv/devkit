# Holdout reset: below-floor API-security measurement

The complete API-security run finished on 2026-09-05 at 03:00:07.641 UTC from clean source
`27541a7ed6529cf09b9d32abcd3f4be0f91a0363`. It blocked 20/23 labelled defects and passed 14/21
clean fixtures, with zero execution errors. The 66.7% clean-pass result fails the 85% floor.

[api-security.json](api-security.json) preserves the configuration, acceptance failure,
metrics, all 44 row outcomes and hashes, and the SHA-256 of the private native baseline.
It contains no finding text, source snapshots, or private filesystem paths.

This is standalone experiment evidence. The accepted-checkpoint tracker requires acceptance,
so this run is not added to that ledger and does not replace the previous accepted checkpoint.
No quality miss was rerun, and the acceptance floors are unchanged.

The [full reset report](../../holdout-reset-2026-09-05.md) explains the partition repair,
measurement commands, interpretation and validation.
