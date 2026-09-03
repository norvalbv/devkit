export function parseArgs(argv) {
    const values = new Map();
    const booleans = new Set();
    const links = [];
    const donates = [];
    const paths = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') {
            paths.push(...argv.slice(i + 1));
            break;
        }
        // Every value-less flag MUST be listed here: the `startsWith('--')` fallback below treats an
        // unlisted flag as value-taking and consumes the NEXT argv entry as its value, silently eating a
        // real argument (`--draft --resumed` would swallow `--resumed`).
        if (a === '--no-qavis-publish' ||
            a === '--update-pr-body' ||
            a === '--draft' ||
            a === '--resumed' ||
            a === '--merge-paths')
            booleans.add(a.slice(2));
        else if (a === '--link')
            links.push(argv[++i] ?? '');
        else if (a === '--donate')
            donates.push(argv[++i] ?? '');
        else if (a.startsWith('--'))
            values.set(a.slice(2), argv[++i] ?? '');
    }
    return { values, booleans, links, donates, paths };
}
export function fail(msg) {
    console.error(`ship-intent: ${msg}`);
    return 1;
}
