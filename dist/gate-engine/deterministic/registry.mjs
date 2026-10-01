/**
 * The deterministic guard registry guard-deterministic (./run.mts) runs, in fixed order. Split from
 * the orchestrator so the gate set reads as data; run.mts owns selection, spawning and aggregation.
 */
const ANTI_SLOP_COMPONENT = 'antiSlop';
// guard-comments' exit 4 blocks, but like unexpected/could-not-run it is not a verdict.
export const UNREADABLE_EVIDENCE = '(unreadable-evidence)';
// Fixed run order; each runs as `node <sibling module> <args>`, so every install mode resolves it.
// Exit contract: 0 clean, 1 violation, 2 fail-open (could-not-run) unless `failOpen2` says otherwise.
export const DETERMINISTIC = [
    { id: 'size', module: '../ratchets/size-disable.mjs', args: ['gate'] },
    { id: 'fanout', module: '../ratchets/folder-fanout.mjs', args: ['gate'] },
    {
        id: 'dup',
        module: '../co-occurrence/matcher.mjs',
        args: ['scan', '--new', '--changed', '--gate'],
    },
    {
        id: 'clone',
        module: '../co-occurrence/clone-detector.mjs',
        args: ['scan', '--changed', '--gate'],
    },
    // `optIn` (never in the missing-config fallback) and fail-closed once selected; its exit 2
    // (NOT MEASURED) is a skip only under `devkit review`.
    {
        id: 'coverage',
        module: '../coverage/run.mjs',
        args: ['gate'],
        optIn: true,
        failOpen2: 'review',
    },
    {
        id: 'anti-slop',
        module: '../../cli/index.mjs',
        args: ['anti-slop', 'check', '--staged'],
        optIn: true,
        configComponent: ANTI_SLOP_COMPONENT,
        failOpen2: false,
    },
    // Judge-free since 2026-09-02, so the comment budget aggregates here (sc-2753).
    {
        id: 'comments',
        module: '../comment-firewall/cli.mjs',
        args: ['gate'],
        optIn: true,
        failOpen2: false,
        rcLabels: { 4: UNREADABLE_EVIDENCE },
    },
];
